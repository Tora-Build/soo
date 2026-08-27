// The scoring model, case by case. Every branch of the fold gets a state
// shaped to hit exactly it, so a future re-weighting shows up here as an
// explicit diff and never as a silent drift.
import { describe, expect, it } from "vitest";

import {
  traitsOf,
  buildAdjudicatorRecords,
  scoreAdjudicators,
  scoreRecord,
  RULING_POINTS,
  VETO_POINTS,
  type AdjudicatorRecord,
} from "../src/reputation.js";
import type { MarketResolutionState } from "../src/adapter.js";

const ADJ = "AdjAuthority11111111111111111111111111111111";
const GUARD = "GuardAuthority111111111111111111111111111111";
const NOW = 1_800_000_000;
const DEADLINE = NOW - 10 * 3600; // ten hours ago

let seq = 0;
function state(over: {
  lifecycle?: MarketResolutionState["lifecycle"];
  attestedOutcome?: number | null;
  attestedAt?: number | null;
  disputed?: boolean;
  disputedAt?: number | null;
  forcedInvalid?: boolean;
  isZk?: boolean;
  deadline?: number;
  isDismissed?: boolean;
  authority?: string;
}): MarketResolutionState {
  seq += 1;
  return {
    market: `Mkt${seq}`,
    creator: "Creator111111111111111111111111111111111111",
    adjudicator: over.authority ?? ADJ,
    startTime: BigInt((over.deadline ?? DEADLINE) - 7 * 86400),
    deadline: BigInt(over.deadline ?? DEADLINE),
    lifecycle: over.lifecycle ?? "Settled",
    winningOutcome: 1,
    isDismissed: over.isDismissed ?? false,
    adjudicatorEntry: {
      market: `Mkt${seq}`,
      authority: over.authority ?? ADJ,
      disputeAuthority: GUARD,
      attestedOutcome: over.attestedOutcome === undefined ? 1 : over.attestedOutcome,
      attestedAt:
        over.attestedAt === undefined ? BigInt(DEADLINE + 3600) : over.attestedAt === null ? null : BigInt(over.attestedAt),
      disputed: over.disputed ?? false,
      disputedAt: over.disputedAt != null ? BigInt(over.disputedAt) : null,
      forcedInvalid: over.forcedInvalid ?? false,
      isZk: over.isZk ?? false,
    },
  } as MarketResolutionState;
}

const recordOf = (states: MarketResolutionState[], who = ADJ): AdjudicatorRecord =>
  buildAdjudicatorRecords(states, NOW).get(who)!;

describe("adjudicator reputation fold", () => {
  it("clean settled ruling scores +10 and the prompt bonus when ruled within 6h", () => {
    const r = recordOf([state({ attestedAt: DEADLINE + 3600 })]);
    expect(r.cleanRulings).toBe(1);
    expect(r.totalPoints).toBe(RULING_POINTS.clean + RULING_POINTS.promptBonus);
    expect(r.medianResponseSec).toBe(3600);
  });

  it("a slow clean ruling earns no prompt bonus", () => {
    const r = recordOf([state({ attestedAt: DEADLINE + 48 * 3600 })]);
    expect(r.totalPoints).toBe(RULING_POINTS.clean);
  });

  it("an early (pre-deadline) ruling counts as instant", () => {
    const r = recordOf([state({ attestedAt: DEADLINE - 86400 })]);
    expect(r.totalPoints).toBe(RULING_POINTS.clean + RULING_POINTS.promptBonus);
    expect(r.medianResponseSec).toBe(0);
  });

  it("a vetoed ruling costs -20 and credits the veto to the guardian", () => {
    const states = [state({ lifecycle: "Locked", disputed: true, disputedAt: DEADLINE + 7200 })];
    const adj = recordOf(states);
    expect(adj.overriddenRulings).toBe(1);
    expect(adj.totalPoints).toBe(RULING_POINTS.overridden);
    const guard = recordOf(states, GUARD);
    expect(guard.vetoesIssued).toBe(1);
    // Manual veto: counted, not scored — the guardian IS the last word here.
    expect(guard.totalPoints).toBe(VETO_POINTS.vetoManual);
  });

  it("vetoing a zkTLS-attested outcome costs the guardian -10", () => {
    const states = [state({ lifecycle: "Locked", disputed: true, isZk: true })];
    const guard = recordOf(states, GUARD);
    expect(guard.vetoesOverProof).toBe(1);
    expect(guard.totalPoints).toBe(VETO_POINTS.vetoOverProof);
  });

  it("forced invalid costs -12", () => {
    const r = recordOf([state({ lifecycle: "Locked", forcedInvalid: true, attestedOutcome: 2 })]);
    expect(r.forcedInvalids).toBe(1);
    expect(r.totalPoints).toBe(RULING_POINTS.forcedInvalid);
  });

  it("a market locked unruled for 48h+ marks the adjudicator unresponsive (-5)", () => {
    const r = recordOf([
      state({ lifecycle: "Locked", attestedOutcome: null, attestedAt: null, deadline: NOW - 72 * 3600 }),
    ]);
    expect(r.unresponsive).toBe(1);
    expect(r.totalPoints).toBe(RULING_POINTS.unresponsive);
  });

  it("an attested-but-unsettled ruling is pending: counted, zero points", () => {
    const r = recordOf([state({ lifecycle: "Locked" })]);
    expect(r.pendingRulings).toBe(1);
    expect(r.totalPoints).toBe(0);
  });

  it("dismissed markets and epoch-clock fixtures do not accuse anyone", () => {
    const dismissed = state({ isDismissed: true });
    const epochClock = state({
      lifecycle: "Locked",
      attestedOutcome: null,
      attestedAt: null,
      deadline: 1_000, // LiteSVM-style clock
    });
    const records = buildAdjudicatorRecords([dismissed, epochClock, null], NOW);
    expect(records.get(ADJ)).toBeUndefined();
  });
});

describe("scoring and tiers", () => {
  it("a blank slate scores 50 and is unproven", () => {
    const { score, tier } = scoreRecord(recordOf([state({ lifecycle: "Locked" })]));
    expect(score).toBe(50);
    expect(tier).toBe("unproven");
  });

  it("three clean rulings reach trusted", () => {
    const { score, tier } = scoreRecord(
      recordOf([state({}), state({}), state({})]),
    );
    expect(score).toBe(50 + 3 * 12);
    expect(tier).toBe("trusted");
  });

  it("vetoed rulings drag a busy adjudicator into caution", () => {
    const states = [
      state({}),
      state({ lifecycle: "Locked", disputed: true }),
      state({ lifecycle: "Locked", disputed: true }),
    ];
    const { score, tier } = scoreRecord(recordOf(states));
    expect(score).toBe(Math.max(0, 50 + 12 - 40));
    expect(tier).toBe("caution");
  });

  it("scoreAdjudicators returns both roles from one pass", () => {
    const out = scoreAdjudicators([state({ lifecycle: "Locked", disputed: true, isZk: true })], NOW);
    expect(out.get(ADJ)?.record.overriddenRulings).toBe(1);
    expect(out.get(GUARD)?.record.vetoesOverProof).toBe(1);
  });
});

describe("trait badges", () => {
  it("a fast, spotless, veteran record earns all three", () => {
    const r = recordOf([state({}), state({}), state({}), state({}), state({})]);
    const ids = traitsOf(r).map((t) => t.id);
    expect(ids).toContain("fast");
    expect(ids).toContain("spotless");
    expect(ids).toContain("veteran");
  });

  it("one veto strips SPOTLESS; issuing one grants GUARDIAN", () => {
    const states = [
      state({}), state({}), state({}),
      state({ lifecycle: "Locked", disputed: true }),
    ];
    expect(traitsOf(recordOf(states)).map((t) => t.id)).not.toContain("spotless");
    expect(traitsOf(recordOf(states, GUARD)).map((t) => t.id)).toContain("guardian");
  });

  it("BROAD needs both zk and manual rulings", () => {
    const r = recordOf([state({}), state({ isZk: true })]);
    expect(traitsOf(r).map((t) => t.id)).toContain("broad");
  });
});
