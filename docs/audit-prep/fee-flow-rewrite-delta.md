# Fee-Flow Rewrite Delta

Scope: AMM buy fees, AMM sell fees, orderbook fill fees, per-market distribution, and legacy global-pool migration.

## Pre-v0.4 Shape

| Path | Fee destination | Distribution |
| --- | --- | --- |
| AMM buy | Global `fee_pool_vault` plus AMM accumulator | `sooth_launchpad::distribute_fees` drained the singleton pool. |
| AMM sell | No complete sell-path fee wiring in the earlier SoothBook direct-port spec state. | Not applicable. |
| SoothBook orderbook | Monaco-era fee hook / global-pool framing. | Not part of the direct-port Path A implementation. |

The global `fee_pool_vault` remains allocated for migration symmetry only.

## v0.4 Shipped Shape

| Path | Source | Destination | Authority |
| --- | --- | --- | --- |
| AMM buy collateral | user USDC ATA | market vault | user signer |
| AMM buy fee | user USDC ATA | per-market `MarketFeePool` | user signer |
| AMM sell net lock | market vault | lock vault | `sooth_market` vault authority via CPI |
| AMM sell fee | market vault | per-market `MarketFeePool` | `sooth_market` vault authority via CPI, parent-gated to `sooth_amm::sell_positions` |
| Orderbook resting buy collateral | user USDC ATA | market vault | user signer via `sooth_market::deposit_for_order` |
| Orderbook taker payout | market vault | taker USDC ATA | `sooth_market` vault authority via `withdraw_for_order` |
| Orderbook fill fee | market vault | per-market `MarketFeePool` | `sooth_market` vault authority via `transfer_fee_to_market_pool_from_book` |
| Per-market distribution | `MarketFeePool` | bBase, LP yield, adjudicator, protocol vaults | `sooth_launchpad` fee-pool authority |
| Legacy migration | global `fee_pool_vault` | same four recipient vaults | `sooth_launchpad` fee-pool authority, one-shot marker |

## Distribution Semantics

`distribute_fees(market)` reads one market's fee-pool USDC amount, computes:

```text
to_b_base      = floor(total * b_base_share_bps / 10_000)
to_lp_yield    = floor(total * lp_yield_share_bps / 10_000)
to_adjudicator = floor(total * adjudicator_share_bps / 10_000)
to_protocol    = total - to_b_base - to_lp_yield - to_adjudicator
```

The remainder-to-protocol rule matches EVM `FeeRouter._distributePostGrad`. The first three buckets floor independently; no dust is stranded because protocol receives the exact remainder.

## Deploy-Day Migration Plan

1. Deploy upgraded programs after W9 sign-off.
2. Initialize or verify `ProtocolConfig`.
3. For each active market, call `init_market_fee_pool` before the first post-upgrade AMM/orderbook fee path needs the per-market pool.
4. Run `distribute_fees_legacy` once against the legacy global pool after all pre-upgrade traffic is quiesced.
5. Resume per-market cranks with `distribute_fees(market)`.

`distribute_fees_legacy` sets `LegacyFeeDrainMarker.drained_at` on success, so replay is rejected even if the legacy balance was zero.

## Numerical Parity Assertions

| Assertion | Current status |
| --- | --- |
| Four-way bps split uses the same floor/remainder shape as EVM post-grad distribution. | Preserved. |
| Buy-side fee SPL amount uses user-inflow rounding and does not mingle fee tokens with redemption collateral. | Preserved. |
| Sell-side fee is subtracted from proceeds and sent to the same per-market pool. | Preserved. |
| Orderbook fee flush transfers accumulated fee base units from the market vault to the per-market pool. | Preserved. |
| Fees cannot cross-contaminate between markets after the rewrite. | Preserved by `[b"market_fee_pool", market_id]` PDA seeds. |

## W9 Notes

H1 does not change fee custody: stale SDK bundles are rejected by on-chain maker validation before unauthorized fee movement can occur. The fee-flow risk that remains is operational: a deep cross can fail after the first submitted batch, leaving the user to retry. The post-W9 fix should re-plan after every submitted batch.

