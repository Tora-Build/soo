# SoothBook v0.4 Threat Model

Scope: `sooth_book` direct-port implementation through W8, plus the cross-program custody, fee, and demo/SDK surfaces touched by `git diff v0.3.1..HEAD`.

## Trust Boundaries

| Boundary | Trust rule |
| --- | --- |
| User wallet -> SDK/demo | User signs Solana transactions; SDK may build instructions but never has custody. |
| SDK/demo -> Solana RPC | RPC can be stale or reorder observations; on-chain account validation is authoritative. |
| `sooth_book` -> `sooth_market` CPI | `sooth_book` owns matching state; `sooth_market` owns market custody, positions, and vault movement. Every filler-only helper is parent-ix gated. |
| `sooth_amm` -> `sooth_market` CPI | AMM sell fee and lock flows use scan-window gates to tolerate ComputeBudget prelude instructions. |
| `sooth_adjudicator` -> `sooth_market` CPI | Lock/settle flows are adjudicator-gated and use scan-window helpers. |
| `sooth_market` -> SPL Token | Market vault and lock vault movement requires PDA signer seeds owned by `sooth_market`. |
| `sooth_launchpad` -> SPL Token | Per-market fee pools and legacy global fee pool are signed by `sooth_launchpad` fee-pool authority. |

## Account-Write Authority Matrix

| Account family | Owner program | Writable by | Notes |
| --- | --- | --- | --- |
| `Market` | `sooth_market` | `sooth_market` instructions and authorized CPI callers | Market lifecycle, vault authority bumps, mints, vaults. |
| `Position` | `sooth_market` | AMM lifecycle plus market refund/redeem helpers | AMM-only share and lock accounting. |
| `OrderbookPosition` | `sooth_market` | `sooth_book`-gated helpers and orderbook redeem/mint/merge | Split from AMM `Position` to mirror EVM `OrderEngine` vs `AMMEngine`. |
| `MarketBook` | `sooth_book` | `sooth_book` | Matching bitmap, next order id, pending payout/fee accumulators. |
| `BookSide` | `sooth_book` | `sooth_book` | Per-side/tick inline order queue; capped by `MAX_ORDERS_PER_TICK`. |
| `AmmState` | `sooth_amm` | `sooth_amm` | LMSR state, graduation and fee accumulator. |
| `ProtocolConfig` | `sooth_launchpad` | `sooth_launchpad` | Fee bps and treasury config. |
| `MarketFeePool` token account | SPL Token, authority `sooth_launchpad` PDA | credited by AMM/orderbook flows; drained by `sooth_launchpad::distribute_fees` | Per-market fee isolation. |
| Legacy `fee_pool_vault` | SPL Token, authority `sooth_launchpad` PDA | drained once by `distribute_fees_legacy` | Migration-only global pool. |

## Parent-Ix Gate Inventory

| Callee | Gate | Accepted parent program | Accepted parent discriminators | Gate mode |
| --- | --- | --- | --- | --- |
| `sooth_market::fill_order` | `require_sooth_book_cpi_parent` | `sooth_book` | `buy_yes`, `buy_no` | single-load current index |
| `sooth_market::deposit_for_order` | `require_sooth_book_cpi_parent` | `sooth_book` | `buy_yes`, `buy_no` | single-load current index |
| `sooth_market::withdraw_for_order` | `require_sooth_book_cpi_parent` | `sooth_book` | `buy_yes`, `buy_no`, `cancel`, `cancel_by_id` | single-load current index |
| `sooth_market::credit_shares_for_order` | `require_sooth_book_cpi_parent` | `sooth_book` | `buy_yes`, `buy_no`, `cancel`, `cancel_by_id` | single-load current index |
| `sooth_market::debit_shares_for_order_before_deadline` | `require_sooth_book_cpi_parent` | `sooth_book` | `buy_yes`, `buy_no` | single-load current index |
| `sooth_market::transfer_fee_to_market_pool_from_book` | `require_sooth_book_cpi_parent` | `sooth_book` | `buy_yes`, `buy_no` | single-load current index |
| `sooth_market::transfer_fee_to_market_pool` | `require_parent_ix_from_program` | `sooth_amm` | `sell_positions` | scan window |
| `sooth_market::lock_for_resolution` / `settle` | adjudicator helpers | `sooth_adjudicator` | request/attest/dispute discriminators per caller | scan window |

Single-load gates call `load_instruction_at_checked(current_index)`. Scan-window gates intentionally search `0..=current_index` only for AMM/adjudicator flows that need ComputeBudget or setup prelude tolerance.

## Sysvar Usage

| Sysvar | Uses |
| --- | --- |
| Instructions sysvar | Parent-instruction gates in `sooth_market` filler, AMM, and adjudicator CPI helpers. |
| Clock sysvar | Deadline guards on orderbook filler helpers and lifecycle gates; legacy fee drain timestamp; market timing checks. |

## Token Vault Ownership

| Vault | Token authority | Signing seeds | Write paths |
| --- | --- | --- | --- |
| Market vault | `sooth_market` vault authority | `[b"vault", market_id]` | Market collateral deposit/withdraw/redeem, orderbook fee flush from market vault. |
| Lock vault | `sooth_market` lock authority | `[b"lock", market_id]` | AMM sell lock/claim flows. |
| Per-market fee pool | `sooth_launchpad` fee-pool authority | `[b"fee_pool_authority"]` | Credited by AMM buy, AMM sell via market CPI, and orderbook fee flush; drained by per-market `distribute_fees`. |
| Legacy global fee pool | `sooth_launchpad` fee-pool authority | `[b"fee_pool_authority"]` | One-shot migration drain only. |
| User ATAs | User wallet | user signature | User-funded buys, redemptions, fee recipients. |

## Known Attack Vectors and Mitigations

| Vector | Mitigation | W9 status |
| --- | --- | --- |
| Parent-ix scan bypass by placing an earlier legitimate `sooth_book` ix before a direct filler call | `require_sooth_book_cpi_parent` loads only `instructions[current_index]`; test rejects the scan-bypass fixture. | Closed |
| Account substitution | PDA seed constraints, program-id pins, token mint/authority constraints, and explicit maker-position/user/mint validation in matching bundles. | Closed |
| Fee rounding griefing | Orderbook fee accounting uses floor-on-sum parity against EVM rounding rules; distribute-fee split floors first three buckets and gives remainder to protocol. | Closed |
| Stale-bitmap or stale-head race in SDK matching | On-chain maker validation rejects stale bundles. SDK multi-tx orchestration is still incomplete for deep same-tick crosses. | H1 deferred post-W9 |
| Dust orders | `min_resting_order_for_tick` skips uncollectible dust and credits escrow remainder back before flush. | Closed |
| Per-tick saturation | `MAX_ORDERS_PER_TICK=50` rejects new resting orders at a full tick. | Closed |
| `init_if_needed` audit smell on `MarketBook`/`BookSide` | Deterministic seeds bind accounts to `market_id` and side/tick; first-touch user pays rent; account headers are validated on load. | Accepted tradeoff |

