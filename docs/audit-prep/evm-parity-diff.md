# EVM Parity Diff

Baseline EVM files:

- `/Users/danieltang/GitHub/sooth-core/src/SoothBook.sol`
- `/Users/danieltang/GitHub/sooth-core/src/OrderEngine.sol`
- `/Users/danieltang/GitHub/sooth-core/src/AMMEngine.sol`
- `/Users/danieltang/GitHub/sooth-core/src/FeeRouter.sol`

Categories:

- `Forced`: required by Solana's account model, SBF stack budget, or writable-account cap.
- `Accepted-tradeoff`: intentional and documented parity difference.
- `Bug`: unintended divergence. H1 is founder-acknowledged and deferred post-W9.

## Direct Parity

| EVM behavior | Solana behavior | Category | Notes |
| --- | --- | --- | --- |
| `SoothBook.buyYes` / `buyNo` call `_buy` with side 1/0 and caller-provided `matchLimit` (`SoothBook.sol:206-227`). | `sooth_book::buy_yes` / `buy_no` encode side and call the shared buy body. | Direct | Side model and user-facing action shape are preserved. |
| `_buy` debits opposite shares on `escrow=true` before matching (`SoothBook.sol:421-424`). | `buy.rs` calls `debit_shares_for_order_before_deadline` before matching when `escrow` is true. | Direct | CPI helper is parent-ix gated to `buy_yes`/`buy_no`. |
| `matchLimit == 0` means unlimited (`SoothBook.sol:477-479`). | `buy.rs` maps `match_limit_arg == 0` to `u32::MAX`. | Direct | Parity restored from the original spec risk list. |
| `_match` walks opposing ticks downward from the bitmap and stops at the crossing boundary (`SoothBook.sol:469-505`). | `matching.rs` walks the opposing bitmap and stops when amount, crossing, or match limit ends. | Direct | Solana requires account bundles for each fill. |
| `_matchTick` consumes FIFO orders from the tick head and clears the bitmap when exhausted (`SoothBook.sol:522-551`). | `matching.rs` reads `BookSide.head_index`, fills inline orders, advances head, and validates the `BookSide` PDA. | Direct with Solana validation | Solana validates each supplied maker bundle rather than reading arbitrary storage mappings. |
| `_settleFill` delegates token/share movement to `OrderEngine.fillOrder` (`SoothBook.sol:568-579`). | `sooth_book::matching` CPIs to `sooth_market::fill_order`, which returns deltas for fee/payout accumulators. | Forced | Solana cannot let one program write another program's accounts directly; CPI returns keep ownership boundaries clean. |
| Resting non-escrow remainder deposits base collateral (`SoothBook.sol:441-447`). | `buy.rs` CPIs to `sooth_market::deposit_for_order` for non-escrow resting remainder. | Forced | Solana custody lives in `sooth_market` vaults. |
| Dust remainders are skipped and escrow shares are credited back (`SoothBook.sol:430-438`). | `buy.rs` checks `min_resting_order_for_tick`, credits escrow remainder back, emits `DustOrderSkipped`, and flushes accumulators. | Direct | Solana uses base-unit-aware dust floor. |
| Order ids increment and map to an order pointer (`SoothBook.sol:450-462`). | `MarketBook.next_order_id` plus composite `order_id` encodes side/tick/seq. | Accepted-tradeoff | Composite id is Solana-friendly and lets cancel-by-id derive `BookSide` PDA inputs. |
| `OrderEngine._chargeTakerForBuy` rounds base cost and cost+fee in base units, then routes fee to AMM/FeeRouter (`OrderEngine.sol:720-740`). | `sooth_book` accumulates pending fee deltas and flushes them to the per-market fee pool through `sooth_market::transfer_fee_to_market_pool_from_book`. | Forced | Native token movement requires explicit SPL transfers and PDA signers. |
| `FeeRouter._distributePostGrad` floors bBase/LP/adjudicator slices and assigns the remainder to protocol (`FeeRouter.sol:377-386`). | `sooth_launchpad::compute_fee_split` floors the first three slices and subtracts them from total for protocol. | Direct | Numerical split parity is preserved. |

## Deviations

| EVM file/line | EVM behavior | Solana file/line | Solana behavior | Category | Justification or fix flag |
| --- | --- | --- | --- | --- | --- |
| `SoothBook.sol:75-85` | Orders and pointers live in contract storage mappings. | `sooth_book/src/state/{market_book,book_side,order_id}.rs` | `MarketBook` and per-tick `BookSide` PDAs hold bitmap/head/order state. | Forced | Solana storage is account-based. |
| `SoothBook.sol:519-551` | Queue arrays are contract storage; no account-list limit. | `sooth_book/src/matching.rs:43-46`, `:130-144` | Every fill requires a 5-account bundle; bundle arity and maker accounts are validated. | Forced | Solana requires writable accounts up front and cannot discover arbitrary maker accounts during execution. |
| `SoothBook.sol:477-505` | Unlimited matching can run in one EVM transaction until gas is exhausted. | SDK `matching-driver.ts` and `amm-bridge.ts` | Solana deep crosses must split across multiple transactions due writable-account budget. | Accepted-tradeoff with Bug H1 | Multi-tx is necessary, but current SDK prebuilds stale bundles. Fix deferred post-W9. |
| `SoothBook.sol:450-462` | Cancel can rely on storage pointer lookup only. | `sooth_book` cancel/cancel-by-id | Caller supplies side/tick or composite id so the `BookSide` PDA is known at build time. | Forced | Solana account addresses must be known before execution. |
| `SoothBook.sol:451-455` | Resting orders do not allocate per-order rent. | `BookSide` pooled inline orders | Rent is paid into per-tick `BookSide` accounts; cancel marks amount zero and compaction/close handles pooled cleanup. | Accepted-tradeoff | Required to keep creation cost below the founder cap; no per-cancel rent refund. |
| `OrderEngine.sol:80-99` | Orderbook positions are mappings in `OrderEngine`. | `sooth_market::OrderbookPosition` PDA | Separate per-user PDA stores orderbook YES/NO shares. | Forced | Mirrors the EVM split while fitting Solana account ownership. |
| `FeeRouter.sol:71-84`, `:393-405` | Fees accrue in WAD accounting fields and are claimed later. | `sooth_launchpad::distribute_fees` and token fee pools | Fees are physically held in per-market token accounts and split on crank. | Accepted-tradeoff | Token-balance read is the Solana equivalent of per-market accrual. |
| `FeeRouter.sol:339-370` | Pre-grad fees also mint LP tokens and can trigger graduation in FeeRouter. | `sooth_amm::trade_positions` and launchpad LP hook | AMM buy path keeps the existing Solana LP/graduation hook; orderbook fees flow to fee pools. | Accepted-tradeoff | Existing Solana AMM/launchpad architecture owns LP minting. |
| `OrderEngine.sol:24-29` | Signed-order Path B exists beside SoothBook filler path. | `docs/spec/sooth_book.md` §15 | Solana v1 ships Path A only; signed orders deferred. | Accepted-tradeoff | Decision-log D14; not part of v0.4 launch scope. |

## Bugs

| ID | Behavior | Status |
| --- | --- | --- |
| H1 | SDK multi-tx matching prebuilds every batch before submission, so same-tick deep crosses can reuse stale maker bundles after the first batch advances `BookSide.head_index`. | Founder acknowledged; logged in `findings.md`; deferred to post-W9. |

