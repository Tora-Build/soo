# Parent-Ix Gate Audit Checklist

Use this checklist when auditing `sooth_market` CPI-only helpers and their callers.

## Checklist

- [ ] Every filler-only `sooth_market` instruction called by `sooth_book` invokes `require_sooth_book_cpi_parent` before state mutation or token transfer.
- [ ] `require_sooth_book_cpi_parent` uses `load_instruction_at_checked(current_index)` only; it must not scan earlier instructions.
- [ ] `fill_order` allowlist is exactly `buy_yes`, `buy_no`.
- [ ] `deposit_for_order` allowlist is exactly `buy_yes`, `buy_no`.
- [ ] `withdraw_for_order` allowlist is exactly `buy_yes`, `buy_no`, `cancel`, `cancel_by_id`.
- [ ] `credit_shares_for_order` allowlist is exactly `buy_yes`, `buy_no`, `cancel`, `cancel_by_id`.
- [ ] `debit_shares_for_order_before_deadline` allowlist is exactly `buy_yes`, `buy_no`.
- [ ] `transfer_fee_to_market_pool_from_book` allowlist is exactly `buy_yes`, `buy_no`.
- [ ] Scan-window helpers are used only for AMM/adjudicator flows that tolerate ComputeBudget or setup instructions before the CPI.
- [ ] `transfer_fee_to_market_pool` remains AMM-sell-gated on `sooth_amm::sell_positions`.
- [ ] `transfer_fee_to_market_pool_from_book` remains SoothBook-gated on `buy_yes`/`buy_no`.
- [ ] No filler-only instruction accepts a wildcard parent program or empty discriminator allowlist.
- [ ] Negative tests cover direct calls, wrong parent program, wrong discriminator, and earlier-legitimate-ix scan bypass.
- [ ] Deadline-gated helpers reject post-deadline mutation at `deadline + 1`.

## Current Gate Inventory

| Instruction | First gate in handler | Allowed parents | Extra guard |
| --- | --- | --- | --- |
| `fill_order` | `require_sooth_book_cpi_parent` | `sooth_book::{buy_yes,buy_no}` | `require_before_deadline` |
| `deposit_for_order` | `require_sooth_book_cpi_parent` | `sooth_book::{buy_yes,buy_no}` | `require_before_deadline` |
| `withdraw_for_order` | `require_sooth_book_cpi_parent` | `sooth_book::{buy_yes,buy_no,cancel,cancel_by_id}` | amount zero is no-op |
| `credit_shares_for_order` | `require_sooth_book_cpi_parent` | `sooth_book::{buy_yes,buy_no,cancel,cancel_by_id}` | position identity |
| `debit_shares_for_order_before_deadline` | `require_sooth_book_cpi_parent` | `sooth_book::{buy_yes,buy_no}` | `require_before_deadline` |
| `transfer_fee_to_market_pool_from_book` | `require_sooth_book_cpi_parent` | `sooth_book::{buy_yes,buy_no}` | amount zero is no-op |
| `transfer_fee_to_market_pool` | `require_parent_ix_from_program` | `sooth_amm::sell_positions` | amount zero is no-op |

## Evidence Map

| Check | Evidence |
| --- | --- |
| Single-load helper | `packages/programs-core/programs/sooth_market/src/instruction_introspection.rs:172` |
| Scan-window helper | `packages/programs-core/programs/sooth_market/src/instruction_introspection.rs:94` |
| `fill_order` gate | `packages/programs-core/programs/sooth_market/src/instructions/fill_order.rs:101` |
| `deposit_for_order` gate | `packages/programs-core/programs/sooth_market/src/instructions/deposit_for_order.rs:42` |
| `withdraw_for_order` gate | `packages/programs-core/programs/sooth_market/src/instructions/withdraw_for_order.rs:47` |
| `credit_shares_for_order` gate | `packages/programs-core/programs/sooth_market/src/instructions/credit_shares_for_order.rs:41` |
| `debit_shares_for_order_before_deadline` gate | `packages/programs-core/programs/sooth_market/src/instructions/debit_shares_for_order_before_deadline.rs:46` |
| `transfer_fee_to_market_pool_from_book` gate | `packages/programs-core/programs/sooth_market/src/instructions/transfer_fee_to_market_pool_from_book.rs:66` |
| AMM sell fee gate | `packages/programs-core/programs/sooth_market/src/instructions/transfer_fee_to_market_pool.rs:63` |
| Gate tests | `packages/programs-core/programs/sooth_market/tests/sooth_book_cpi_gate.rs` |

## W9 Review Notes

No critical parent-ix gap was found. The single-load helper closes the earlier scan-bypass class by requiring the current instruction itself to be a `sooth_book` instruction with an allowed discriminator. The scan-window helper remains appropriate for AMM/adjudicator families because those flows can include legitimate prelude instructions.

