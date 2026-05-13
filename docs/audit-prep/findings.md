# W9 Findings

Scope: review of `git diff v0.3.1..HEAD` plus W9 active-doc checks.

Status convention:

- `Deferred post-W9`: founder acknowledged the issue; W9 records it but does not fix it.
- `Audit-prep follow-up`: non-blocking issue for audit readiness or cleanup.

## Severity Counts

| Severity | Count | Status |
| --- | ---: | --- |
| Critical | 0 | none |
| High | 1 | H1 acknowledged; deferred post-W9 |
| Medium | 3 | audit-prep follow-up |
| Low | 2 | audit-prep follow-up |

## H1 - SDK multi-tx matching prebuilds stale maker bundles

Severity: High

Status: Deferred post-W9. Founder acknowledged. Do not fix in W9.

Files:

- `packages/sdk-solana/src/orderbook/matching-driver.ts`
- `apps/demo/src/lib/chain-shim/amm-bridge.ts`
- `packages/sdk-solana/tests/matching-driver.test.ts`
- `packages/programs-core/programs/sooth_book/src/matching.rs`

Evidence:

- `buildOrderbookBuyMultiTx` plans every transaction in one loop before any transaction is submitted. It repeatedly calls `collectPredictedFills`, builds fill bundles, pushes an instruction batch, and only decrements local `remaining`; no batch is submitted and no live `BookSide` head is re-read after a prior batch lands.
- The demo calls `buildOrderbookBuyMultiTx` once, then submits each prebuilt batch sequentially.
- The on-chain matcher reads the live `BookSide.head_index` and validates each maker bundle against the current head. If batch 1 advances the head, batch 2 can carry stale maker accounts and fail with `MakerAccountMismatch`.
- Existing matching-driver tests assert split counts and simulated re-reads during planning, but they do not model submit -> head advance -> re-plan between transactions.

Impact:

The documented W8 mitigation says deeper crosses are handled by SDK multi-tx orchestration. Same-tick depth can instead produce a deterministic second-transaction failure after the first transaction advances the live book. This does not create an unauthorized fund movement path because on-chain maker validation rejects stale bundles, but it breaks the user-facing deep-cross path and leaves the W8 mitigation incomplete.

Post-W9 fix direction:

Submit at most one planned batch per live read, then re-read `MarketBook`/`BookSide` after confirmation before constructing the next batch. Add a regression test that simulates the first batch advancing `head_index` and proves the second batch uses the new head rather than stale maker bundles.

## M1 - Active SoothBook design docs retain Monaco-era details

Severity: Medium

Files:

- `docs/sooth_book/cu-analysis.md`
- `docs/sooth_book/sooth-ix-design.md`

Evidence:

`cu-analysis.md` still discusses the W2 Monaco capacity-lift decision and references deleted Monaco paths such as `instructions/matching/on_order_creation.rs` and `state/market_liquidities.rs`. `sooth-ix-design.md` is still presented as W5-W6 design notes for the Monaco fork and describes `mint_into_book`, `settle_resting_orders`, `fee_route_hook`, and Monaco escrow accounts that the direct EVM port removed.

Impact:

Auditors can land on stale active docs that contradict `docs/spec/sooth_book.md` and the current Rust program. The canonical spec and archive banner are clear, so this is audit-readiness drift rather than a protocol defect.

Post-W9 fix direction:

Move both docs to `docs/archive/` or add explicit supersession banners that point to `docs/spec/sooth_book.md`, then update references that still treat them as active design inputs.

## M2 - SDK still exposes stale Monaco-era IDL and legacy builders

Severity: Medium

Files:

- `packages/sdk-solana/src/anchor/sooth_book.json`
- `packages/sdk-solana/src/adapter.ts`
- `packages/sdk-solana/tests/sooth-book-builders.test.ts`

Evidence:

The exported SDK `sooth_book` IDL still lists Monaco-era instructions such as `create_market`, `mint_into_book`, `process_order_request`, and `match_orders`. `SolanaChainAdapter` also keeps public methods that build those legacy instruction shapes, and `sooth-book-builders.test.ts` continues asserting their account layouts. The current canonical buy/cancel path manually encodes `buy_yes`, `buy_no`, `cancel`, and `cancel_by_id`, so the shipped demo orderbook path does not depend on this stale IDL.

Impact:

External consumers importing the SDK IDL, or calling legacy public methods directly, can build requests for instructions that do not match the direct-port program. This is not the current demo's orderbook buy/cancel path, but it is a public surface cleanup item before external audit handoff.

Post-W9 fix direction:

Regenerate and sync `packages/sdk-solana/src/anchor/sooth_book.json` from Anchor, remove or explicitly deprecate the Monaco-era adapter methods, and delete/replace the stale builder tests with direct-port instruction/account-shape tests.

## M3 - Matching-driver test gap is narrower than the documented W8 failure mode

Severity: Medium

Files:

- `packages/sdk-solana/tests/matching-driver.test.ts`

Evidence:

The suite has a split-at-limit test and a planning-time bitmap re-read test, but not a transaction-sequencing test that proves each post-submit batch is planned against updated live state.

Impact:

This test gap is the reason H1 escaped. H1 carries the blocking behavior; this Medium finding records the test coverage follow-up separately for audit traceability.

Post-W9 fix direction:

Add a test double that mutates `BookSide.head_index` after a simulated first submit, then assert the second planned batch excludes the already-filled maker accounts.

## L1 - AMM buy-path comments still say global fee pool

Severity: Low

File: `packages/programs-core/programs/sooth_amm/src/instructions/trade_positions.rs`

Evidence:

The code routes buy fees to `market_fee_pool`, but nearby comments still call it the global `fee_pool_vault` and say `distribute_fees` drains the global pool.

Impact:

Comment-only drift. The account struct and SPL transfer destination are per-market.

Post-W9 fix direction:

Update comments during the post-W9 cleanup wave.

## L2 - Roadmap still describes the Monaco fork as active work

Severity: Low

File: `docs/roadmap.md`

Evidence:

The roadmap still says to schedule the Monaco fork and says the orderbook page is gated until the fork lands. The current canonical plan is the direct EVM port, now implemented through W8.

Impact:

Repository navigation drift for humans. `docs/spec/sooth_book.md`, `docs/status.md`, and `docs/decision-log.md` are the fresher sources of truth after W9.

Post-W9 fix direction:

Refresh `docs/roadmap.md` or archive it after v0.4 sign-off.

