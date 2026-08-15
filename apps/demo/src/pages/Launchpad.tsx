import { useState, useEffect } from "react";
import {
  useAccount,
  useChainId,
  useConfig,
  useDemo,
  useReadContract,
  useWriteContract,
} from "@/lib/chain-shim";
import { waitForTransactionReceipt } from "@/lib/chain-shim/wagmi-actions-shim";
import {
  parseUnits,
  formatUnits,
  Address,
  decodeEventLog,
  encodeAbiParameters,
  zeroHash,
  maxUint256,
} from "@/lib/chain-shim";
import {
  Rocket,
  Scale,
  DollarSign,
  Activity,
  Check,
  Coins,
  BookOpen,
  Loader2,
  ExternalLink,
  Bitcoin,
  Trophy,
  Theater,
  Zap,
  CloudSun,
  Landmark,
  Cpu,
  Sparkles,
  CalendarDays,
} from "lucide-react";
import { toast } from "react-hot-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ABIS, ERC20_ABI } from "../config/abis";
import { generateSQF } from "../lib/sqf";
import {
  ADJUDICATOR_REGISTRY,
  getAdjudicatorAddress,
} from "../config/registries";
import { useDeployments } from "../hooks/useDeployments";
import { cn } from "../lib/utils";
import { tokenSymbols } from "../lib/config";
import { useTranslation } from "react-i18next";

import { LaunchpadHeader } from "../components/features/launchpad/LaunchpadHeader";
// AddressSelector replaced by inline adjudicator cards
import { PnLSimulator } from "../components/features/launchpad/PnLSimulator";
import { RiskDisclosure } from "../components/features/launchpad/RiskDisclosure";
// PolymarketExplorer removed — replaced by ZK Oracle Book + ZK Rule Book
import {
  OracleExplorer,
  OracleSelectData,
} from "../components/features/launchpad/OracleExplorer";
import { Drawer } from "../components/ui/Drawer";
import { CATEGORY_IDS } from "../lib/categories";

const NO_EXPIRY_DEADLINE = 7258118399;
// 1000 wei (1e-15 WAD) headroom for LMSRMath floor rounding error in the contract's depositWad calculation.
// Empirical bound across p ∈ [0.01, 0.99]; adjust if LMSRMath changes.
const MIN_BWEI_NUDGE = 1000n;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function normalizeExpirationInputForForm(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const compactDateMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactDateMatch) {
    return `${compactDateMatch[1]}-${compactDateMatch[2]}-${compactDateMatch[3]}T23:59`;
  }

  const localDateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (localDateMatch) {
    return `${localDateMatch[1]}T23:59`;
  }

  const localDateTimeMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/,
  );
  if (localDateTimeMatch) {
    return `${localDateTimeMatch[1]}T${localDateTimeMatch[2]}:${localDateTimeMatch[3]}`;
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isFinite(parsedMs)) {
    return formatLocalDateTimeInput(new Date(parsedMs));
  }

  return trimmed;
}

function parseExpirationInputToTimestamp(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const localDateTimeMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (localDateTimeMatch) {
    const [, year, month, day, hour, minute, second = "00"] =
      localDateTimeMatch;
    return Math.floor(
      new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ).getTime() / 1000,
    );
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isFinite(parsedMs)) {
    return Math.floor(parsedMs / 1000);
  }

  return null;
}

const deriveOracleEndTimeFallback = (
  question: string,
  params: Record<string, unknown> | undefined,
): string | null => {
  const p = params ?? {};
  const direct =
    (typeof p.gameDate === "string" ? p.gameDate : null) ||
    (typeof p.date === "string" ? p.date : null) ||
    (Array.isArray(p.dates) && typeof p.dates[0] === "string"
      ? p.dates[0]
      : null) ||
    (typeof p.dateTo === "string" ? p.dateTo : null);
  if (direct && direct.trim()) return direct.trim();

  const q = String(question || "").trim();
  if (!q) return null;

  if (
    /\b(no\s*expiry|no\s*expiration|open\s*ended|indefinite|infinite)\b/i.test(
      q,
    )
  ) {
    return "No expiry";
  }

  const ymdMatch = q.match(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
  if (ymdMatch) {
    const y = ymdMatch[1];
    const m = String(Number(ymdMatch[2])).padStart(2, "0");
    const d = String(Number(ymdMatch[3])).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const compactMatch = q.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  const yearEndMatch = q.match(/\bend\s+of\s+(20\d{2})\b/i);
  if (yearEndMatch) {
    return `${yearEndMatch[1]}-12-31`;
  }

  const quarterMatch = q.match(/\bq([1-4])\s*(20\d{2})\b/i);
  if (quarterMatch) {
    const quarter = Number(quarterMatch[1]);
    const year = Number(quarterMatch[2]);
    const monthEnd = [3, 6, 9, 12][quarter - 1];
    const dayEnd = new Date(year, monthEnd, 0).getDate();
    return `${year}-${String(monthEnd).padStart(2, "0")}-${String(dayEnd).padStart(2, "0")}`;
  }

  return null;
};

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
  const config = useConfig();
  // useChainId is reactive on chain switch; config.state.chainId is read
  // at access time and won't subscribe React effects to chain changes.
  const chainId = useChainId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deployments = useDeployments();
  const { writeContractAsync } = useWriteContract();
  // Solana fork detection: if a DemoProvider is mounted with a real adapter,
  // we're on the Solana chain-shim and the receipt-decoding path below
  // should bypass the EVM event-log loop in favour of the bridge's
  // out-of-band market-PDA channel.
  const demo = useDemo();
  const isSolanaFork = !!demo?.adapter;

  const [question, setQuestion] = useState("");
  const [form, setForm] = useState({
    category: "others",
    expirationMode: "7d",
    customExpiration: "",
    initialLiquidity: "693",
    // Opening YES price the bonding curve is seeded to (1–99, default 50).
    // Converted to WAD at submit time: BigInt(initialProbability) * 10^16.
    initialProbability: 50,
    deployPending: false,
    event: "",
  });

  const [adjudicatorMode, setAdjudicatorMode] = useState<"registry" | "custom">(
    "registry",
  );
  const [selectedAdjudicatorId, setSelectedAdjudicatorId] =
    useState("zk-oracle");
  const [customAdjudicator, setCustomAdjudicator] = useState<string>("");

  // Guardian is protocol-level (automatic) - no state needed

  const [mobileTab, setMobileTab] = useState<"create" | "learn">("create");
  const [showOracle, setShowOracle] = useState(false);
  const [showZkRule, setShowZkRule] = useState(false);
  const [oracleConfig, setOracleConfig] = useState<{
    adapter: string;
    params: Record<string, unknown>;
    comparison: string;
    threshold: string;
    rule?: string;
    sourceDesc?: string;
  } | null>(null);

  // Listen for postMessage from oracle book iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "oracle-config") {
        const {
          question: q,
          rule,
          sourceDesc,
          adapter,
          params,
          comparison,
          threshold,
          category,
          endTime: rawEndTime,
        } = e.data;
        setQuestion(q);
        setOracleConfig({
          adapter,
          params,
          comparison,
          threshold,
          rule,
          sourceDesc,
        });

        // Map oracle-explorer taxonomy → Sooth's 7 launchpad categories.
        // Every source label must land in one of the 7; anything unmapped
        // falls through to "others".
        const catMap: Record<string, string> = {
          crypto: "crypto",
          defi: "crypto",
          equities: "tech", // public-company market caps → tech bucket
          sports: "sports",
          "pop-culture": "cultures",
          politics: "politics",
          macro: "politics", // CPI / rates / government-driven econ indicators
          economics: "politics",
          weather: "weather",
          science: "tech",
          "public-data": "others",
        };
        const mappedCategory = catMap[category] || "others";

        const endTime =
          typeof rawEndTime === "string" && rawEndTime.trim()
            ? rawEndTime.trim()
            : deriveOracleEndTimeFallback(q, params);

        // Derive expiration from endTime
        let expirationMode = "open";
        let customExpiration = "";
        if (endTime) {
          const normalizedInput = String(endTime).trim();
          const isNoExpiry =
            /^no\s*expiry$/i.test(normalizedInput) ||
            /^open$/i.test(normalizedInput) ||
            /^infinite$/i.test(normalizedInput);

          if (!isNoExpiry) {
            expirationMode = "custom";
            customExpiration = normalizeExpirationInputForForm(normalizedInput);
          }
        }

        setForm((p) => ({
          ...p,
          category: mappedCategory,
          expirationMode,
          customExpiration,
        }));
        setShowOracle(false);
        toast.success(`Imported: ${mappedCategory} • ${q.slice(0, 40)}`, {
          duration: 3000,
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Handler for importing market data from Oracle Explorer
  const handleOracleSelect = (data: OracleSelectData) => {
    setQuestion(data.question);
    setForm((p) => ({
      ...p,
      category: data.category,
      expirationMode: "open",
    }));
    // Store adapter metadata for future adjudicator use
    if (data.oracleAdapter) {
      try {
        const meta = JSON.parse(
          localStorage.getItem(`market_oracle_meta`) || "{}",
        );
        meta[data.question] = {
          adapter: data.oracleAdapter,
          params: data.oracleParams,
          comparison: data.oracleComparison,
          threshold: data.oracleThreshold,
        };
        localStorage.setItem("market_oracle_meta", JSON.stringify(meta));
      } catch {
        /* ignore */
      }
    }
    setShowOracle(false);
    toast.success(`Imported from Oracle: ${data.question.slice(0, 50)}...`, {
      duration: 3000,
    });
  };

  useEffect(() => {
    if (adjudicatorMode === "registry") {
      const selected = ADJUDICATOR_REGISTRY.find(
        (a) => a.id === selectedAdjudicatorId,
      );
      if (selected) {
        // Use chain-aware address — falls back to ManualAdjudicator on chains
        // where the specific adjudicator isn't deployed. Re-fires on chain
        // switch via the `chainId` dep below; without it the field would
        // keep the previous chain's address and createMarket would call a
        // non-contract on the new chain (burns ~30M gas, then reverts).
        const addr = getAdjudicatorAddress(selected.id, chainId);
        setCustomAdjudicator(addr as string);
      }
    } else if (adjudicatorMode === "custom" && userAddress) {
      const isRegistryAddress = ADJUDICATOR_REGISTRY.some(
        (a) => a.address === customAdjudicator,
      );
      if (!customAdjudicator || isRegistryAddress) {
        setCustomAdjudicator(userAddress);
      }
    }
  }, [
    adjudicatorMode,
    selectedAdjudicatorId,
    userAddress,
    customAdjudicator,
    chainId,
  ]);

  // Guardian is now protocol-level - no useEffect needed

  const launchpadEngineAddress = deployments?.contracts[
    "LaunchpadEngine"
  ] as Address;
  // Creating a market posts the LMSR subsidy through `seed_lp`, which takes
  // the AMM venue's token — not USDC. Reading MockUSDC here showed the creator
  // a balance in a token this flow never spends: someone holding plenty of the
  // AMM token but no USDC was told they could not afford a market they could,
  // and the reverse failed on-chain after passing the UI's check. Falls back to
  // MockUSDC so a single-token deployment still works unchanged.
  const usdcAddress = (deployments?.contracts["AmmToken"] ??
    deployments?.contracts["MockUSDC"]) as Address;
  const { data: usdcDecimals } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "decimals",
    query: { enabled: !!usdcAddress },
  });

  const depositAmount = parseFloat(form.initialLiquidity || "0");
  // depositWad = bBase × -ln(min(p, 1-p))  (closed form of LMSRMath.logSumExp
  // at the seeded state, derived from C(qYes=b·logit(p), 0) = b·ln(1/(1-p))
  // for p≥0.5, symmetric for p<0.5). So bBase = deposit / -ln(min(p, 1-p)).
  // At 50/50, min=0.5, multiplier = 1/ln(2) ≈ 1.4427 (original behavior).
  // At p=0.7, min=0.3, multiplier = 1/-ln(0.3) ≈ 0.8305 (SMALLER b for same
  // deposit — high skew consumes capital that would otherwise deepen the AMM).
  const probFraction = Math.max(
    0.01,
    Math.min(0.99, form.initialProbability / 100),
  );
  const depthK = -Math.log(Math.min(probFraction, 1 - probFraction));
  const bFromDeposit = depositAmount / depthK;
  // Don't gate on usdcDecimals — the useReadContract races wallet
  // connect and on slow networks left the Launch button disabled for
  // 30s+ (BS agent run, 2026-04-26). bWei is in WAD regardless of
  // USDC decimals; depositWei needs USDC decimals but defaults to the
  // ubiquitous MockUSDC value (6) when the on-chain read hasn't landed
  // yet. If the actual contract has different decimals, the next
  // wallet round-trip self-corrects.
  const effectiveUsdcDecimals = (usdcDecimals as number | undefined) ?? 6;
  // Ceil bWei so on-chain depositWad clears MIN_DEPOSIT_WAD (10e18) at
  // extreme probabilities after LMSR fixed-point rounding.
  const bWei = parseUnits(bFromDeposit.toFixed(18), 18) + MIN_BWEI_NUDGE;
  const depositWei = parseUnits(
    depositAmount.toString(),
    effectiveUsdcDecimals,
  );

  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [userAddress as Address, launchpadEngineAddress],
    query: { enabled: !!userAddress && !!launchpadEngineAddress },
  });
  const allowance = allowanceData as bigint | undefined;

  const { data: usdcBalanceData } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [userAddress as Address],
    query: { enabled: !!usdcAddress && !!userAddress },
  });
  const usdcBalance = usdcBalanceData as bigint | undefined;
  const formattedBalance =
    usdcBalance && usdcDecimals
      ? parseFloat(formatUnits(usdcBalance, usdcDecimals as number))
      : 0;

  const getDeadline = () => {
    if (form.expirationMode === "open") return NO_EXPIRY_DEADLINE;
    const now = Math.floor(Date.now() / 1000);
    if (form.expirationMode === "7d") return now + 7 * 86400;
    if (form.expirationMode === "30d") return now + 30 * 86400;
    if (form.expirationMode === "custom" && form.customExpiration) {
      const ts = parseExpirationInputToTimestamp(form.customExpiration);
      if (ts && ts > 0) return ts;
    }
    return now + 7 * 86400;
  };

  const getCreateMarketTimingError = () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = now + 30;
    const deadline = getDeadline();

    if (deadline === NO_EXPIRY_DEADLINE) return null;
    if (deadline <= now) {
      return "Deadline must be in the future";
    }
    if (deadline <= startTime) {
      return "Deadline must be later than the market start time";
    }

    return null;
  };

  const validateForm = () => {
    if (!userAddress) {
      toast.error("Please connect your wallet first");
      return false;
    }
    if (!question.trim() || question.length < 10) {
      toast.error("Question must be at least 10 characters");
      return false;
    }
    if (
      !customAdjudicator.startsWith("0x") ||
      customAdjudicator.length !== 42
    ) {
      toast.error("Invalid Adjudicator address");
      return false;
    }
    if (depositAmount < 10) {
      toast.error("Minimum deposit is $10 USDC");
      return false;
    }
    const timingError = getCreateMarketTimingError();
    if (timingError) {
      toast.error(timingError);
      return false;
    }
    return true;
  };

  const handleApproveUsdc = async () => {
    if (!validateForm()) return;
    setForm((p) => ({ ...p, deployPending: true }));

    try {
      const approveHash = await writeContractAsync({
        abi: ERC20_ABI,
        address: usdcAddress,
        functionName: "approve",
        args: [launchpadEngineAddress, maxUint256],
      });
      await waitForTransactionReceipt(config, { hash: approveHash });
      await refetchAllowance();
      toast.success("USDC approved!");
    } catch (e: unknown) {
      const error = e as {
        shortMessage?: string;
        message: string;
        code?: string;
      };
      const msg =
        error.code === "ACTION_REJECTED"
          ? "Transaction rejected"
          : error.shortMessage || "Approval failed";
      toast.error(msg);
    } finally {
      setForm((p) => ({ ...p, deployPending: false }));
    }
  };

  const handleCreateMarket = async () => {
    console.log(
      validateForm(),
      "adj:",
      customAdjudicator,
      "deposit:",
      depositAmount,
      "bWei:",
      bWei?.toString(),
      "question:",
      question?.slice(0, 30),
    );
    if (!validateForm()) return;
    setForm((p) => ({ ...p, deployPending: true }));

    const toastId = toast.loading("Creating market...");

    try {
      const deadline = getDeadline();
      const startTime = BigInt(Math.floor(Date.now() / 1000) + 30);
      // Clamp 1–99 so we never pass an exact 0 or 100 to the LMSR
      // (log(0) in one term of the cost function blows up). Convert
      // the percent to WAD: 50 → 0.5e18.
      const clampedProb = Math.max(
        1,
        Math.min(99, Math.round(form.initialProbability)),
      );
      const initialProbabilityWad = BigInt(clampedProb) * 10n ** 16n;
      const typeConfig = encodeAbiParameters(
        [
          { name: "urlHash", type: "bytes32" },
          { name: "maxAge", type: "uint256" },
        ],
        [zeroHash, 86400n],
      );
      // v0.2.0 AdjudicatorBase.configureMarket decodes 3 fields — no
      // vetoPeriod. Encoding the old 4-field format produces an
      // ABI-decode panic (memory allocation error / Panic(65)) because
      // the excess uint64 gets parsed as the typeConfig length prefix.
      // Source: packages/contracts-core/src/adjudicators/AdjudicatorBase.sol:93
      const adjudicatorConfig = encodeAbiParameters(
        [
          { name: "resolver", type: "address" },
          { name: "deadline", type: "uint64" },
          { name: "typeConfig", type: "bytes" },
        ],
        [userAddress as Address, BigInt(deadline), typeConfig],
      );

      const isMonad = chainId === 10143;
      const isMegaETH = chainId === 6343;
      const isHyperEvm = chainId === 998;
      // HyperEVM block gas limit is 3M — use 2.5M cap.
      // MegaETH createMarket costs ~32M gas — use 40M cap.
      // Monad uses 30M cap.
      const MAX_GAS_CAP = isHyperEvm
        ? 2_500_000n
        : isMegaETH
          ? 40_000_000n
          : 30_000_000n;

      // Build SQF-formatted question string with resolution metadata
      const sqfQuestion = oracleConfig
        ? generateSQF({
            question,
            rule: {
              description:
                oracleConfig.rule ||
                `Resolved via ${oracleConfig.adapter}: value ${oracleConfig.comparison} ${oracleConfig.threshold}`,
              source: oracleConfig.sourceDesc || oracleConfig.adapter,
              adapter: oracleConfig.adapter,
              params: JSON.stringify(oracleConfig.params),
              op: oracleConfig.comparison.toLowerCase(),
              target: oracleConfig.threshold,
            },
            category: form.category,
            event: form.event || undefined,
            meta: undefined,
          })
        : generateSQF({
            question,
            rule: {},
            category: form.category,
            event: form.event || undefined,
            meta: undefined,
          });

      const createHash = await writeContractAsync({
        abi: ABIS.LaunchpadEngine,
        address: launchpadEngineAddress,
        functionName: "createMarket",
        args: [
          sqfQuestion,
          startTime,
          BigInt(deadline),
          customAdjudicator as Address,
          bWei,
          initialProbabilityWad,
          adjudicatorConfig,
        ],
        // For Monad/MegaETH/HyperEVM market creation, 30M is a safe upper
        // bound. createMarket invokes IAdjudicator.configureMarket() and
        // AMMEngine.initializeMarket() — these chains' eth_estimateGas
        // tends to under-provision the call and the tx runs out of gas
        // mid-init. Fixed cap avoids the estimator path entirely.
        ...(isMonad || isMegaETH || isHyperEvm ? { gas: MAX_GAS_CAP } : {}),
      });

      let marketAddress: Address | undefined;

      if (isSolanaFork) {
        // Solana path: the chain-shim's `dispatchCreateMarket` stashes the
        // new market PDA on a global side channel before returning the
        // synthetic Hash. EVM event-log decoding doesn't apply — Solana
        // has no equivalent of `decodeEventLog`. Pull the PDA off the
        // side channel and feed it into the localStorage / navigate path
        // below as the market identifier.
        const pda = (
          globalThis as unknown as { __lastCreatedMarketPda?: string }
        ).__lastCreatedMarketPda;
        if (!pda) {
          throw new Error(
            "Solana createMarket: market PDA missing from side channel",
          );
        }
        marketAddress = pda as Address;
        // Clear the side channel so a follow-up create can't re-use a
        // stale value if the bridge fails before stashing.
        delete (globalThis as unknown as { __lastCreatedMarketPda?: string })
          .__lastCreatedMarketPda;
      } else {
        const receipt = await waitForTransactionReceipt(config, {
          hash: createHash,
        });
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: ABIS.LaunchpadEngine,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === "MarketCreated" && decoded.args) {
              marketAddress = (decoded.args as unknown as { market: Address })
                .market;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!marketAddress) {
          throw new Error("MarketCreated event not found");
        }
      }

      const marketMetaKey = `market_meta_${marketAddress.toLowerCase()}`;
      const metadata = {
        name: question,
        category: form.category,
        created: Date.now(),
        type: "v10_launchpad_unified",
      };
      localStorage.setItem(marketMetaKey, JSON.stringify(metadata));

      // Invalidate market list queries so /markets and other consumers see
      // the new market immediately instead of waiting for the next refetch
      // tick (~15s). Predicate match covers both v10 onChainMarkets and
      // v9 onChainMarketCount across any chainId/launchpad address.
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return (
            Array.isArray(k) &&
            (k[1] === "onChainMarkets" || k[1] === "onChainMarketCount")
          );
        },
      });

      toast.success("Market launched!", { id: toastId });
      await refetchAllowance();
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
          : error.shortMessage || "Market creation failed";
      toast.error(msg, { id: toastId });
    } finally {
      setForm((p) => ({ ...p, deployPending: false }));
    }
  };

  const needsApproval = allowance !== undefined && allowance < depositWei;
  const isFormValid =
    question.length >= 10 && form.initialLiquidity && customAdjudicator;
  const canProceed = isFormValid && !form.deployPending;

  return (
    <div className="relative max-w-6xl mx-auto px-4">
      {/* Background removed - brutalist design */}
      <LaunchpadHeader />

      <div className="lg:hidden flex gap-2 my-6">
        <button
          onClick={() => setMobileTab("create")}
          className={cn(
            "flex-1 py-3 font-bold transition-all flex items-center justify-center gap-2 font-mono text-sm uppercase",
            mobileTab === "create"
              ? "text-accent"
              : "text-muted hover:text-ink",
          )}
        >
          <Rocket className="w-4 h-4" />
          {t("launchpad.create")}
        </button>
        <button
          onClick={() => setMobileTab("learn")}
          className={cn(
            "flex-1 py-3 font-bold transition-all flex items-center justify-center gap-2 font-mono text-sm uppercase",
            mobileTab === "learn" ? "text-accent" : "text-muted hover:text-ink",
          )}
        >
          <BookOpen className="w-4 h-4" />
          {t("launchpad.simulator")}
        </button>
      </div>

      <div className="lg:grid lg:grid-cols-[1fr_420px] lg:gap-4 mt-6">
        <div
          className={cn(
            "lg:block",
            mobileTab === "create" ? "block" : "hidden",
          )}
        >
          <div className="p-6 border border-rule bg-raised">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-accent flex items-center justify-center">
                <Coins className="w-5 h-5 text-ink" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-ink">
                  {t("create.title")}
                </h2>
                <p className="text-xs text-muted">{t("create.subtitle")}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                    {t("launchpad.questionLabel")}
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowOracle(true)}
                      type="button"
                      className="font-mono text-xs uppercase tracking-wider px-2 py-1 bg-raised text-accent hover:border-accent border border-transparent transition-all flex items-center gap-1.5"
                    >
                      <Zap className="w-3 h-3" />
                      ZK Oracle Book
                    </button>
                    <button
                      onClick={() => setShowZkRule(true)}
                      type="button"
                      className="font-mono text-xs uppercase tracking-wider px-2 py-1 bg-raised text-accent hover:border-accent border border-transparent transition-all flex items-center gap-1.5"
                    >
                      <ExternalLink className="w-3 h-3" />
                      ZK Rule Book
                    </button>
                  </div>
                </div>
                <input
                  data-testid="launchpad-question-input"
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Will Bitcoin exceed $100k by 2026?"
                  className="input-field px-4 py-3"
                />
                {oracleConfig && (
                  <div className="p-3 bg-inset space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs uppercase tracking-wider text-faint">
                        On-Chain Question (SQF)
                      </span>
                      <button
                        onClick={() => setOracleConfig(null)}
                        className="font-mono text-xs text-faint hover:text-muted"
                      >
                        ✕
                      </button>
                    </div>
                    <pre className="font-mono text-xs text-muted whitespace-pre-wrap break-all leading-relaxed">
                      {generateSQF({
                        question,
                        rule: {
                          description:
                            oracleConfig.rule ||
                            `Resolved via ${oracleConfig.adapter}: value ${oracleConfig.comparison} ${oracleConfig.threshold}`,
                          source:
                            oracleConfig.sourceDesc || oracleConfig.adapter,
                          adapter: oracleConfig.adapter,
                          params: JSON.stringify(oracleConfig.params),
                          op: oracleConfig.comparison.toLowerCase(),
                          target: oracleConfig.threshold,
                        },
                        category: form.category,
                        event: form.event || undefined,
                        meta: undefined,
                      })}
                    </pre>
                  </div>
                )}
              </div>

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
                        onClick={() =>
                          setForm((p) => ({ ...p, category: cat.id }))
                        }
                        className={cn(
                          "p-3 font-semibold border border-transparent transition-all flex items-center gap-2",
                          form.category === cat.id
                            ? "bg-accent-muted text-accent"
                            : "bg-inset text-muted hover:bg-raised",
                        )}
                      >
                        <IconComponent className="w-5 h-5" />
                        <span className="text-sm">{t(cat.nameKey)}</span>
                        {form.category === cat.id && (
                          <Check className="w-4 h-4 ml-auto" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                  {t("launchpad.eventLabel")}
                </label>
                <input
                  type="text"
                  value={form.event}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      event: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, "-")
                        .replace(/-+/g, "-")
                        .replace(/^-|-$/g, ""),
                    }))
                  }
                  placeholder={t("launchpad.eventPlaceholder")}
                  className="input-field px-3 py-2 text-xs"
                />
                <p className="text-xs text-faint">{t("launchpad.eventHint")}</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                    {t("launchpad.initialProbabilityLabel")}
                  </label>
                  <div className="flex items-baseline gap-2 font-mono tabular-nums">
                    <span className="text-ink font-bold">
                      {form.initialProbability}% YES
                    </span>
                    <span className="text-xs text-faint">
                      / {100 - form.initialProbability}% NO
                    </span>
                  </div>
                </div>
                <input
                  type="range"
                  min={1}
                  max={99}
                  step={1}
                  value={form.initialProbability}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      initialProbability: Number(e.target.value),
                    }))
                  }
                  className="slider"
                />
                <p className="text-xs text-faint leading-relaxed">
                  {t("launchpad.initialProbabilityHint")}
                </p>
              </div>

              <div className="space-y-3">
                <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                  {t("launchpad.expirationLabel")}
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    {
                      id: "7d",
                      label: t("launchpad.periodLabels.7d"),
                      icon: null,
                    },
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
                      onClick={() =>
                        setForm((p) => ({ ...p, expirationMode: mode.id }))
                      }
                      className={cn(
                        "py-2 text-sm font-bold border border-transparent transition-all flex items-center justify-center",
                        form.expirationMode === mode.id
                          ? "bg-accent-muted text-accent"
                          : "bg-inset text-muted hover:bg-raised",
                      )}
                    >
                      {mode.icon ? (
                        <mode.icon className="w-4 h-4" />
                      ) : (
                        mode.label
                      )}
                    </button>
                  ))}
                </div>
                {form.expirationMode === "custom" && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="font-mono text-xs uppercase tracking-[0.12em] text-faint">
                          {t("launchpad.dateLabel")}
                        </label>
                        <input
                          type="date"
                          className="input-field px-3 py-2.5 text-sm bg-canvas"
                          value={form.customExpiration?.split("T")[0] || ""}
                          onChange={(e) => {
                            const time =
                              form.customExpiration?.split("T")[1] || "00:00";
                            setForm((p) => ({
                              ...p,
                              customExpiration: `${e.target.value}T${time}`,
                            }));
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
                          value={
                            form.customExpiration?.split("T")[1] || "00:00"
                          }
                          onChange={(e) => {
                            const date =
                              form.customExpiration?.split("T")[0] || "";
                            setForm((p) => ({
                              ...p,
                              customExpiration: `${date}T${e.target.value}`,
                            }));
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
                {form.expirationMode === "open" && (
                  <p className="text-xs text-accent flex items-center gap-1">
                    <Activity className="w-3 h-3" />
                    {t("launchpad.openUntilResolved")}
                  </p>
                )}
              </div>

              <div className="h-px bg-rule" />

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Scale className="w-4 h-4 text-accent" />
                  <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                    {t("launchpad.adjudicatorLabel")}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {ADJUDICATOR_REGISTRY.map((adj) => (
                    <button
                      key={adj.id}
                      data-testid={`launchpad-adjudicator-${adj.id}`}
                      onClick={() => {
                        setSelectedAdjudicatorId(adj.id);
                        setAdjudicatorMode("registry");
                      }}
                      className={cn(
                        "text-left p-3 border border-transparent transition-all flex flex-col",
                        selectedAdjudicatorId === adj.id &&
                          adjudicatorMode === "registry"
                          ? "bg-accent-muted"
                          : "bg-canvas hover:bg-raised",
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex flex-wrap gap-1">
                          {adj.badgeKeys.map((bKey, i) => (
                            <span
                              key={bKey}
                              className="font-mono text-xs uppercase tracking-wider px-1.5 py-0.5 bg-raised text-accent"
                            >
                              {t(bKey, { defaultValue: adj.badges[i] })}
                            </span>
                          ))}
                          {adj.extraBadgeKey && (
                            <span className="font-mono text-xs uppercase tracking-wider px-1.5 py-0.5 bg-raised text-accent">
                              {t(adj.extraBadgeKey, {
                                defaultValue: adj.extraBadge,
                              })}
                            </span>
                          )}
                        </div>
                        <span className="font-mono text-xs font-bold text-accent shrink-0">
                          {adj.fee}
                        </span>
                      </div>
                      <h4 className="text-sm font-bold text-ink mt-2">
                        {t(adj.nameKey)}
                      </h4>
                      <p className="text-xs text-muted leading-relaxed line-clamp-3 mt-1">
                        {t(adj.descKey)}
                      </p>
                      <div className="pt-1 border-t border-rule/50 mt-auto">
                        <span className="font-mono text-xs uppercase tracking-wider text-faint">
                          {t("launchpad.adjudicator.idealUseCase")}
                        </span>
                        <p className="text-xs text-muted mt-0.5">
                          {t(adj.useCaseKey)}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="h-px bg-rule" />

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                    {t("launchpad.depositLabel")}
                  </label>
                  <span className="text-ink font-mono font-bold tabular-nums">
                    {depositAmount.toLocaleString()} {tokenSymbols.amm}
                  </span>
                </div>
                <input
                  type="range"
                  min="10"
                  max="10000"
                  step="10"
                  value={form.initialLiquidity || "693"}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, initialLiquidity: e.target.value }))
                  }
                  className="slider"
                />

                {depositAmount > 0 && (
                  <div className="p-3 bg-inset space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted">
                        {t("launchpad.liquidityB")}
                      </span>
                      <span className="text-ink font-mono font-bold">
                        {Math.round(bFromDeposit).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted">
                        {t("launchpad.graduationFee")}
                      </span>
                      <span className="text-accent font-mono font-bold">
                        {depositAmount.toLocaleString()} {tokenSymbols.amm}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted">
                        {t("launchpad.graduationVol")}
                      </span>
                      <span className="text-ink font-mono font-bold">
                        {(depositAmount * 20).toLocaleString()} {tokenSymbols.amm}
                      </span>
                    </div>

                    <div className="pt-2 border-t border-subtle flex items-start gap-2 text-xs text-faint leading-relaxed">
                      <Sparkles className="w-3 h-3 text-accent shrink-0 mt-0.5" />
                      <span>
                        <span className="text-ink font-bold">
                          {t("launchpad.lmsrProperty")}
                        </span>{" "}
                        {t("launchpad.lmsrDesc")}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-4 space-y-3">
                {/* Single button - shows validation state, approval, or launch */}
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
                ) : needsApproval ? (
                  <button
                    data-testid="launchpad-approve-button"
                    onClick={handleApproveUsdc}
                    disabled={form.deployPending}
                    className={cn(
                      "w-full py-4 text-lg font-black transition-all",
                      "bg-accent",
                      "",
                      "disabled:opacity-40 disabled:cursor-not-allowed",
                      "text-canvas flex items-center justify-center gap-2",
                    )}
                  >
                    {form.deployPending ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        {t("launchpad.approving")}
                      </>
                    ) : (
                      <>
                        <Rocket className="w-5 h-5" />
                        {t("launchpad.approveUsdc")}
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    data-testid="launchpad-launch-button"
                    onClick={handleCreateMarket}
                    // bWei is now computed unconditionally (using
                    // effectiveUsdcDecimals=6 as the safe default before
                    // the on-chain decimals() call lands). The button only
                    // needs to gate on bWei > 0 (= deposit > 0) and the
                    // form not being mid-submit.
                    disabled={form.deployPending || bWei === 0n}
                    className={cn(
                      "w-full py-4 text-lg font-black transition-all",
                      "bg-accent",
                      "",
                      "disabled:opacity-40 disabled:cursor-not-allowed",
                      "text-canvas flex items-center justify-center gap-2",
                    )}
                  >
                    {form.deployPending ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        {t("launchpad.launching")}
                      </>
                    ) : (
                      <>
                        <Rocket className="w-5 h-5" />
                        {t("launchpad.launchMarket")}
                      </>
                    )}
                  </button>
                )}

                {/* Faucet link */}
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

        <div
          className={cn("lg:block", mobileTab === "learn" ? "block" : "hidden")}
        >
          <div className="space-y-4">
            <PnLSimulator />

            <RiskDisclosure collapsed />
          </div>
        </div>
      </div>

      <Drawer
        isOpen={showOracle}
        onClose={() => setShowOracle(false)}
        className="max-w-5xl"
        hideHeader
      >
        <OracleExplorer onSelectMarket={handleOracleSelect} />
      </Drawer>

      <Drawer
        isOpen={showZkRule}
        onClose={() => setShowZkRule(false)}
        className="max-w-5xl"
        hideHeader
      >
        <div className="h-full flex flex-col">
          <iframe
            src="/zk-rule-book.html"
            className="flex-1 w-full border-0 h-full"
            title="ZK Rule Book"
          />
        </div>
      </Drawer>
    </div>
  );
};
