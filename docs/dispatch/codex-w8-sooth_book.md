# W8 dispatch — E2E + CU/writable-account measurement + ceiling enforcement

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop ONLY after
> all acceptance gates pass AND all commits are made — do not stop
> with a dirty working tree. Print one-line per-gate summary plus
> the measured CU per 3-fill worst-case + the writable-account count
> for the worst-case buy. Do NOT push, tag, --no-verify, amend.

W8 is the validation wave — it doesn't add features. It adds new e2e specs against Surfpool, measures the actual CU + writable-account footprint of the worst-case buy ix, and enforces the **≤ 800k CU per 3-fill tx** ceiling that's been promised since the W4 risk row.

**W8 has a hard dependency on W7 being merged.** The new e2e specs use the W7 SDK builders + matching driver. Don't launch W8 before W7.

Estimated runtime: 30–45 minutes.

---

## Context (read first)

1. **`docs/spec/sooth_book.md`**:
   - §11 W8 row — full acceptance, including the 800k CU ceiling and the writable-account budget cap
   - §13 Q2 — the writable-account budget analysis: ~3 fills per tx regardless of `match_limit` value
   - §12 risks — "match_limit=3 insufficient for realistic depth" + "CU ceiling unknown for worst case" — W8 resolves both
2. **`apps/demo/e2e/`** — existing 19 orderbook specs. W7 already updated them to compile against the new SDK; W8 makes sure they actually pass. Plus W8 adds 5 NEW specs.
3. **`packages/programs-core/programs/sooth_book/src/instructions/buy.rs`** — the buy ix where the 3-fill worst case is measured. W4 wired the matcher; W8 measures its CU.
4. **`_spikes/lmsr-cu/`** — existing CU spike pattern. Mirror its structure if extending.

---

## Scope

### A. Five new e2e specs (`apps/demo/e2e/orderbook-*.spec.ts`)

Per spec §11 W8 acceptance: "new specs for escrow + dust + missing-account-error + per-market fee distribution + per-tick cap".

#### A.1 `orderbook-escrow.spec.ts`

- Maker places an **escrow** order at tick=300, side=YES, amount=10 shares.
- Verify on-chain: `OrderbookPosition.no_shares` decremented by 10 (escrow predebit on opposite side).
- Verify UI: order shows in `/portfolio` as a resting escrow order.
- Taker buys with `tick=700` (crosses against the escrow maker).
- Verify on-chain: `OrderbookPosition.yes_shares` on the maker is unchanged (they were locked in escrow, not paid in USDC); maker's escrow refund credits NO shares; taker's `OrderbookPosition.yes_shares` increases by 10.
- Verify per-market fee pool credited.

#### A.2 `orderbook-dust.spec.ts`

- Taker places buy at tick=999 with amount = `min_resting_order_for_tick(1) - 1` (dust amount).
- Verify the order doesn't rest (no BookSide allocated).
- Verify `DustOrderSkipped` event emitted.
- Verify on-chain: no state change in `MarketBook` or `BookSide`.
- For escrow case: verify the predebit was refunded (NO shares credited back).

#### A.3 `orderbook-missing-account-error.spec.ts`

- SDK builds a buy tx with a deliberately wrong `BookSide` PDA in `remaining_accounts` (e.g. wrong tick).
- Send; expect `MissingCrossingBookSide` returned.
- Verify the error classifier (W7) maps it to the retriable category.
- Verify the SDK's matching-driver retries with fresh bitmap.

#### A.4 `orderbook-per-market-fee.spec.ts`

- Cross a fill on market A; verify market A's `market_fee_pool` balance increases.
- Cross a fill on market B (separate market); verify market B's pool increases independently.
- Crank `distribute_fees(market=A)`; verify only A's pool drained, B untouched.
- Crank `distribute_fees(market=B)`; verify only B's pool drained.
- Acceptance: no cross-contamination of fees between markets.

#### A.5 `orderbook-per-tick-cap.spec.ts`

- 50 makers each place orders at the same (market, side, tick).
- Verify all 50 land successfully.
- 51st maker attempts at the same tick → expect `BookSideFull` rejection.
- Verify error classifier (W7) maps it to a clear user message.

### B. CU + writable-account measurement

New file `packages/programs-core/programs/sooth_book/tests/cu_measurement.rs`:

#### B.1 3-fill worst case

Construct a buy ix that triggers the worst-case path:

- 3 escrow makers at 3 different ticks (forces 3 separate BookSide loads).
- Each fill triggers surplus (taker_tick + maker_tick > NUM_TICKS).
- End-of-ix fee flush.

Use `solana-program-test` or LiteSVM with CU reporting enabled. Print the measured CU.

**Acceptance: ≤ 800k CU per tx.** Test fails hard if exceeded.

#### B.2 Writable-account count

For the same tx, count writable accounts:

- Fixed (signer + program ids + sysvars + market_book + taker_orderbook_position + market_vault + market_fee_pool + taker_usdc_ata + sooth_market program). Per spec §13 Q2 ≈ 10.
- Per-fill (BookSide + maker_orderbook_position + maker_usdc_ata) × 3 = 9.
- Total ≈ 19. Solana cap is 32.

Print the count. Acceptance: total ≤ 32 with at least 4 slots of margin (so future witnesses don't break it).

#### B.3 Single-fill baseline

Measure the same tx with `match_limit=1` (single fill). Provides a delta for the per-fill CU cost; useful for analysis.

### C. Update existing 19 orderbook specs to actually pass

W7 made them compile. W8 makes them green. Likely fixes needed:

- Slippage gate now compares against net proceeds (W2b) — any spec asserting gross-slippage values needs updating.
- The new error codes from the classifier may surface in negative-path specs; update assertions.
- Per-market fee pool means specs that check the **global** `fee_pool_vault` for AMM trades will fail; update them to read `market_fee_pool` for the trade's market.

If a spec is unfixable because it was testing Monaco-era behavior that no longer applies, **mark it skipped with a comment pointing at the W-number that removed the behavior** rather than deleting. Founder review may want to verify the skip is intentional.

### D. SDK error-classifier updates (per spec §11 W8)

If during the e2e runs new errors surface that W7's classifier doesn't catch, add them. Expected new codes: anything from the AMM (`MarketNotOpen`, `PositionInsufficient`) and `sooth_launchpad` (`NothingToDistribute`, `LegacyDrainAlreadyExecuted`) that may bubble through the orderbook flows.

### E. CI gate update

Update `.github/workflows/e2e.yml` (or equivalent) to:

- Run all 19 + 5 = 24 orderbook specs as part of the gate.
- Run `cu_measurement.rs` tests.
- Fail the build if any spec fails or CU > 800k.

The current CI E2E job has been failing since W2a (SDK lag). W8 is when it goes green again.

---

## Acceptance gates

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test -p sooth_book --tests cu_measurement -- --nocapture
NO_DNA=1 cargo test --workspace

cd packages/sdk-solana && NO_DNA=1 pnpm test
cd apps/demo && NO_DNA=1 pnpm typecheck

# E2E full sweep
cd apps/demo && NO_DNA=1 pnpm e2e
```

The CU measurement test prints the measured worst-case CU; assert ≤ 800k. The e2e full sweep is the load-bearing gate — if any of the 24 specs fails, W8 is incomplete.

---

## Out of scope

- Codex review pass + audit-prep notes — W9.
- Devnet redeploy — W9.
- `decision-log.md` updates for W9 — W9.
- `status.md` update — W9.

---

## Operational rules

- Branch: `feat/sooth_book-w8-e2e-cu` off current `main`.
- Suggested commit split:
  1. `test(sooth_book): CU + writable-account measurement (3-fill worst case + single-fill baseline)`
  2. `test(demo-e2e): orderbook escrow spec`
  3. `test(demo-e2e): orderbook dust spec`
  4. `test(demo-e2e): orderbook missing-account-error spec`
  5. `test(demo-e2e): orderbook per-market fee distribution spec`
  6. `test(demo-e2e): orderbook per-tick cap spec`
  7. `chore(demo-e2e): update existing 19 orderbook specs for new architecture`
  8. `feat(sdk-solana): error-classifier additions surfaced by e2e`
  9. `ci: gate orderbook e2e suite + CU ceiling in workflow`
- **Do NOT push, tag, amend, use `--no-verify`.** `NO_DNA=1` prefix.
- **Stop and ask** if:
  - CU measurement exceeds 800k — that's a real protocol-design problem and must surface to founder review, NOT silently committed.
  - A previously-failing e2e spec is unfixable without changing protocol behavior (skip with comment is OK; protocol change is NOT).
  - Surfpool doesn't expose the CU reporting API needed (fall back to LiteSVM if so, but document the fallback).

## When done

Print one-line per-gate pass/fail summary. **Include the measured CU + writable-account count** in the summary. **Commit the work** — don't leave the working tree dirty. Stop.
