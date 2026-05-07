// trading-window-e2e — SKIPPED.
//
// Why skipped:
//   The trading-window guard (Wave 6 / Codex C1 finding) lives at
//   `packages/programs-core/programs/sooth_amm/src/instructions/
//   trade_positions.rs` and asserts:
//     require!(now >= market.start_time, MarketNotStarted);
//     require!(now < market.deadline,    MarketDeadlinePassed);
//   Validating BOTH branches against a live ix requires the Clock sysvar
//   to be moved past `deadline` between two trades — exactly the same
//   surface that `08-claim-unlocked` needs to skip on test-validator.
//   There is no `setClock` RPC on solana-test-validator, so we cannot
//   demonstrate the post-deadline rejection without either:
//     - swapping the validator for surfpool (which exposes
//       `surfpool_setClock`), or
//     - shipping a test build with a tiny window via cargo feature flag,
//       which diverges from the canonical .so we deploy in this suite.
//   Demonstrating the open-window branch alone (now < deadline) is
//   already covered by every other UI-driven spec in this suite — those
//   succeed precisely because the seeded market sits well inside its
//   trading window — so a happy-path-only spec here would be redundant.
//
// Coverage already in place:
//   - Cargo unit tests at `packages/programs-core/programs/sooth_amm/
//     src/instructions/trade_positions.rs` + the LiteSVM/Mollusk-style
//     fuzz at `packages/programs-core/tests/trading_window.rs` (Wave 6)
//     cover both halves of the guard with synthetic Clock sysvars.
//   - The C1 introspection check (deadline pre-empt in the UI) is
//     exercised by the demo's own `src/components/features/
//     SimpleTradingPanel.tsx` deadline-guard logic — the
//     `04-wallet-not-connected` spec confirms the panel renders without
//     a live ix when state is invalid; the same pattern shows
//     "Deadline Passed" once `truth?.deadline` is in the past.
//
// What would unblock this on the demo's e2e harness:
//   surfpool's setClock JSON-RPC. Switching the validator binary the
//   e2e relies on would let us drive: connect wallet → confirm trade
//   succeeds inside window → fast-forward Clock past `deadline` → click
//   BUY → assert tx fails with `MarketDeadlinePassed` (custom error
//   code 0x...) AND that the UI surfaces "Deadline Passed" at the
//   button label. Until that switch happens, this spec stays skipped.

import { test } from "@playwright/test";

test.describe("AMM trading-window guard (UI-driven)", () => {
  test.skip("skipped: solana-test-validator has no setClock RPC; cannot warp past Market.deadline to trip the C1 guard at runtime. Cargo tests at programs-core/programs/sooth_amm cover both halves of the guard.", async () => {
    // Intentionally empty — see file header for the unblock plan.
  });
});
