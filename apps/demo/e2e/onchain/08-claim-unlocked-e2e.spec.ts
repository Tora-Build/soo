// claim-unlocked-e2e — SKIPPED.
//
// Why skipped:
//   The on-chain LOCK_DURATION_SECS (sooth_amm) is 86_400 (24 hours). To
//   exercise the claim path the validator's clock must advance past
//   `LockEntry.unlock_at`. solana-test-validator does NOT expose any
//   programmatic clock-warping RPC — there is no `setClock` /
//   `warpToSlot` / `setSysvar(Clock)` hook on the bundled validator. The
//   only ways to satisfy the gate against test-validator are:
//     1. wait 24h of real wall-clock time, or
//     2. patch the program's LOCK_DURATION_SECS to a tiny value via a
//        feature-flagged build, redeploy, and rerun. Neither is appropriate
//        for an automated UI e2e against the canonical .so binary.
//
// What would unblock this on the demo's e2e harness:
//   - surfpool / Test-validator-with-rpc-extensions: surfpool ships a
//     `surfpool_setClock` JSON-RPC method (see
//     https://github.com/txtx/surfpool#sysvar-overrides) that mutates the
//     active Clock sysvar. Switching the e2e validator to surfpool would
//     enable: airdrop SOL → buy → sell → fast-forward Clock to
//     `unlock_at + 1` → claim → assert the funds moved out of lock_vault.
//   - cargo-build-sbf with a feature flag (e.g. `--features e2e_short_lock`
//     overriding LOCK_DURATION_SECS = 5) and a separate "e2e" target/
//     deploy step. Adds CI complexity and divergence risk vs. the prod .so.
//
// Coverage already in place:
//   The claim-flow round-trip (sell → wait → claim, including unlock_at
//   gating, double-claim rejection, and zeroed LockEntry close) is
//   exercised in `packages/sdk-solana/tests/claim-flow.test.ts` against
//   solana-bankrun, which DOES expose a `Clock` sysvar override via
//   `BanksClient.warpToSlot` and direct `setAccount` on the Clock sysvar.
//   The test asserts:
//     - claim before unlock_at → InstructionError (CustomError: NotYetUnlocked)
//     - claim after unlock_at → user_usdc_ata += LockEntry.amount_usdc,
//       lock_vault -= same, LockEntry account closed (lamports → 0).
//   That spec covers the program-level invariants; the only thing this
//   e2e adds would be the UI dispatcher path (chain-shim
//   `dispatchClaim` → `adapter.buildClaim` → `sooth_amm::claim_unlocked`),
//   which the SDK adapter unit tests at
//   `packages/sdk-solana/tests/adapter-claim.test.ts` already cover by
//   matching the exact ix shape against the IDL.

import { test } from "@playwright/test";

test.describe("AMM claim_unlocked (UI-driven)", () => {
  test.skip("skipped: solana-test-validator has no setClock RPC; LOCK_DURATION_SECS=86_400 prevents real-time validation. Coverage lives at packages/sdk-solana/tests/claim-flow.test.ts (bankrun warpToSlot).", async () => {
    // Intentionally empty — see the file header for the long-form
    // rationale and the unblock plan (surfpool setClock OR
    // feature-flagged short-lock build).
  });
});
