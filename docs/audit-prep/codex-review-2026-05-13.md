# W9 Codex Review - 2026-05-13

Scope: `git diff v0.3.1..HEAD`. W9 is review-only; founder acknowledged H1 and deferred the fix to post-W9.

## Summary

| Severity | Count | Notes |
| --- | ---: | --- |
| Critical | 0 | none |
| High | 1 | H1 logged and deferred post-W9 |
| Medium | 3 | M1-M3 audit-prep follow-ups |
| Low | 2 | L1-L2 cleanup follow-ups; L2 is an active-doc finding outside the changed-file list |

Reviewed files: 203. Diff size: 33910 changed lines (16133 insertions, 17777 deletions).

Canonical finding details live in `docs/audit-prep/findings.md`. Repeated H1 references below are evidence locations for one unique High finding, not separate High counts.

## `.github/workflows/e2e.yml`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `.gitignore`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/helpers/sdk-helpers.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/05-mint-complete-set-e2e.spec.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/06-merge-complete-set-e2e.spec.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/07-sell-yes-amm-e2e.spec.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/10-attest-settle-e2e.spec.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/19-orderbook-roundtrip-e2e.spec.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/20-orderbook-ui-click-roundtrip-e2e.spec.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/21-orderbook-ui-cancel-roundtrip-e2e.spec.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/22-create-graduate-orderbook-e2e.spec.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/orderbook-dust.spec.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/orderbook-escrow.spec.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/orderbook-missing-account-error.spec.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/orderbook-per-market-fee.spec.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/e2e/onchain/orderbook-per-tick-cap.spec.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/package.json`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/scripts/build-e2e-walkthrough.mjs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/scripts/dev-localnet.sh`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/scripts/run-playwright-e2e.mjs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/scripts/seed-localnet.mjs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/src/components/features/market/OrderbookPageBody.tsx`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/src/components/features/portfolio/ActiveOrdersCard.tsx`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/src/components/features/portfolio/CompleteSetPanel.tsx`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/src/lib/chain-shim/amm-bridge.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** H1 call-site: the demo builds all orderbook buy batches once, then submits them sequentially; no extra High counted beyond H1.
**Medium:** (none)
**Low:** (none)

## `apps/demo/src/lib/chain-shim/orderbook-reads.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/src/pages/Portfolio.tsx`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `apps/demo/src/store/useOrderStore.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/archive/README.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/archive/ladder-vs-density.md`

Status: Renamed from `docs/research/ladder-vs-density.md` (R091).

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/archive/monaco-fork-analysis.md`

Status: Renamed from `docs/monaco-fork-analysis.md` (R089).

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/archive/monaco-investigation-week-01.md`

Status: Renamed from `docs/research/monaco-investigation-week-01.md` (R098).

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/archive/sooth_book-fork-plan.md`

Status: Renamed from `docs/sooth_book/fork-plan.md` (R098).

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/decision-log.md`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w1-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w2a-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w2b-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w3-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w4-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w5-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w6-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w7-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w8-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/dispatch/codex-w9-sooth_book.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/research/orderbook-survey.md`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/sooth_book/cu-analysis.md`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** M1: active doc still describes Monaco-era CU/capacity decisions and deleted Monaco paths; archive or supersede before audit handoff.
**Low:** (none)

## `docs/sooth_book/sooth-ix-design.md`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** M1: active doc remains a Monaco W5-W6 design note for instruction surfaces removed by the direct EVM port.
**Low:** (none)

## `docs/spec/README.md`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `docs/spec/sooth_book.md`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/crates/sooth-protocol-types/Cargo.toml`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/crates/sooth-protocol-types/src/discriminators.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/crates/sooth-protocol-types/src/ids.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/crates/sooth-protocol-types/src/lib.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/docs/architecture.md`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_amm/src/instructions/sell_positions.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_amm/src/instructions/trade_positions.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** L1: comments still refer to a global `fee_pool_vault`; code now routes fees to per-market `market_fee_pool`.

## `packages/programs-core/programs/sooth_amm/tests/claim_refund.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_amm/tests/common/mod.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_amm/tests/dismiss_market.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_amm/tests/fee_accumulator.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_amm/tests/graduation_trigger.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_amm/tests/locked_cost_field.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_amm/tests/sell_fee_split.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/Cargo.toml`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/LICENSE`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/NOTICE`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/bitmap.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/context.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/error.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/events.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/events/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/events/trade.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/buy.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/cancel.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/cancel_by_id.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/clock.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/close.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/close_book_side.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/compact_book_side.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/fee_route.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market/create_market.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market/market_authority.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market/market_token_accounts.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market/update_market_event_start_time.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market/update_market_locktime.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market/update_market_status.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market/update_market_title.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_liquidities/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_position/create_market_position.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_position/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_position/settle_market_position.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_position/update_on_order_cancellation.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_position/update_on_order_match.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_position/update_on_order_request_creation.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_position/void_market_position.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_type/create_market_type.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/market_type/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/matching/create_trade.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/matching/matching_one_to_one.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/matching/matching_pool.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/matching/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/matching/on_order_creation.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/matching/on_order_match.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/math.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/mint_into_book.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/mod.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/operator.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order/cancel_order.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order/cancel_order_post_market_lock.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order/create_order.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order/match_order.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order/settle_order.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order/void_order.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order_request/create_order_request.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order_request/dequeue_order_request.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order_request/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/order_request/process_order_request.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/price_ladder/add_prices_to_price_ladder.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/price_ladder/create_price_ladder.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/price_ladder/increase_price_ladder_size.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/price_ladder/mod.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/settle_resting_orders.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/instructions/transfer.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/lib.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/matching.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/math.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/book_side.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_account.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_book.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_liquidities.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_matching_pool_account.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_matching_queue_account.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_order_request_queue.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_outcome_account.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_position_account.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/market_type.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/mod.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/operator_account.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/order_account.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/order_id.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/price_ladder.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/trade_account.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/src/state/type_size.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/tests/cpi_fee_route_hook.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/tests/cpi_mint_into_book.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/tests/cpi_settle_resting_orders.rs`

Status: Deleted in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/tests/cu_measurement.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/tests/matching.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_book/tests/place_cancel.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/Cargo.toml`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/error.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/events.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/instructions/distribute_fees.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/instructions/distribute_fees_legacy.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/instructions/init_market_fee_pool.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/instructions/initialize_fee_pool.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/instructions/mod.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/lib.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/state/legacy_fee_drain_marker.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/src/state/mod.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/tests/distribute_fees_per_market.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_launchpad/tests/lp_mint_on_buy.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/Cargo.toml`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/error.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instruction_introspection.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/credit_shares_for_order.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/debit_shares_for_order_before_deadline.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/deposit_for_order.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/fill_order.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/merge_complete_set_for_orderbook.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/mint_complete_set_for_orderbook.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/mod.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/orderbook_common.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/redeem_orderbook.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/transfer_fee_to_market_pool.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/transfer_fee_to_market_pool_from_book.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/instructions/withdraw_for_order.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/lib.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/state/mod.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/src/state/orderbook_position.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/tests/fee_rounding_golden.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/tests/orderbook_lifecycle.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/tests/sooth_book_cpi_gate.rs`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/programs-core/programs/sooth_market/tests/transfer_helpers.rs`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/docs/orderbook-cancel-ux.md`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/src/adapter.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** M2: legacy Monaco-era public builder methods remain beside the direct-port manual instruction builders; shipped buy/cancel paths avoid them, but the SDK surface needs cleanup.
**Low:** (none)

## `packages/sdk-solana/src/anchor/sooth_amm.json`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/src/anchor/sooth_market.json`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/src/index.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/src/orderbook/error-classifier.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/src/orderbook/matching-driver.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** H1: `buildOrderbookBuyMultiTx` prebuilds all multi-tx batches before any submitted batch can advance and re-read live `BookSide.head_index`; founder acknowledged, fix deferred post-W9.
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/src/pdas.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/src/types.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/tests/create-market.test.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/tests/fixtures/setup.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/tests/matching-driver.test.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** H1 coverage evidence: split/re-read tests do not model submit -> head advance -> re-plan between transactions; no extra High counted beyond H1.
**Medium:** M3: add a transaction-sequencing regression that mutates live head state after the first batch.
**Low:** (none)

## `packages/sdk-solana/tests/orderbook-error-classifier.test.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/tests/pdas.test.ts`

Status: Added in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/tests/sooth-book-builders.test.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** M2: tests still assert Monaco-era builder/account shapes rather than direct-port IDL/account-shape coverage.
**Low:** (none)

## `packages/sdk-solana/tests/submit-failure.test.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)

## `packages/sdk-solana/tests/submit-priority-fee.test.ts`

Status: Modified in this diff.

**Critical:** (none)
**High:** (none)
**Medium:** (none)
**Low:** (none)
