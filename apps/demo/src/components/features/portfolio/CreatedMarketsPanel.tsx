// "Markets you created" — the founder's resolution console, in the Locker.
//
// A market's creator is the only person who can carry it through the back
// half of its lifecycle, and until this panel existed there was no screen
// that let them. It is deliberately not a dashboard: one row per market, one
// button, and the button is COMPUTED from chain state rather than picked from
// a menu — `features/arena/resolution.ts` maps (lifecycle, deadline,
// adjudicator entry, veto clock) to the single instruction that would land
// right now. Anything that would fail on chain renders as a sentence
// explaining why, not a disabled control with no reason attached.
//
// Discovery: there is no creator index on chain. The candidate list is the
// registry-less discovery the deck uses (`marketRegistry`), filtered by
// `Market.creator === connected wallet`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { ArrowRight, Hammer } from "lucide-react";
import { useAccount, useWriteContract } from "@/lib/chain-shim";
import { Card } from "../../ui/Card";
import { lookupMarketQuestion } from "../../../lib/market-questions";
import { parseSQFSafe } from "../../../lib/sqf";
import { shortenAddress } from "../../../utils/format";
import { cn } from "../../../lib/utils";
import {
  formatCountdown,
  outcomeLabel,
  resolveMarketView,
  type ResolutionView,
} from "../../../features/arena/resolution";
import {
  addResolutionExtraRefs,
  refreshResolutionStates,
  useResolutionStates,
} from "../../../features/arena/useResolutionStates";
import { discoverCreatedMarkets } from "../../../features/arena/createdMarkets";
import { useNowSec, VetoWindowBadge } from "../market/VetoWindow";

type Busy = null | "lock" | "register" | "settle" | "attest";

const PHASE_LABEL: Record<string, string> = {
  initializing: "NOT ACTIVATED",
  dismissed: "DISMISSED",
  open: "OPEN",
  pastDeadline: "PAST DEADLINE",
  awaitingAdjudicator: "NO ADJUDICATOR",
  unattestable: "ORPHANED",
  attestable: "LOCKED",
  veto: "ATTESTED",
  settleable: "VETO ELAPSED",
  settled: "SETTLED",
};

/** The question out of an SQF envelope, whatever shape it arrived in. */
function questionFromSqf(raw: string): string {
  const parsed = parseSQFSafe(raw).question?.trim();
  if (parsed) return parsed;
  const inline = raw.match(/§question\s+([^§]+)/i)?.[1]?.trim();
  if (inline) return inline;
  return raw.replace(/§[a-z]+/gi, " ").replace(/\s+/g, " ").trim() || raw;
}

const formatDate = (unixSec: number, locale: string) =>
  unixSec > 0
    ? new Date(unixSec * 1000).toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export function CreatedMarketsPanel() {
  const { t, i18n } = useTranslation();
  const { isConnected, address } = useAccount();
  const { byMarket, vetoPeriodSecs, permissionlessAdjudicators, hasLoaded } =
    useResolutionStates();
  const nowSec = useNowSec(isConnected);

  const wallet = address ? String(address).replace(/^0x/, "") : null;

  // The registry is a build-time snapshot filtered to the current collateral
  // mint — right for trading, wrong for this console: a founder's older
  // markets still need resolving. Ask the chain who they created.
  useEffect(() => {
    if (!wallet) return;
    void discoverCreatedMarkets(wallet).then((refs) => {
      if (refs.length) addResolutionExtraRefs(refs);
    });
  }, [wallet]);

  const rows = useMemo(() => {
    if (!wallet) return [];
    return Object.values(byMarket)
      .filter((state) => state.creator === wallet)
      .map((state) => ({
        state,
        view: resolveMarketView({
          state,
          vetoPeriodSecs,
          permissionlessAdjudicators,
          wallet,
          nowSec,
        }),
      }))
      .sort((a, b) => Number(a.state.deadline) - Number(b.state.deadline));
  }, [byMarket, wallet, vetoPeriodSecs, permissionlessAdjudicators, nowSec]);

  if (!isConnected) return null;

  return (
    <Card className="bg-raised border border-rule p-6">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="text-base font-semibold text-ink flex items-center gap-2">
          <Hammer className="w-4 h-4 text-accent" />
          {t("createdMarkets.title", { defaultValue: "Markets You Created" })}
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
          {hasLoaded
            ? `${rows.length} ${t("portfolio.markets")}`
            : t("common.loading")}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="border border-rule bg-inset p-6 text-center space-y-3">
          <p className="text-sm text-muted">
            {hasLoaded
              ? t("createdMarkets.empty", {
                  defaultValue:
                    "No markets from this wallet yet. Markets are discovered without an index, so only ones this build knows about can appear here.",
                })
              : t("createdMarkets.loading", {
                  defaultValue: "Scanning known markets…",
                })}
          </p>
          <Link
            to="/forge"
            className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-accent hover:underline"
          >
            {t("createdMarkets.forgeCta", { defaultValue: "Forge a market" })}
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      ) : (
        <div className="space-y-2" data-testid="created-markets-list">
          {rows.map(({ state, view }) => (
            <CreatedMarketRow
              key={state.market}
              market={state.market}
              view={view}
              isZk={state.adjudicatorEntry?.isZk ?? false}
              hasEntry={state.adjudicatorEntry !== null}
              locale={i18n.language === "zh" ? "zh-CN" : "en-US"}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function CreatedMarketRow({
  market,
  view,
  isZk,
  hasEntry,
  locale,
}: {
  market: string;
  view: ResolutionView;
  isZk: boolean;
  hasEntry: boolean;
  locale: string;
}) {
  const { t } = useTranslation();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<Busy>(null);
  // The remembered string is the raw SQF the create flow submitted; the row
  // wants the question out of it, not the whole envelope. `parseSQF` is
  // line-based, and some create flows emitted the tags inline on one line —
  // so fall back to stripping the markers rather than printing them.
  const raw = lookupMarketQuestion(market);
  const question = raw ? questionFromSqf(raw) : shortenAddress(market, 6);

  const run = useCallback(
    async (kind: Busy, fn: () => Promise<unknown>, done: string) => {
      setBusy(kind);
      const tid = toast.loading(t("common.loading"));
      try {
        await fn();
        toast.success(done, { id: tid });
        await refreshResolutionStates();
      } catch (e) {
        toast.error((e as Error).message?.slice(0, 140) ?? "Failed", {
          id: tid,
        });
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const lock = () =>
    run(
      "lock",
      () =>
        writeContractAsync({
          functionName: "requestLock",
          args: [`sol:${market}`],
        }),
      t("createdMarkets.locked", { defaultValue: "Market locked" }),
    );

  const register = () =>
    run(
      "register",
      () =>
        writeContractAsync({
          functionName: "registerAdjudicator",
          args: [`sol:${market}`],
        }),
      t("createdMarkets.registered", {
        defaultValue: "You are now the adjudicator",
      }),
    );

  const settle = () =>
    run(
      "settle",
      () =>
        writeContractAsync({
          functionName: "settle",
          args: [`sol:${market}`],
        }),
      t("createdMarkets.settled", { defaultValue: "Market settled" }),
    );

  const attest = (outcome: 0 | 1 | 2) =>
    run(
      "attest",
      () =>
        writeContractAsync({
          functionName: "attestOutcome",
          args: [`sol:${market}`, outcome],
        }),
      t("createdMarkets.attested", {
        defaultValue: "Outcome attested — the dispute window has started",
      }),
    );

  return (
    <div
      className="border border-rule bg-inset p-3"
      data-testid="created-market-row"
      data-market={market}
      data-phase={view.phase}
      data-action={view.action}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.12em]",
                view.phase === "veto" || view.phase === "pastDeadline"
                  ? "text-amber-400"
                  : view.phase === "settleable"
                    ? "text-accent"
                    : "text-muted",
              )}
            >
              {PHASE_LABEL[view.phase] ?? view.phase}
            </span>
            {/* Which kind of market this is. An automatic market's resolver
                settles it from the committed zkTLS rule — but the creator
                still holds the entry authority, so the manual attest path
                below stays open either way. Without this badge a founder had
                no way to tell whether anything was watching their market. */}
            {hasEntry && (
              <span
                className={cn(
                  "font-mono text-[10px] uppercase tracking-[0.12em] px-1.5 py-0.5 border",
                  isZk ? "border-accent/50 text-accent" : "border-rule text-muted",
                )}
                title={
                  isZk
                    ? "Automatic — a zkTLS rule is committed and the resolver can settle this market; you can still attest manually after the deadline."
                    : "Manual — you attest the outcome yourself after the deadline."
                }
              >
                {isZk ? "AUTO · zkTLS" : "MANUAL"}
              </span>
            )}
            <span className="font-mono text-[10px] text-faint">
              {shortenAddress(market, 4)}
            </span>
            {/* Same countdown as the deck and /explore, so the row a founder
                acts from and the row a trader sees carry one clock. */}
            <VetoWindowBadge address={market} />
          </div>
          <p className="text-sm text-ink leading-snug line-clamp-2 mt-1">
            {question}
          </p>
          <p className="text-[11px] text-muted mt-1">
            <RowExplainer view={view} locale={locale} />
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          {view.action === "lock" && (
            <ActionButton busy={busy === "lock"} onClick={lock}>
              {t("createdMarkets.lockIt", { defaultValue: "Lock it" })}
            </ActionButton>
          )}
          {view.action === "register" && (
            <ActionButton busy={busy === "register"} onClick={register}>
              {t("createdMarkets.becomeAdjudicator", {
                defaultValue: "Become the adjudicator",
              })}
            </ActionButton>
          )}
          {view.action === "settle" && (
            <ActionButton busy={busy === "settle"} onClick={settle}>
              {t("createdMarkets.settle", { defaultValue: "Settle" })}
            </ActionButton>
          )}
          {view.action === "redeem" && (
            <Link
              to={`/locker?market=${market}`}
              className="btn btn-secondary px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.12em]"
            >
              {t("createdMarkets.redeem", { defaultValue: "Redeem" })}
            </Link>
          )}
          {view.action === "attest" && (
            <div className="flex items-center gap-1">
              {([1, 0, 2] as const).map((outcome) => (
                <button
                  key={outcome}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => attest(outcome)}
                  className="btn btn-secondary px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-[0.12em] disabled:opacity-50"
                  data-testid={`created-market-attest-${outcomeLabel(outcome).toLowerCase()}`}
                >
                  {outcomeLabel(outcome)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  busy,
  onClick,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="btn btn-primary px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.12em] disabled:opacity-50"
    >
      {busy ? "…" : children}
    </button>
  );
}

/** One sentence naming the gate — what holds now, and what comes next. */
function RowExplainer({
  view,
  locale,
}: {
  view: ResolutionView;
  locale: string;
}) {
  const { t } = useTranslation();
  const outcome = outcomeLabel(view.attestedOutcome);

  switch (view.phase) {
    case "open":
      return (
        <>
          {view.action === "register"
            ? t("createdMarkets.openNoAdjudicator", {
                defaultValue:
                  "Trading until {{date}}. No adjudicator is registered yet — naming one now is the only step you can take early.",
                date: formatDate(view.deadline, locale),
              })
            : t("createdMarkets.openUntil", {
                defaultValue: "Trading until {{date}} — nothing to do yet.",
                date: formatDate(view.deadline, locale),
              })}
        </>
      );
    case "pastDeadline":
      return (
        <>
          {t("createdMarkets.pastDeadline", {
            defaultValue:
              "Deadline passed {{date}}. Locking is permissionless now and is the step before resolving.",
            date: formatDate(view.deadline, locale),
          })}
        </>
      );
    case "awaitingAdjudicator":
      return (
        <>
          {view.action === "register"
            ? t("createdMarkets.mayRegister", {
                defaultValue:
                  "No adjudicator registered. As creator you may name yourself and then attest the outcome.",
              })
            : t("createdMarkets.cannotRegister", {
                defaultValue:
                  "No adjudicator registered, and this wallet may not register one — permissionless registration is off on this deployment.",
              })}
        </>
      );
    case "attestable":
      return (
        <>
          {view.isAdjudicator
            ? t("createdMarkets.mayAttest", {
                defaultValue:
                  "Locked and awaiting an outcome. You hold the attesting key — pick YES, NO or INVALID.",
              })
            : t("createdMarkets.notAdjudicator", {
                defaultValue:
                  "Locked and awaiting the registered adjudicator, which is not this wallet. Nothing to do here.",
              })}
        </>
      );
    case "unattestable":
      return (
        <>
          {t("createdMarkets.orphaned", {
            defaultValue:
              "The adjudicator entry names no key, so nobody may attest. It resolves INVALID through the abandonment hatch.",
          })}
        </>
      );
    case "veto":
      return (
        <>
          {t("createdMarkets.inVeto", {
            defaultValue:
              "{{outcome}} attested. Dispute window open — {{time}} until anyone may settle.",
            outcome,
            time:
              view.vetoSecondsLeft === null
                ? "—"
                : formatCountdown(view.vetoSecondsLeft),
          })}
          {view.isDisputeAuthority && (
            <>
              {" "}
              {t("createdMarkets.holdsDispute", {
                defaultValue:
                  "You hold the dispute veto for this market; disputing is a CLI-only call in this build.",
              })}
            </>
          )}
          {view.disputed && (
            <>
              {" "}
              {t("createdMarkets.disputed", {
                defaultValue: "This outcome has been disputed.",
              })}
            </>
          )}
        </>
      );
    case "settleable":
      return (
        <>
          {t("createdMarkets.settleable", {
            defaultValue:
              "{{outcome}} attested and the dispute window has closed. Settlement is permissionless — anyone can crank it.",
            outcome,
          })}
        </>
      );
    case "settled":
      return (
        <>
          {t("createdMarkets.settledLine", {
            defaultValue: "Settled {{outcome}} — holders can redeem.",
            outcome: outcomeLabel(view.attestedOutcome),
          })}
        </>
      );
    case "dismissed":
      return (
        <>
          {t("createdMarkets.dismissedLine", {
            defaultValue: "Dismissed — deposits refund at cost.",
          })}
        </>
      );
    default:
      return (
        <>
          {t("createdMarkets.initializing", {
            defaultValue: "Not activated yet — no curve has been funded.",
          })}
        </>
      );
  }
}
