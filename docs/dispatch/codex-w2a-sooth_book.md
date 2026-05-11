# W2a dispatch — custody primitives + buy-side fee redirect

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop after the
> acceptance gates pass; Claude reviews + pushes; do not push to
> origin from inside Codex.

---

## Context (read first, in this order)

1. **`docs/spec/sooth_book.md`** — §3.4 (`OrderbookPosition`), §3.5 (`MarketFeePool`), §4.2 (filler-only ix surface + parent-ix gate spec), §6.2 (CPI return-data contract for `fill_order`), §7.4 (deadline guards), §8.2 (fill-time settlement logic), §9.3 (sooth_market additions), §9.4 (AMM fee-destination redirect — **buy path only in W2a; sell path is W2b**), §9.5 (sooth_launchpad additions), §11 row W2a.
2. **`docs/decision-log.md`** — D15 (split position model), D16 (per-market fee pools). Both pinned by W2a.
3. **`packages/programs-core/programs/sooth_market/src/instruction_introspection.rs`** — read the **entire file**. Existing `require_parent_ix_from_program` and friends use a **scan-window** `0..=current_index` to tolerate ComputeBudget / ATA-create prelude ixs. The new sooth_book gate is **single-load** (no scan) per spec §4.2 — the two helpers co-exist; do not modify the existing scan-based ones.
4. **`packages/programs-core/programs/sooth_market/src/instructions/transfer_to_lock.rs`** — existing parent-ix-gated, PDA-signed transfer helper; use as the pattern for the new `deposit_for_order` / `withdraw_for_order` / `fill_order` payout transfers.
5. **`packages/programs-core/programs/sooth_amm/src/instructions/trade_positions.rs:451-477`** — current fee CPI body. W2a redirects the destination only.
6. **EVM source for the fill body:** `/Users/danieltang/GitHub/sooth-alpha/packages/contracts-core/src/OrderEngine.sol:598-655` (`_fill`), `:714-786` (`_collectTakerCostAndFee`), `:787-836` (`_settleEscrowAndSurplus`).
7. **`.claude/skills/solana-dev`** — toolchain norms.

---

## Scope (do exactly these, nothing more)

Four programs touched: `sooth_market` (most additions), `sooth_launchpad` (one new ix), `sooth_amm` (destination edit), `sooth-protocol-types` (one more discriminator constant for the test-only impersonating stub if you add one).

### A. `sooth_market` — `OrderbookPosition` PDA

New file `packages/programs-core/programs/sooth_market/src/state/orderbook_position.rs`:

```rust
#[account]
pub struct OrderbookPosition {
    pub market: Pubkey,
    pub user:   Pubkey,
    pub yes_shares: u128,         // WAD
    pub no_shares:  u128,         // WAD
    pub _reserved:  [u8; 16],
}
impl OrderbookPosition {
    pub const SPACE: usize = 8 + 32 + 32 + 16 + 16 + 16; // 120
}
```

Seeds: `[b"orderbook_position", market.market_id.as_ref(), user.as_ref()]`. Re-export from `state/mod.rs`. **Do not** touch the existing AMM `Position` (it stays in `sooth_amm`).

### B. `sooth_market` — single-load parent-ix gate

Add to `instruction_introspection.rs` (do NOT touch the existing helpers):

```rust
/// Single-load parent-ix gate for sooth_book-CPI-only ix bodies.
///
/// Unlike `require_parent_ix_from_program` which scans `0..=current_index`
/// to tolerate ComputeBudget / ATA-create prelude ixs, this helper loads
/// ONLY the instruction at `current_index`. This closes the scan-bypass
/// attack vector: an earlier, unrelated sooth_book ix in the same tx
/// cannot satisfy the gate on a later filler-only call.
///
/// Use ONLY for filler-only ix called by sooth_book::{buy_yes,buy_no,
/// cancel,cancel_by_id} — those entry points sign for their CPIs with
/// the sooth_book program PDA, so the top-level current_index IS the
/// sooth_book ix. AMM and adjudicator gates keep the existing scan
/// helpers because their flows include legitimate ComputeBudget prefix.
pub fn require_sooth_book_cpi_parent(
    instruction_sysvar: &AccountInfo,
    allowed_discriminators: &[[u8; 8]],
) -> Result<()> {
    require_keys_eq!(*instruction_sysvar.key, sysvar::instructions::ID,
                     SoothMarketError::InvalidSysvar);
    let current_index = ix_sysvar::load_current_index_checked(instruction_sysvar)? as usize;
    let parent_ix = ix_sysvar::load_instruction_at_checked(current_index, instruction_sysvar)?;
    require!(parent_ix.program_id == SOOTH_BOOK_PROGRAM_ID,
             SoothMarketError::InvalidParentInstruction);
    let disc: [u8; 8] = parent_ix.data.get(..8)
        .ok_or(error!(SoothMarketError::InvalidParentInstruction))?
        .try_into()
        .map_err(|_| error!(SoothMarketError::InvalidParentInstruction))?;
    require!(allowed_discriminators.contains(&disc),
             SoothMarketError::InvalidParentInstruction);
    Ok(())
}
```

Add a host-side data variant `require_sooth_book_cpi_parent_from_data` mirroring `require_parent_ix_from_data` for unit testability.

Add `InvalidSysvar` to `SoothMarketError` if not already present.

### C. `sooth_market` — 5 filler-only ix

Files: `instructions/{fill_order,deposit_for_order,withdraw_for_order,credit_shares_for_order,debit_shares_for_order_before_deadline}.rs`.

Per spec §4.2 table. Each ix:

- Top-of-body calls `require_sooth_book_cpi_parent(sysvar, &allowed_discriminators)`.
- Deadline guard YES/NO per the §4.2 table.
- Discriminator allowlist:

| ix                                       | Allowed parent discriminators                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `fill_order`                             | `[SOOTH_BOOK_BUY_YES_DISCRIMINATOR, SOOTH_BOOK_BUY_NO_DISCRIMINATOR]`                                                                         |
| `deposit_for_order`                      | `[SOOTH_BOOK_BUY_YES_DISCRIMINATOR, SOOTH_BOOK_BUY_NO_DISCRIMINATOR]`                                                                         |
| `withdraw_for_order`                     | `[SOOTH_BOOK_CANCEL_DISCRIMINATOR, SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR]`                                                                    |
| `credit_shares_for_order`                | `[SOOTH_BOOK_BUY_YES_DISCRIMINATOR, SOOTH_BOOK_BUY_NO_DISCRIMINATOR, SOOTH_BOOK_CANCEL_DISCRIMINATOR, SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR]` |
| `debit_shares_for_order_before_deadline` | `[SOOTH_BOOK_BUY_YES_DISCRIMINATOR, SOOTH_BOOK_BUY_NO_DISCRIMINATOR]`                                                                         |

**`fill_order` body** is a port of EVM `OrderEngine._fill` + `_collectTakerCostAndFee` + `_settleEscrowAndSurplus` + `_creditMatchedShares`. Per spec §8.2:

1. Deadline check.
2. If `!taker_escrow`: pull `taker_cost_base + fee_base` from taker USDC ATA to market vault using the §7.3 floor-on-sum rule.
3. If `maker_escrow`: pay maker USDC payout = `wad_to_base((NUM_TICKS - maker_tick) * fill / NUM_TICKS)`. Signed by `vault_authority` PDA.
4. If `taker_escrow`: compute `wad_to_base((NUM_TICKS - taker_tick) * fill / NUM_TICKS)` and **add to `taker_payout_delta`** (do NOT transfer here — caller batches the flush per spec §3.1 ownership rule).
5. Surplus: when `taker_tick + maker_tick > NUM_TICKS`, add `wad_to_base((sum - NUM_TICKS) * fill / NUM_TICKS)` to `taker_payout_delta`.
6. Credit `OrderbookPosition` shares per §8.2 step 6.
7. `set_return_data` a Borsh-encoded `FillReturnData { fee_base_delta: u128, taker_payout_delta: u128 }` per spec §6.2.

**Math helpers** (`wad_to_base`, `compute_cost_base`, etc.) — port the formulas inline for W2a. Centralizing into a shared math crate is W4's call.

**`deposit_for_order` / `withdraw_for_order`**: SPL transfers between user ATA and market USDC vault, signed by `vault_authority` for the outflow side. Mirror `transfer_to_lock`'s pattern. Deadline guard per the table.

**`credit_shares_for_order` / `debit_shares_for_order_before_deadline`**: pure account-data mutation on `OrderbookPosition`. No token movement. Deadline guard per the table.

### D. `sooth_launchpad` — `init_market_fee_pool` ix

New file `instructions/init_market_fee_pool.rs`. Single-shot permissionless ix that creates the SPL `TokenAccount` at PDA `[b"market_fee_pool", market.market_id.as_ref()]` owned by `fee_pool_authority` singleton, mint validated against `sooth_protocol_types::ids::BASE_TOKEN_MINT`. ~$0.18 rent paid by caller.

Wire into `lib.rs` and the `pub mod instructions` re-exports. Do NOT modify `distribute_fees` in this dispatch — W5.

### E. `sooth_amm::trade_positions` — buy-path destination redirect

Edit `instructions/trade_positions.rs`:

- Replace the `fee_pool_vault: Box<Account<'info, TokenAccount>>` field on `TradePositions` with `market_fee_pool: Box<Account<'info, TokenAccount>>`. Add seeds binding to `[b"market_fee_pool", market.market_id.as_ref()]` against `sooth_launchpad::ID`.
- Update the fee transfer CPI at lines 467-477 to target `market_fee_pool` instead of `fee_pool_vault`.
- Do **NOT** touch `sell_positions.rs` — that's W2b.

This is a breaking change for the existing SDK and demo. Expected — they catch up in W7. Existing e2e tests on Surfpool will fail until W7. Document this in the commit message.

### F. `sooth-protocol-types`

Add `SOOTH_MARKET_FILL_ORDER_DISCRIMINATOR`, `..._DEPOSIT_FOR_ORDER_...`, `..._WITHDRAW_FOR_ORDER_...`, `..._CREDIT_SHARES_FOR_ORDER_...`, `..._DEBIT_SHARES_FOR_ORDER_BEFORE_DEADLINE_...`, and `SOOTH_LAUNCHPAD_INIT_MARKET_FEE_POOL_DISCRIMINATOR` constants. Compute via `sha256("global:<ix_name>")[..8]`, never invent.

### G. Negative tests for the parent-ix gate

In `programs/sooth_market/tests/`, add a Rust integration test file `tests/sooth_book_cpi_gate.rs` (or extend an existing test file). Tests must cover:

1. **Direct call rejection.** Calling any of the 5 filler-only ix as a top-level tx (no sooth_book CPI) → `InvalidParentInstruction`.
2. **Wrong-program parent.** A different program (e.g. `sooth_amm`) calling the filler ix as its CPI → reject.
3. **Wrong-discriminator parent.** A test-only fixture program impersonating `sooth_book::ID` with the wrong discriminator → reject. The fixture program lives under `tests/fixtures/` or `_spikes/`; it asserts `declare_id!(SOOTH_BOOK_PROGRAM_ID)` only in a test cfg so it doesn't pollute the main artifact set.
4. **Scan-bypass attempt.** A tx that puts a real `sooth_book::buy_yes` ix at index 0 followed by a direct top-level filler-only ix at index 1 — the index-1 call must reject because `current_index = 1`'s parent is itself, not the earlier index-0 ix.
5. **Deadline guard (positive path).** Ix at deadline+1 second must reject with the existing deadline-guard error.

Use LiteSVM or `solana-program-test` per the existing pattern (see `sooth_market/tests/lock_flow.rs` if it exists; otherwise mirror `sooth_amm/tests/*`). Host-side parser tests for `require_sooth_book_cpi_parent_from_data` go in `instruction_introspection.rs` `#[cfg(test)]` mod.

---

## Acceptance gates (run in order, all must pass)

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test -p sooth_market --lib
NO_DNA=1 cargo test -p sooth_market sooth_book_cpi_gate
NO_DNA=1 cargo test -p sooth_launchpad --lib
NO_DNA=1 cargo test -p sooth_amm --lib
NO_DNA=1 anchor build
```

`anchor build` will regenerate IDLs. The new ix appear in the sooth_market and sooth_launchpad IDLs; that's expected.

If E2E tests fail (they will, because the SDK still references `fee_pool_vault`), that's acceptable for W2a — note the breakage in the commit message but don't try to fix the SDK.

---

## Out of scope (DO NOT do in W2a)

- `sooth_amm::sell_positions` — W2b dispatch (separate prompt).
- `sooth_launchpad::distribute_fees` rewrite to per-market — W5.
- `sooth_launchpad::distribute_fees_legacy` (one-time global drain) — W5.
- `BookSide` PDA, `InlineOrder`, place/cancel ix on `sooth_book` — W3.
- `match_buy` / `match_at_tick` matcher — W4.
- `mint_complete_set_for_orderbook` / `merge_..._for_orderbook` / `redeem_orderbook` — W6.
- Any SDK or demo changes — W6 / W7.
- Devnet redeploy.

---

## Operational rules

- Branch: `feat/sooth_book-w2a-custody` off current `main`.
- Commits: clean, small. Suggested split:
  1. `feat(sooth-protocol-types): add filler-only ix discriminators`
  2. `feat(sooth_market): OrderbookPosition PDA`
  3. `feat(sooth_market): single-load parent-ix gate for sooth_book CPI`
  4. `feat(sooth_market): fill_order ix (CPI-only)`
  5. `feat(sooth_market): deposit_for_order + withdraw_for_order ix`
  6. `feat(sooth_market): credit_shares_for_order + debit_shares_for_order_before_deadline ix`
  7. `feat(sooth_launchpad): init_market_fee_pool ix`
  8. `feat(sooth_amm): redirect buy-path fee transfer to market_fee_pool`
  9. `test(sooth_market): sooth_book CPI gate — 5 negative cases`
- **Do NOT push** to origin. Claude pushes after review.
- **Do NOT tag**.
- **Do NOT skip pre-commit hooks** (`--no-verify` is forbidden).
- **Do NOT amend** previously-pushed commits.
- `NO_DNA=1` prefix on all CLI invocations.
- If a step is ambiguous (especially the `fill_order` settlement math), **stop and print a question to stdout**. Do not guess on settlement formulae — they're load-bearing and EVM-parity must hold.

## When done

Print one-line per-gate pass/fail summary, then stop. Claude reviews the branch and decides on the PR.
