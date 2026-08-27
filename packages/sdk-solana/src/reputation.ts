// Adjudicator reputation, computed — never asserted.
//
// The whole record is a pure fold over `MarketResolutionState`s the client
// already reads, so anyone can recompute any score from public chain state.
// That is the point: a reputation a platform hands down is another thing to
// trust; a reputation derived from verifiable history is not.
//
// ── The scoring model, and why each case scores what it does ──────────────
//
// An authority can touch a market in two roles, and both are scored:
//
// RULINGS (as the attesting authority):
//   clean        +10   Ruled, nobody vetoed, market settled as ruled. The
//                      whole job, done.
//   prompt bonus  +2   The ruling landed within 6h of becoming possible
//                      (early resolutions count as instant). Adjudication
//                      that keeps capital locked for days is worth less.
//   pending        0   Ruled, veto window still running. Not yet evidence.
//   overridden   -20   The guardian veto replaced this ruling. The veto is
//                      this protocol's court of last resort, so being
//                      overridden is the strongest negative signal the chain
//                      records about a ruling. Twice the clean reward:
//                      one bad ruling should not wash out with one good one.
//   forcedInvalid -12  The abandonment hatch fired on their watch. Less
//                      damning than a veto (nobody said the ruling was
//                      WRONG — they said it never came), still a failure.
//   unresponsive  -5   Market locked awaiting their ruling for over 48h.
//                      Scored per market, not per day, so it cannot dwarf
//                      the ruling scores.
//
// VETOES (as the dispute authority):
//   vetoOverProof -10  A veto that overrode a zkTLS-attested outcome. The
//                      proof is cryptographic evidence of what the data
//                      source served; overriding it is either a rescue of a
//                      genuinely broken rule (rare, legitimate) or an abuse
//                      of the guardian key. The score assumes accountability:
//                      guardians who override proofs must spend reputation
//                      to do it.
//   vetoManual     0   A veto on a MANUAL ruling is the guardian doing the
//                      exact job the protocol gives them, and the chain
//                      holds no higher truth to grade it against — the veto
//                      IS the final word on manual markets. It is counted
//                      and displayed (a guardian who vetoes everything looks
//                      exactly as strange as they are) but not scored.
//
// A note on "correct vs wrong" vetoes: on manual markets no on-chain oracle
// outranks the guardian, so correctness is not computable — pretending
// otherwise would be a number wearing a costume. Where ground truth DOES
// exist (zk proofs), vetoes are graded against it. The `DisputeRaised` event
// preserves the pre-veto ruling, so an event-level enrichment can later add
// per-dispute detail without changing this model.
//
// The composite starts at 50 (a stranger, not a villain) and moves with
// evidence; the tier is gated on VOLUME as well as score, so three lucky
// rulings cannot mint a "trusted" badge.

import type { MarketResolutionState } from "./adapter.js";

/** Seconds after a lock during which silence is patience, not neglect. */
const UNRESPONSIVE_AFTER_SEC = 48 * 3600;
/** Rulings landing within this window of the deadline earn the prompt bonus. */
const PROMPT_WINDOW_SEC = 6 * 3600;
/** Epoch-relative test clocks (LiteSVM) must not be judged against wall time. */
const PLAUSIBLE_UNIX_FLOOR = 1_000_000_000;

export const RULING_POINTS = {
  clean: 10,
  promptBonus: 2,
  pending: 0,
  overridden: -20,
  forcedInvalid: -12,
  unresponsive: -5,
} as const;

export const VETO_POINTS = {
  vetoOverProof: -10,
  vetoManual: 0,
} as const;

export type RulingKind =
  | "clean"
  | "pending"
  | "overridden"
  | "forcedInvalid"
  | "unresponsive";

export type VetoKind = "vetoOverProof" | "vetoManual";

export interface AdjudicationCase {
  market: string;
  role: "ruling" | "veto";
  kind: RulingKind | VetoKind;
  points: number;
  /** Prompt bonus applied on top of `points` (rulings only). */
  promptBonus: boolean;
  /** Unix seconds of the case's anchoring moment, when known. */
  at: number | null;
  isZk: boolean;
}

export interface AdjudicatorRecord {
  authority: string;
  cases: AdjudicationCase[];
  /** Rulings that reached a final state (clean / overridden / forcedInvalid). */
  resolvedRulings: number;
  cleanRulings: number;
  overriddenRulings: number;
  forcedInvalids: number;
  unresponsive: number;
  pendingRulings: number;
  vetoesIssued: number;
  vetoesOverProof: number;
  zkRulings: number;
  manualRulings: number;
  /** Median seconds from deadline to ruling across resolved rulings; 0 = early/instant. */
  medianResponseSec: number | null;
  totalPoints: number;
}

export type TrustTier = "unproven" | "caution" | "standing" | "trusted";

export interface AdjudicatorScore {
  /** 0..100. 50 is a blank slate. */
  score: number;
  tier: TrustTier;
  record: AdjudicatorRecord;
}

function emptyRecord(authority: string): AdjudicatorRecord {
  return {
    authority,
    cases: [],
    resolvedRulings: 0,
    cleanRulings: 0,
    overriddenRulings: 0,
    forcedInvalids: 0,
    unresponsive: 0,
    pendingRulings: 0,
    vetoesIssued: 0,
    vetoesOverProof: 0,
    zkRulings: 0,
    manualRulings: 0,
    medianResponseSec: null,
    totalPoints: 0,
  };
}

/**
 * Fold resolution states into per-authority records.
 *
 * `nowSec` is a parameter, never `Date.now()`, so the fold is deterministic
 * and testable. States whose clocks are implausibly small (test fixtures)
 * skip every wall-clock judgement but still count categorical cases.
 */
export function buildAdjudicatorRecords(
  states: Array<MarketResolutionState | null | undefined>,
  nowSec: number,
): Map<string, AdjudicatorRecord> {
  const records = new Map<string, AdjudicatorRecord>();
  const get = (authority: string): AdjudicatorRecord => {
    let r = records.get(authority);
    if (!r) {
      r = emptyRecord(authority);
      records.set(authority, r);
    }
    return r;
  };
  const responseSamples = new Map<string, number[]>();

  for (const st of states) {
    if (!st?.adjudicatorEntry) continue;
    if (st.isDismissed) continue;
    const entry = st.adjudicatorEntry;
    const authority = entry.authority;
    const deadline = Number(st.deadline);
    const clockPlausible = deadline > PLAUSIBLE_UNIX_FLOOR;
    const attestedAt = entry.attestedAt !== null ? Number(entry.attestedAt) : null;
    const attested = entry.attestedOutcome !== null && attestedAt !== null;

    // ── The ruling, from the attesting authority's side ──────────────────
    if (authority && authority !== "11111111111111111111111111111111") {
      // `get` is called inside pushRuling, not up front: a market that
      // produces no case must not mint an empty record for its adjudicator.
      const pushRuling = (kind: RulingKind, at: number | null) => {
        const rec = get(authority);
        let points: number = RULING_POINTS[kind];
        let promptBonus = false;
        if (kind === "clean" && clockPlausible && at !== null) {
          const lag = Math.max(0, at - deadline);
          if (lag <= PROMPT_WINDOW_SEC) {
            points += RULING_POINTS.promptBonus;
            promptBonus = true;
          }
          (responseSamples.get(authority) ?? responseSamples.set(authority, []).get(authority)!).push(lag);
        }
        rec.cases.push({
          market: st.market,
          role: "ruling",
          kind,
          points,
          promptBonus,
          at,
          isZk: entry.isZk,
        });
        rec.totalPoints += points;
        if (entry.isZk) rec.zkRulings += 1;
        else rec.manualRulings += 1;
      };

      if (entry.forcedInvalid) {
        const rec = get(authority);
        rec.forcedInvalids += 1;
        rec.resolvedRulings += 1;
        pushRuling("forcedInvalid", attestedAt);
      } else if (entry.disputed) {
        const rec = get(authority);
        rec.overriddenRulings += 1;
        rec.resolvedRulings += 1;
        pushRuling("overridden", entry.disputedAt !== null ? Number(entry.disputedAt) : null);
      } else if (attested && st.lifecycle === "Settled") {
        const rec = get(authority);
        rec.cleanRulings += 1;
        rec.resolvedRulings += 1;
        pushRuling("clean", attestedAt);
      } else if (attested) {
        const rec = get(authority);
        rec.pendingRulings += 1;
        pushRuling("pending", attestedAt);
      } else if (
        st.lifecycle === "Locked" &&
        clockPlausible &&
        nowSec - deadline > UNRESPONSIVE_AFTER_SEC
      ) {
        const rec = get(authority);
        rec.unresponsive += 1;
        pushRuling("unresponsive", null);
      }
    }

    // ── The veto, from the dispute authority's side ──────────────────────
    if (
      entry.disputed &&
      entry.disputeAuthority &&
      entry.disputeAuthority !== "11111111111111111111111111111111"
    ) {
      const rec = get(entry.disputeAuthority);
      const kind: VetoKind = entry.isZk ? "vetoOverProof" : "vetoManual";
      const points = VETO_POINTS[kind];
      rec.cases.push({
        market: st.market,
        role: "veto",
        kind,
        points,
        promptBonus: false,
        at: entry.disputedAt !== null ? Number(entry.disputedAt) : null,
        isZk: entry.isZk,
      });
      rec.totalPoints += points;
      rec.vetoesIssued += 1;
      if (kind === "vetoOverProof") rec.vetoesOverProof += 1;
    }
  }

  for (const [authority, samples] of responseSamples) {
    const rec = records.get(authority);
    if (!rec || samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    rec.medianResponseSec = sorted[Math.floor(sorted.length / 2)];
  }
  return records;
}

/**
 * Compress a record to a 0..100 score and a tier.
 *
 * 50 is the blank slate; evidence moves it. The tier needs volume as well as
 * score — `unproven` is not an insult, it is the honest label for a clean
 * record that is three markets long.
 */
export function scoreRecord(record: AdjudicatorRecord): AdjudicatorScore {
  const score = Math.max(0, Math.min(100, 50 + record.totalPoints));
  let tier: TrustTier;
  if (record.resolvedRulings < 3) tier = "unproven";
  else if (score >= 75) tier = "trusted";
  else if (score >= 45) tier = "standing";
  else tier = "caution";
  return { score, tier, record };
}

/** One-call convenience: states in, per-authority scores out. */
export function scoreAdjudicators(
  states: Array<MarketResolutionState | null | undefined>,
  nowSec: number,
): Map<string, AdjudicatorScore> {
  const out = new Map<string, AdjudicatorScore>();
  for (const [authority, record] of buildAdjudicatorRecords(states, nowSec)) {
    out.set(authority, scoreRecord(record));
  }
  return out;
}

// ── Trait badges — the record's shape, not just its size ──────────────────
//
// A single score collapses qualities a creator may weigh differently: one
// adjudicator is fast, another has never been overturned, a third has run
// every kind of market. Traits surface those axes; each is as recomputable
// as the score itself.

export interface AdjudicatorTrait {
  id: "fast" | "spotless" | "veteran" | "broad" | "guardian";
  label: string;
  detail: string;
}

export function traitsOf(record: AdjudicatorRecord): AdjudicatorTrait[] {
  const traits: AdjudicatorTrait[] = [];
  if (
    record.medianResponseSec !== null &&
    record.medianResponseSec <= PROMPT_WINDOW_SEC &&
    record.resolvedRulings >= 2
  ) {
    traits.push({
      id: "fast",
      label: "FAST",
      detail: "Rules within hours of a market locking, not days",
    });
  }
  if (
    record.resolvedRulings >= 3 &&
    record.overriddenRulings === 0 &&
    record.forcedInvalids === 0
  ) {
    traits.push({
      id: "spotless",
      label: "SPOTLESS",
      detail: "No ruling ever vetoed or abandoned",
    });
  }
  if (record.resolvedRulings >= 5) {
    traits.push({
      id: "veteran",
      label: "VETERAN",
      detail: "Five or more markets resolved",
    });
  }
  if (record.zkRulings >= 1 && record.manualRulings >= 1) {
    traits.push({
      id: "broad",
      label: "BROAD",
      detail: "Has resolved both automatic and manual markets",
    });
  }
  if (record.vetoesIssued >= 1) {
    traits.push({
      id: "guardian",
      label: "GUARDIAN",
      detail: "Has exercised the dispute veto",
    });
  }
  return traits;
}
