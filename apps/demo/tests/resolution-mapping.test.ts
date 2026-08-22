// The state → action map, pinned.
//
// Every case here corresponds to a `require!` in `sooth_core`. The property
// under test is the one the UI promises: an action is offered ONLY when the
// instruction behind it would land. A regression here puts a button on screen
// that fails on chain with a raw Anchor code.

import { describe, it, expect } from "vitest";
import type { MarketResolutionState } from "@sooth/sdk-solana";
import {
  formatCountdown,
  outcomeLabel,
  resolveMarketView,
  UNNAMED_AUTHORITY,
} from "../src/features/arena/resolution";

const ME = "MyWa11etPubkey11111111111111111111111111111";
const OTHER = "OtherWa11et1111111111111111111111111111111";
const DEADLINE = 1_000_000n;
const VETO = 600;

function market(
  over: Partial<MarketResolutionState> = {},
): MarketResolutionState {
  return {
    market: "Mkt1111111111111111111111111111111111111111",
    creator: ME,
    adjudicator: ME,
    deadline: DEADLINE,
    lifecycle: "Open",
    winningOutcome: 0,
    isDismissed: false,
    adjudicatorEntry: null,
    ...over,
  };
}

function entry(over: Partial<NonNullable<MarketResolutionState["adjudicatorEntry"]>> = {}) {
  return {
    market: "Mkt1111111111111111111111111111111111111111",
    authority: ME,
    disputeAuthority: ME,
    attestedOutcome: null,
    attestedAt: null,
    disputed: false,
    disputedAt: null,
    forcedInvalid: false,
    ...over,
  };
}

const view = (state: MarketResolutionState, nowSec: number, wallet = ME) =>
  resolveMarketView({
    state,
    vetoPeriodSecs: VETO,
    permissionlessAdjudicators: true,
    wallet,
    nowSec,
  });

describe("resolveMarketView", () => {
  it("offers nothing to do on an open market before its deadline", () => {
    const v = view(market({ adjudicatorEntry: entry() }), Number(DEADLINE) - 10);
    expect(v.phase).toBe("open");
    expect(v.action).toBe("none");
  });

  it("offers the lock the instant the deadline arrives, not a second before", () => {
    const m = market({ adjudicatorEntry: entry() });
    // `request_lock` requires `now >= deadline` — the boundary is inclusive.
    expect(view(m, Number(DEADLINE) - 1).action).toBe("none");
    expect(view(m, Number(DEADLINE)).action).toBe("lock");
    expect(view(m, Number(DEADLINE)).phase).toBe("pastDeadline");
  });

  it("offers registration only to the creator, and only while no entry exists", () => {
    const m = market({ lifecycle: "Locked" });
    expect(view(m, 1).action).toBe("register");
    // Not the creator → the program rejects with Unauthorized.
    expect(view(m, 1, OTHER).action).toBe("none");
    // `register_adjudicator` uses `init`; an existing entry cannot be re-made.
    expect(view(market({ lifecycle: "Locked", adjudicatorEntry: entry() }), 1).action)
      .toBe("attest");
  });

  it("withholds registration when permissionless registration is off", () => {
    const v = resolveMarketView({
      state: market({ lifecycle: "Locked" }),
      vetoPeriodSecs: VETO,
      permissionlessAdjudicators: false,
      wallet: ME,
      nowSec: 1,
    });
    expect(v.phase).toBe("awaitingAdjudicator");
    expect(v.action).toBe("none");
  });

  it("offers attest only to the entry's own authority", () => {
    const m = market({ lifecycle: "Locked", adjudicatorEntry: entry() });
    expect(view(m, 1).action).toBe("attest");
    const v = view(m, 1, OTHER);
    expect(v.phase).toBe("attestable");
    expect(v.action).toBe("none");
    expect(v.isAdjudicator).toBe(false);
  });

  it("refuses attest on an orphan-rescue entry that names nobody", () => {
    const m = market({
      lifecycle: "Locked",
      adjudicatorEntry: entry({
        authority: UNNAMED_AUTHORITY,
        disputeAuthority: UNNAMED_AUTHORITY,
      }),
    });
    const v = view(m, 1);
    expect(v.phase).toBe("unattestable");
    expect(v.action).toBe("none");
    expect(v.isOrphaned).toBe(true);
  });

  it("runs the veto window from attested_at + veto_period_secs", () => {
    const m = market({
      lifecycle: "Locked",
      adjudicatorEntry: entry({ attestedOutcome: 1, attestedAt: 5_000n }),
    });
    const mid = view(m, 5_000 + 100);
    expect(mid.phase).toBe("veto");
    expect(mid.action).toBe("none");
    expect(mid.vetoEndsAt).toBe(5_600);
    expect(mid.vetoSecondsLeft).toBe(500);
    expect(mid.vetoElapsed).toBe(false);
    // Settlement unlocks AT the boundary, matching `now >= veto_ends_at`.
    const at = view(m, 5_600);
    expect(at.phase).toBe("settleable");
    expect(at.action).toBe("settle");
    expect(at.vetoSecondsLeft).toBe(0);
  });

  it("does not claim the window elapsed while its length is unknown", () => {
    // A null `veto_period_secs` is "not read yet". Treating it as zero would
    // offer a Settle the program answers with VetoWindowOpen.
    const v = resolveMarketView({
      state: market({
        lifecycle: "Locked",
        adjudicatorEntry: entry({ attestedOutcome: 0, attestedAt: 5_000n }),
      }),
      vetoPeriodSecs: null,
      permissionlessAdjudicators: true,
      wallet: ME,
      nowSec: 9_999_999,
    });
    expect(v.phase).toBe("veto");
    expect(v.action).toBe("none");
    expect(v.vetoEndsAt).toBeNull();
  });

  it("sends a settled market to redemption and a dismissed one nowhere", () => {
    expect(view(market({ lifecycle: "Settled", winningOutcome: 1 }), 1).action)
      .toBe("redeem");
    expect(view(market({ isDismissed: true }), 1).phase).toBe("dismissed");
    expect(view(market({ isDismissed: true }), 1).action).toBe("none");
  });

  it("reports the dispute authority separately from the attesting one", () => {
    const m = market({
      lifecycle: "Locked",
      adjudicatorEntry: entry({
        authority: OTHER,
        disputeAuthority: ME,
        attestedOutcome: 2,
        attestedAt: 5_000n,
      }),
    });
    const v = view(m, 5_100);
    expect(v.isAdjudicator).toBe(false);
    expect(v.isDisputeAuthority).toBe(true);
  });

  it("never offers an action to a disconnected wallet", () => {
    const m = market({ lifecycle: "Locked" });
    expect(view(m, 1, null as unknown as string).action).toBe("none");
  });
});

describe("formatting", () => {
  it("formats a countdown by magnitude and clamps at zero", () => {
    expect(formatCountdown(9)).toBe("09s");
    expect(formatCountdown(125)).toBe("02m 05s");
    expect(formatCountdown(3_725)).toBe("1h 02m 05s");
    expect(formatCountdown(-40)).toBe("00s");
  });

  it("labels outcomes the way the program numbers them", () => {
    expect(outcomeLabel(0)).toBe("NO");
    expect(outcomeLabel(1)).toBe("YES");
    expect(outcomeLabel(2)).toBe("INVALID");
    expect(outcomeLabel(null)).toBe("—");
  });
});
