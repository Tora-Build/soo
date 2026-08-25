// Market creation, Solana-shaped: one screen, two signatures — three when the
// market resolves itself.
//
// The form collects the four things the program actually takes — question,
// category, close date, liquidity — and submits create_market followed by
// seed_lp. The creator is registered as the market's adjudicator by the
// chain-shim (`dispatchCreateMarket` passes the connected wallet).
//
// On top of that sits ONE choice: who closes the market. Manual keeps the
// creator as the signing adjudicator. Automatic adds a third instruction,
// `register_zk_adjudicator`, binding the market to Primus' attestor and a
// hash of `(url, parsePath)` — after which anyone can close it by submitting
// a signed reading of that endpoint, and the creator keeps only the dispute
// veto. That instruction is PERMISSIONED, so the option is gated on a read of
// `ProtocolConfig` rather than offered and then failed (see
// `useZkAdjudicatorPolicy`).
//
// The category rides on-chain inside the question string as an SQF `§category`
// section; `useOnChainMarkets` parses it back out and the Arena deck derives
// its world art from it.

import { useState } from "react";
import {
  useAccount,
  useDemo,
  useReadContract,
  useWriteContract,
} from "@/lib/chain-shim";
import { parseUnits, formatUnits, Address } from "@/lib/chain-shim";
import {
  Rocket,
  Check,
  DollarSign,
  Loader2,
  Activity,
  Bitcoin,
  Trophy,
  Theater,
  Zap,
  CloudSun,
  Landmark,
  Cpu,
  CalendarDays,
} from "lucide-react";
import { toast } from "react-hot-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ABIS, ERC20_ABI } from "../config/abis";
import { generateSQF } from "../lib/sqf";
import { useDeployments } from "../hooks/useDeployments";
import { cn } from "../lib/utils";
import { tokenSymbols } from "../lib/config";
import { useTranslation } from "react-i18next";
import { LaunchpadHeader } from "../components/features/launchpad/LaunchpadHeader";
import {
  ResolutionPicker,
  type ResolutionMode,
} from "../components/features/launchpad/ResolutionPicker";
import {
  PRIMUS_ATTESTOR_EVM,
  comparatorCode,
  initialZkDraft,
  toFixedPoint,
  zkDraftError,
  type ZkRuleDraft,
} from "../components/features/launchpad/zk-rule";
import {
  keypairSigner,
  useZkAdjudicatorPolicy,
} from "../components/features/launchpad/useZkAdjudicatorPolicy";
import {
  RuleDrafter,
  RuleProver,
} from "../components/features/launchpad/RuleAssistant";
import { AdvancedSection } from "../components/features/launchpad/AdvancedSection";
import {
  proofCoversDraft,
  registerWithResolver,
  type ProvenRule,
} from "../components/features/launchpad/rule-services";
import { computeRuleHash } from "@sooth/sdk-solana";
import { CATEGORY_IDS } from "../lib/categories";

const NO_EXPIRY_DEADLINE = 7258118399;
// 1000 wei (1e-15 WAD) headroom for LMSR floor rounding in the program's
// deposit calculation.
const MIN_BWEI_NUDGE = 1000n;
// Markets seed at 50/50, so the LMSR deposit is b·ln(2).
const LN2 = Math.log(2);

// Liquidity presets: b (LMSR depth) with the deposit each one costs.
const LIQUIDITY_PRESETS = [
  { b: 100, label: "Micro" },
  { b: 1000, label: "Small" },
  { b: 10000, label: "Medium" },
] as const;

// Icon + i18n key per category. Order follows CATEGORY_IDS (minus "all").
const CATEGORY_ICONS: Record<string, typeof Trophy> = {
  sports: Trophy,
  tech: Cpu,
  cultures: Theater,
  crypto: Bitcoin,
  politics: Landmark,
  weather: CloudSun,
  others: Zap,
};

const MARKET_CATEGORIES = CATEGORY_IDS.filter((id) => id !== "all").map(
  (id) => ({
    id,
    nameKey: `launchpad.categories.${id}`,
    icon: CATEGORY_ICONS[id] ?? Zap,
  }),
);

export const Launchpad = () => {
  const { t } = useTranslation();
  const { address: userAddress } = useAccount();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deployments = useDeployments();
  const { writeContractAsync } = useWriteContract();
  const demo = useDemo();

  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState("others");
  const [expirationMode, setExpirationMode] = useState("7d");
  const [customExpiration, setCustomExpiration] = useState("");
  const [liquidityB, setLiquidityB] = useState<number>(1000);
  const [deployPending, setDeployPending] = useState(false);
  const [resolutionMode, setResolutionMode] = useState<ResolutionMode>("zk");
  const [zkDraft, setZkDraft] = useState<ZkRuleDraft>(initialZkDraft);
  // A real Primus attestation of the rule currently in the fields, or null.
  // Advisory: it never blocks creation, it only decides whether the screen
  // says this rule is known to work or known to be untested.
  const [provenRule, setProvenRule] = useState<ProvenRule | null>(null);
  const zkPolicy = useZkAdjudicatorPolicy();

  // The zk option can go away under the user's feet — a disconnect, or a
  // config read that lands after the first render. Never submit a zk market
  // the deployment would reject.
  const effectiveMode: ResolutionMode =
    resolutionMode === "zk" && zkPolicy.reason === "ok" ? "zk" : "manual";

  const launchpadEngineAddress = deployments?.contracts[
    "LaunchpadEngine"
  ] as Address;
  const usdcAddress = (deployments?.contracts["AmmToken"] ??
    deployments?.contracts["MockUSDC"]) as Address;

  const { data: usdcDecimals } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "decimals",
    query: { enabled: !!usdcAddress },
  });
  const { data: usdcBalanceData } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [userAddress as Address],
    query: { enabled: !!usdcAddress && !!userAddress },
  });
  const usdcBalance = usdcBalanceData as bigint | undefined;
  const formattedBalance =
    usdcBalance !== undefined && usdcDecimals !== undefined
      ? parseFloat(formatUnits(usdcBalance, usdcDecimals as number))
      : 0;

  const depositAmount = liquidityB * LN2;
  // b in WAD, nudged up so the on-chain deposit clears the program's minimum
  // after fixed-point rounding.
  const bWei = parseUnits(String(liquidityB), 18) + MIN_BWEI_NUDGE;

  const getDeadline = () => {
    if (expirationMode === "open") return NO_EXPIRY_DEADLINE;
    const now = Math.floor(Date.now() / 1000);
    if (expirationMode === "7d") return now + 7 * 86400;
    if (expirationMode === "30d") return now + 30 * 86400;
    if (expirationMode === "custom" && customExpiration) {
      const ts = Math.floor(Date.parse(customExpiration) / 1000);
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
    return now + 7 * 86400;
  };

  // `rule_hash` is immutable, so an unproven rule is a permanent bet that
  // Primus can read an endpoint nobody has asked it to read. Creation still
  // goes through — the founder may know better than the tool — but the screen
  // says which of the two it is, right next to the button that commits it.
  const ruleProven =
    effectiveMode === "zk" &&
    proofCoversDraft(provenRule, zkDraft.url, zkDraft.parsePath);
  const showUnprovenNotice = effectiveMode === "zk" && !ruleProven;

  const validateForm = () => {
    if (!userAddress) {
      toast.error("Please connect your wallet first");
      return false;
    }
    if (!question.trim() || question.length < 10) {
      toast.error("Question must be at least 10 characters");
      return false;
    }
    const deadline = getDeadline();
    const now = Math.floor(Date.now() / 1000);
    if (deadline !== NO_EXPIRY_DEADLINE && deadline <= now + 30) {
      toast.error("Deadline must be later than the market start time");
      return false;
    }
    if (effectiveMode === "zk") {
      const zkErr = zkDraftError(zkDraft);
      if (zkErr) {
        toast.error(t(`launchpad.zk.errors.${zkErr}`));
        return false;
      }
    }
    return true;
  };

  const handleCreateMarket = async () => {
    if (!validateForm()) return;
    setDeployPending(true);
    const toastId = toast.loading("Creating market...");

    try {
      const deadline = getDeadline();
      const startTime = BigInt(Math.floor(Date.now() / 1000) + 30);
      // Markets seed at 50/50 — 0.5 in WAD.
      const initialProbabilityWad = 5n * 10n ** 17n;
      // The on-chain question carries the category as an SQF section; the
      // deck and market lists parse it back out for grouping and art.
      const sqfQuestion = generateSQF({
        question,
        rule: {},
        category,
      });

      // The chain-shim's dispatchCreateMarket reads [question, startTime,
      // deadline, adjudicator, bWad, probabilityWad, config], builds the
      // Solana create_market, and registers the connected wallet as both
      // creator and adjudicator.
      await writeContractAsync({
        abi: ABIS.LaunchpadEngine,
        address: launchpadEngineAddress,
        functionName: "createMarket",
        args: [
          sqfQuestion,
          startTime,
          BigInt(deadline),
          userAddress as Address,
          bWei,
          initialProbabilityWad,
          // The resolution mode rides the config slot: "zk" tells the bridge
          // NOT to bundle register_adjudicator — the zk registration that
          // follows must find the entry absent (`init`). Manual markets get
          // their entry in the same transaction as creation.
          effectiveMode,
        ],
      });

      // The bridge stashes the new market PDA on a global side channel —
      // Solana has no event logs to decode the address from.
      const g = globalThis as unknown as { __lastCreatedMarketPda?: string };
      const pda = g.__lastCreatedMarketPda;
      if (!pda) {
        throw new Error(
          "Solana createMarket: market PDA missing from side channel",
        );
      }
      delete g.__lastCreatedMarketPda;
      const marketAddress = pda as Address;

      // Second signature: fund the curve. Without seed_lp the market LOOKS
      // alive but cannot trade — trade_positions mints LP to every buyer and
      // only seed_lp creates that mint.
      if (demo?.adapter && demo.signer && demo.userRef) {
        toast.loading("Seeding liquidity...", { id: toastId });
        const seedReq = await demo.adapter.buildSeedLp(`sol:${pda}`, {
          creator: demo.userRef,
        });
        await demo.adapter.submit(seedReq, demo.signer as never);
      }

      // Third signature, Automatic only: bind the market to Primus' attestor
      // and the hash of (url, parsePath). Runs AFTER seed_lp, because a market
      // that cannot trade is worse than one that cannot self-resolve — if this
      // step fails the market is still a working manual market, and the toast
      // says so rather than pretending the whole launch failed.
      let zkRegistered = effectiveMode !== "zk";
      if (effectiveMode === "zk" && demo?.adapter) {
        toast.loading(t("launchpad.zk.registering"), { id: toastId });
        const url = zkDraft.url.trim();
        const parsePath = zkDraft.parsePath.trim();
        const ruleHash = await computeRuleHash(url, parsePath);
        const threshold = toFixedPoint(
          zkDraft.threshold.trim(),
          zkDraft.valueScale,
        );
        // The signer is whoever HOLDS the permission — the connected wallet on
        // a permissionless deployment or an authority wallet, otherwise the
        // dev authority keypair. `authority` is the creator either way: that
        // field is the dispute veto, not the right to attest.
        const signer = zkPolicy.devAuthority
          ? keypairSigner(zkPolicy.devAuthority)
          : (demo.signer as never);
        const signerPk = zkPolicy.devAuthority
          ? zkPolicy.devAuthority.publicKey.toBase58()
          : String(demo.userRef ?? "").replace(/^sol:/, "");

        const zkReq = await demo.adapter.buildRegisterZkAdjudicator(
          `sol:${pda}`,
          {
            user: `sol:${signerPk}`,
            authority: demo.userRef as string,
            attestorEvm: PRIMUS_ATTESTOR_EVM,
            ruleHash,
            comparator: comparatorCode(zkDraft.comparator),
            threshold,
            valueScale: zkDraft.valueScale,
          },
        );
        // Scoped catch, and deliberately non-fatal. By this point the market
        // exists and trades; failing the whole launch here would report a
        // market that is live as one that was never created, and leave the
        // creator with no address to go to. The toast says which half worked.
        try {
          await demo.adapter.submit(zkReq, signer as never);
          zkRegistered = true;
          // Hand the resolver the rule's preimage so the market is WATCHED
          // from birth. The chain holds only the hash; this browser is the
          // one place the plaintext exists right now. Fire-and-report: a
          // failure leaves a market that still resolves at its deadline
          // once registered by hand, so it must not fail the launch.
          void registerWithResolver(
            marketAddress.replace(/^0x/, ""),
            zkDraft.url.trim(),
            zkDraft.parsePath.trim(),
          ).then((r) => {
            if (r.ok) {
              toast.success(t("launchpad.zk.watching", {
                defaultValue: "Resolver is watching this market — it settles itself the moment the rule is met.",
              }), { duration: 6000 });
            } else {
              toast(t("launchpad.zk.notWatching", {
                defaultValue: "Resolver not notified ({{detail}}) — the market still resolves at its deadline.",
                detail: r.detail ?? "unreachable",
              }), { icon: "⚠️", duration: 8000 });
            }
          });
        } catch (e) {
          console.warn("[launchpad] register_zk_adjudicator failed", e);
        }
      }

      const marketMetaKey = `market_meta_${marketAddress.toLowerCase()}`;
      localStorage.setItem(
        marketMetaKey,
        JSON.stringify({
          name: question,
          category,
          resolution: effectiveMode,
          ruleProven,
          created: Date.now(),
          type: "v10_launchpad_unified",
        }),
      );

      // Invalidate market list queries so /markets and the deck see the new
      // market immediately instead of waiting for the next refetch tick.
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return (
            Array.isArray(k) &&
            (k[1] === "onChainMarkets" || k[1] === "onChainMarketCount")
          );
        },
      });

      toast.success(
        zkRegistered
          ? "Market launched!"
          : t("launchpad.zk.registerFailed"),
        { id: toastId },
      );
      navigate(`/amm/${marketAddress}`);
    } catch (e: unknown) {
      const error = e as {
        shortMessage?: string;
        message: string;
        code?: string;
      };
      const msg =
        error.code === "ACTION_REJECTED"
          ? "Transaction rejected"
          : error.shortMessage || error.message || "Market creation failed";
      toast.error(msg, { id: toastId });
    } finally {
      setDeployPending(false);
    }
  };

  const isFormValid = question.length >= 10;

  return (
    <div className="relative max-w-2xl mx-auto px-4 pb-32">
      <LaunchpadHeader />

      <div className="mt-6 p-6 border border-rule bg-raised">
        <div className="space-y-4">
          <div className="space-y-3">
            <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
              {t("launchpad.questionLabel")}
            </label>
            <input
              data-testid="launchpad-question-input"
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Will Bitcoin exceed $100k by 2026?"
              className="input-field px-4 py-3"
            />
            <p className="text-sm text-faint leading-relaxed">
              {t("launchpad.questionHint")}
            </p>

            {effectiveMode === "zk" && (
              <RuleDrafter
                question={question}
                onQuestionChange={setQuestion}
                draft={zkDraft}
                onDraftChange={setZkDraft}
                onCategoryChange={setCategory}
                onDeadlineChange={(isoDate) => {
                  // A date the creator wrote in the question is a date they
                  // meant; the expiration picker switches to it rather than
                  // leaving the default 7d quietly contradicting the wording.
                  setExpirationMode("custom");
                  setCustomExpiration(`${isoDate}T23:59`);
                }}
              />
            )}
          </div>

          <div className="space-y-3">
            <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
              {t("launchpad.expirationLabel")}
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[
                { id: "7d", label: t("launchpad.periodLabels.7d"), icon: null },
                {
                  id: "30d",
                  label: t("launchpad.periodLabels.30d"),
                  icon: null,
                },
                { id: "custom", label: null, icon: CalendarDays },
                { id: "open", label: "∞", icon: null },
              ].map((mode) => (
                <button
                  key={mode.id}
                  data-testid={`launchpad-expiration-${mode.id}`}
                  onClick={() => setExpirationMode(mode.id)}
                  className={cn(
                    "py-2 text-sm font-bold border border-transparent transition-all flex items-center justify-center",
                    expirationMode === mode.id
                      ? "bg-accent-muted text-accent"
                      : "bg-inset text-muted hover:bg-raised",
                  )}
                >
                  {mode.icon ? <mode.icon className="w-4 h-4" /> : mode.label}
                </button>
              ))}
            </div>
            {expirationMode === "custom" && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="font-mono text-xs uppercase tracking-[0.12em] text-faint">
                    {t("launchpad.dateLabel")}
                  </label>
                  <input
                    type="date"
                    className="input-field px-3 py-2.5 text-sm bg-canvas"
                    value={customExpiration?.split("T")[0] || ""}
                    onChange={(e) => {
                      const time = customExpiration?.split("T")[1] || "23:59";
                      setCustomExpiration(`${e.target.value}T${time}`);
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-mono text-xs uppercase tracking-[0.12em] text-faint">
                    {t("launchpad.timeLabel")}
                  </label>
                  <input
                    type="time"
                    className="input-field px-3 py-2.5 text-sm bg-canvas"
                    value={customExpiration?.split("T")[1] || "23:59"}
                    onChange={(e) => {
                      const date = customExpiration?.split("T")[0] || "";
                      setCustomExpiration(`${date}T${e.target.value}`);
                    }}
                  />
                </div>
              </div>
            )}
            {expirationMode === "open" && (
              <p className="text-sm text-accent flex items-center gap-1">
                <Activity className="w-3 h-3" />
                {t("launchpad.openUntilResolved")}
              </p>
            )}
            {effectiveMode === "zk" && expirationMode !== "open" && (
              <p className="text-sm text-faint leading-relaxed">
                {t("launchpad.resolvesEarly")}
              </p>
            )}
          </div>

          {effectiveMode === "zk" && (
            <RuleProver
              draft={zkDraft}
              proven={provenRule}
              onProven={setProvenRule}
            />
          )}

          <div className="h-px bg-rule" />

          <div className="space-y-3">
            <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
              {t("launchpad.liquidityLabel")}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {LIQUIDITY_PRESETS.map((preset) => (
                <button
                  key={preset.b}
                  data-testid={`launchpad-liquidity-${preset.b}`}
                  onClick={() => setLiquidityB(preset.b)}
                  className={cn(
                    "p-3 border border-transparent transition-all flex flex-col items-center gap-1",
                    liquidityB === preset.b
                      ? "bg-accent-muted text-accent"
                      : "bg-inset text-muted hover:bg-raised",
                  )}
                >
                  <span className="text-sm font-bold">{preset.label}</span>
                  <span className="font-mono text-base font-bold tabular-nums">
                    ${Math.round(preset.b * LN2).toLocaleString()}
                  </span>
                  <span className="text-xs">
                    {t("launchpad.youDeposit", { symbol: tokenSymbols.amm })}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-sm text-faint leading-relaxed">
              {t("launchpad.lmsrDesc")}
            </p>
          </div>

          <AdvancedSection
            label={t("launchpad.advancedLabel")}
            summary={t("launchpad.advancedSummary", {
              category: t(`launchpad.categories.${category}`, {
                defaultValue: category,
              }),
            })}
          >
              <div className="space-y-3">
                <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                  {t("launchpad.categoryLabel")}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {MARKET_CATEGORIES.map((cat) => {
                    const IconComponent = cat.icon;
                    return (
                      <button
                        key={cat.id}
                        data-testid={`launchpad-category-${cat.id}`}
                        onClick={() => setCategory(cat.id)}
                        className={cn(
                          "p-3 font-semibold border border-transparent transition-all flex items-center gap-2",
                          category === cat.id
                            ? "bg-accent-muted text-accent"
                            : "bg-inset text-muted hover:bg-raised",
                        )}
                      >
                        <IconComponent className="w-5 h-5" />
                        <span className="text-sm">{t(cat.nameKey)}</span>
                        {category === cat.id && <Check className="w-4 h-4 ml-auto" />}
                      </button>
                    );
                  })}
                </div>
              </div>

            <ResolutionPicker
              mode={effectiveMode}
              onModeChange={setResolutionMode}
              draft={zkDraft}
              onDraftChange={setZkDraft}
              policy={zkPolicy}
            />
          </AdvancedSection>

          <div className="pt-4 space-y-3">
            {!isFormValid ? (
              <button
                disabled
                className={cn(
                  "w-full py-4 text-lg font-black transition-all",
                  "bg-raised/60 border border-rule",
                  "text-muted cursor-not-allowed",
                  "flex items-center justify-center gap-2",
                )}
              >
                {t("launchpad.completeFormToContinue")}
              </button>
            ) : (
              <button
                data-testid="launchpad-launch-button"
                onClick={handleCreateMarket}
                disabled={deployPending}
                className={cn(
                  "w-full py-4 text-lg font-black transition-all",
                  "bg-accent",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                  "text-canvas flex items-center justify-center gap-2",
                )}
              >
                {deployPending ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {t("launchpad.launching")}
                  </>
                ) : (
                  <>
                    <Rocket className="w-5 h-5" />
                    {t("launchpad.launchMarket")} — $
                    {Math.round(depositAmount).toLocaleString()}
                  </>
                )}
              </button>
            )}

            {showUnprovenNotice && (
              <p
                data-testid="launchpad-unproven-notice"
                className="text-xs text-warn text-center leading-relaxed"
              >
                {t("launchpad.zk.assist.unprovenAtLaunch")}
              </p>
            )}

            <div className="flex items-center justify-between px-1">
              <span className="text-xs text-muted font-mono">
                {t("launchpad.walletUsdc")}
                {formattedBalance.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{" "}
                {tokenSymbols.amm}
              </span>
              <a
                href="/faucet"
                className="text-xs text-muted hover:text-accent transition-colors inline-flex items-center gap-1"
              >
                <DollarSign className="w-3 h-3" />
                {t("launchpad.needTestUsdc")}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
