// The resolution lifecycle, as one pure function per question.
//
// Every gate here mirrors a `require!` in the program, because the rule for
// this UI is that no button appears unless the instruction behind it would
// actually land:
//
//   request_lock       Open, `now >= deadline`, not dismissed.  Permissionless.
//   register_adjudicator  entry ABSENT (`init`), signer == Market.creator when
//                      `permissionless_adjudicators`. No lifecycle gate.
//   attest_outcome     Locked, signer == entry.authority, entry named,
//                      not already attested (a forced INVALID may be attested
//                      over).
//   settle             attested, `now >= attested_at + veto_period_secs`,
//                      not dismissed.  Permissionless.
//
// `veto_period_secs` is read from `ProtocolConfig` — it is deployment config
// (600s on devnet at time of writing), never a constant in this file.

import type { MarketResolutionState } from "@sooth/sdk-solana";

/** `Pubkey::default()` — the sentinel an orphan-rescue entry names. */
export const UNNAMED_AUTHORITY = "11111111111111111111111111111111";

export type ResolutionPhase =
  | "initializing"
  | "dismissed"
  | "open"
  | "pastDeadline"
  | "awaitingAdjudicator"
  | "unattestable"
  | "attestable"
  | "veto"
  | "settleable"
  | "settled";

/** The ONE thing the connected wallet may do right now, or `none`. */
export type ResolutionAction =
  | "none"
  | "lock"
  | "register"
  | "attest"
  | "settle"
  | "redeem";

export interface ResolutionView {
  phase: ResolutionPhase;
  /** Computed against the connected wallet — `none` when it may do nothing. */
  action: ResolutionAction;
  /** Outcome recorded on the entry: 0 NO, 1 YES, 2 INVALID, null unattested. */
  attestedOutcome: number | null;
  /** Unix seconds settlement unlocks; null unless attested. */
  vetoEndsAt: number | null;
  /** Seconds left in the veto window, floored at 0; null unless attested. */
  vetoSecondsLeft: number | null;
  /** True once an attestation exists and its window has run out. */
  vetoElapsed: boolean;
  /** Written by `force_invalid_attestation`, not by an adjudicator. */
  forcedInvalid: boolean;
  disputed: boolean;
  /** Connected wallet holds `dispute_authority` for this market. */
  isDisputeAuthority: boolean;
  /** Connected wallet is the registered attesting authority. */
  isAdjudicator: boolean;
  /** Nobody may attest — the entry names no authority (orphan rescue). */
  isOrphaned: boolean;
  /** Unix seconds. */
  deadline: number;
}

export function outcomeLabel(outcome: number | null): string {
  if (outcome === 1) return "YES";
  if (outcome === 0) return "NO";
  if (outcome === 2) return "INVALID";
  return "—";
}

/** `1h 02m 09s` / `02m 09s` / `09s`. Clamped at zero. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m > 0) return `${pad(m)}m ${pad(sec)}s`;
  return `${pad(sec)}s`;
}

export interface ResolutionInput {
  state: MarketResolutionState;
  /** From `ProtocolConfig.veto_period_secs`. Null = not read yet. */
  vetoPeriodSecs: number | null;
  /** From `ProtocolConfig.permissionless_adjudicators`. */
  permissionlessAdjudicators: boolean;
  /** Connected wallet, base58. Null when disconnected. */
  wallet: string | null;
  /** Unix seconds. */
  nowSec: number;
}

export function resolveMarketView({
  state,
  vetoPeriodSecs,
  permissionlessAdjudicators,
  wallet,
  nowSec,
}: ResolutionInput): ResolutionView {
  const entry = state.adjudicatorEntry;
  const attestedOutcome = entry?.attestedOutcome ?? null;
  const attestedAt = entry?.attestedAt ?? null;
  const isAttested = attestedOutcome !== null && attestedAt !== null;

  // An unknown window length must NOT read as "already elapsed" — that would
  // offer a Settle button the program rejects with `VetoWindowOpen`.
  const vetoEndsAt =
    isAttested && vetoPeriodSecs !== null
      ? Number(attestedAt) + vetoPeriodSecs
      : null;
  const vetoSecondsLeft =
    vetoEndsAt === null ? null : Math.max(0, vetoEndsAt - nowSec);
  const vetoElapsed = vetoEndsAt !== null && nowSec >= vetoEndsAt;

  const isOrphaned = !!entry && entry.authority === UNNAMED_AUTHORITY;
  const isAdjudicator =
    !!wallet && !!entry && entry.authority === wallet && !isOrphaned;
  const isDisputeAuthority =
    !!wallet &&
    !!entry &&
    entry.disputeAuthority === wallet &&
    entry.disputeAuthority !== UNNAMED_AUTHORITY;
  const isCreator = !!wallet && state.creator === wallet;
  const deadline = Number(state.deadline);

  const base = {
    attestedOutcome,
    vetoEndsAt,
    vetoSecondsLeft,
    vetoElapsed,
    forcedInvalid: entry?.forcedInvalid ?? false,
    disputed: entry?.disputed ?? false,
    isDisputeAuthority,
    isAdjudicator,
    isOrphaned,
    deadline,
  };

  if (state.lifecycle === "Settled") {
    return { ...base, phase: "settled", action: "redeem" };
  }
  if (state.isDismissed) {
    return { ...base, phase: "dismissed", action: "none" };
  }
  if (state.lifecycle === "Initializing") {
    return { ...base, phase: "initializing", action: "none" };
  }

  if (isAttested) {
    // Attested but not Settled — the dispute window, then the crank.
    if (vetoElapsed) {
      return { ...base, phase: "settleable", action: "settle" };
    }
    return { ...base, phase: "veto", action: "none" };
  }

  if (state.lifecycle === "Locked") {
    if (!entry) {
      // `register_adjudicator` uses `init`, so this is the only phase where
      // registering can succeed at all.
      const mayRegister = permissionlessAdjudicators && isCreator;
      return {
        ...base,
        phase: "awaitingAdjudicator",
        action: mayRegister ? "register" : "none",
      };
    }
    if (isOrphaned) {
      // The rescue named nobody; `require_named_authority` refuses everyone.
      return { ...base, phase: "unattestable", action: "none" };
    }
    return {
      ...base,
      phase: "attestable",
      action: isAdjudicator ? "attest" : "none",
    };
  }

  // Open.
  if (nowSec >= deadline) {
    return { ...base, phase: "pastDeadline", action: "lock" };
  }
  // Before the deadline the creator's only lever is registering an
  // adjudicator ahead of time, which `register_adjudicator` permits.
  const mayRegisterEarly =
    !entry && permissionlessAdjudicators && isCreator;
  return {
    ...base,
    phase: "open",
    action: mayRegisterEarly ? "register" : "none",
  };
}
