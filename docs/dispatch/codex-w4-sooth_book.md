# W4 dispatch — auto-matching engine + EVM-parity fee rounding

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop after the
> acceptance gates pass; Claude reviews + pushes; do not push to
> origin from inside Codex.

W4 is the load-bearing W in the plan. It wraps the matcher around the W3 place path, wires the `set_return_data` accumulator pattern between `sooth_book` and `sooth_market`, and pins the EVM golden-case fee-rounding fixtures. Estimated runtime: 35–50 minutes — the longest single dispatch.

---

## Context (read first, in full)

1. **`docs/spec/sooth_book.md`**:
   - §5 — full `buy` ix pseudocode (W3 implemented steps 1–3, 5–9; **W4 adds step 4 — the matcher — and step 4's interaction with the W3 dust/rest steps**)
   - §6 — auto-matching algorithm. **Read all of §6, §6.1, §6.2, §6.3 — every line is load-bearing.**
   - §7.1 (`min_resting_order_for_tick`) and §7.2 (escrow `valueTick`) — already shipped W3
   - §7.3 — **fee floor-on-sum rule.** This is the EVM-parity invariant the matcher must respect.
   - §7.5 — end-of-ix accumulator flush
   - §11 W4 row — acceptance gates (LiteSVM tests with named scenarios + golden-case fixtures)
2. **`packages/programs-core/programs/sooth_book/src/instructions/{buy,cancel,cancel_by_id,compact_book_side,close_book_side}.rs`** — shipped W3. The `buy` body is where the matcher gets inserted (between W3's step 3 escrow predebit and step 5 dust check).
3. **`packages/programs-core/programs/sooth_market/src/instructions/fill_order.rs`** — shipped W2a. Already does `set_return_data(FillReturnData { fee_base_delta, taker_payout_delta })`. W4 wires `get_return_data` on the caller side.
4. **EVM source** (verify line ranges against current `sooth-alpha/main`):
   - `/Users/danieltang/GitHub/sooth-alpha/packages/contracts-core/src/SoothBook.sol:_match` (≈ line 469) and `:_matchTick` (≈ line 508) — the algorithm Solana mirrors
   - `/Users/danieltang/GitHub/sooth-alpha/packages/contracts-core/src/libraries/TickBitmap.sol:findNextDown` / `findNextUp` — already ported in W1's `bitmap.rs`
   - `/Users/danieltang/GitHub/sooth-alpha/packages/contracts-core/src/OrderEngine.sol:_collectTakerCostAndFee` (≈ line 714) — the floor-on-sum source

---

## Scope

### A. `sooth_book::matching` module

New file `programs/sooth_book/src/matching.rs` (or `instructions/matching.rs`). Two functions per spec §6.

```rust
pub struct MatchTickResult {
    pub remaining: u128,
    pub match_limit_remaining: u32,
    pub next_fill_index: usize,
}

pub fn match_buy(
    book: &mut MarketBook,
    taker_side: u8,
    taker_tick: u16,
    mut amount: u128,
    taker_escrow: bool,
    mut match_limit: u32,
    remaining_accounts: &[AccountInfo],
) -> Result<u128 /* remaining */> {
    // exactly the pseudocode from §6, no improvisation
}

pub fn match_at_tick(
    book: &mut MarketBook,
    remaining_accounts: &[AccountInfo],
    mut fill_index: usize,
    taker_side: u8, opp_side: u8,
    taker_tick: u16, opp_tick: u16,
    mut remaining: u128,
    taker_escrow: bool,
    mut match_limit: u32,
) -> Result<MatchTickResult> {
    // exactly the pseudocode from §6, no improvisation
}
```

**Three exit states from `match_buy`** per spec §6.1 table:

- Bitmap exhausted (`find_next_down` returns 0) → clean exit, remainder flows to step 5 dust check.
- `match_limit` hit → clean exit, same downstream.
- Bundle budget hit (`fill_index >= remaining_accounts.len() / 5`) → clean exit, same downstream.

**Three error states (return `Err`, NOT silent rest):**

- `MissingCrossingBookSide` — bundle's BookSide seeds don't validate against bitmap's current opp_tick.
- `MakerAccountMismatch` — bundle's maker OrderbookPosition.user ≠ BookSide.orders[head_after_skip].maker.
- `WrongBundleArity` — `remaining_accounts.len() % 5 != 0`.

### B. `remaining_accounts` bundle validation (§6.1)

Helper `load_fill_bundle(remaining_accounts, fill_index, market, opp_side, opp_tick) -> Result<FillBundle>`:

```rust
pub struct FillBundle<'info> {
    pub book_side: AccountLoader<'info, BookSide>,  // pos 0
    pub maker_position: Account<'info, OrderbookPosition>,  // pos 1
    pub maker_usdc_ata: Account<'info, TokenAccount>,  // pos 2
    // positions 3 + 4 are reserved (system_program placeholders per spec)
}
```

Validate:

- Pos 0 seeds: `[b"book_side", market.market_id, &[opp_side], &opp_tick.to_le_bytes()]` → if mismatch, return `MissingCrossingBookSide`.
- Pos 1 seeds: `[b"orderbook_position", market.market_id, maker.as_ref()]` where `maker` is loaded from `book_side.orders[head_after_skip].maker`.
- Pos 2: `owner == maker`, `mint == BASE_TOKEN_MINT`.
- Positions 3 + 4: tolerate any account (placeholders).

**Bundle deduplication:** The same `BookSide` PDA repeats across all bundles at a tick (Solana dedupes writable accounts at tx level — free). The matcher MUST advance `fill_index` by 1 per maker fill, not per tick.

### C. `set_return_data` / `get_return_data` accumulator wiring (§6.2)

Caller side in `match_at_tick`:

```rust
// CPI to sooth_market::fill_order — set_return_data set on success
sooth_market::cpi::fill_order(...)?;
let (fee_base_delta, taker_payout_delta) = decode_fill_return_data()?;

book.pending_fees = book.pending_fees.checked_add(fee_base_delta)
    .ok_or(CoreError::MathOverflow)?;
book.pending_taker_payout = book.pending_taker_payout.checked_add(taker_payout_delta)
    .ok_or(CoreError::MathOverflow)?;
```

`decode_fill_return_data` is a small helper in `matching.rs` or `state/return_data.rs`:

```rust
pub fn decode_fill_return_data() -> Result<(u128, u128)> {
    let (program_id, data) = solana_program::program::get_return_data()
        .ok_or(CoreError::MissingFillReturnData)?;
    require_keys_eq!(program_id, sooth_market::ID, CoreError::WrongFillReturnProgram);
    let ret = sooth_market::FillReturnData::try_from_slice(&data)
        .map_err(|_| CoreError::MalformedFillReturnData)?;
    Ok((ret.fee_base_delta, ret.taker_payout_delta))
}
```

Add `MissingFillReturnData`, `WrongFillReturnProgram`, `MalformedFillReturnData` to `CoreError`.

Note: `sooth_market::FillReturnData` is currently private to the `fill_order` module. **Promote it to a public re-export** from `sooth_market::lib.rs` so `sooth_book` can deserialize against the same Borsh schema. Same crate boundary trick the existing AMM helpers use.

### D. `flush_accumulators` (§7.5)

New function (in `instructions/buy.rs` or `matching.rs`):

```rust
fn flush_accumulators(
    book: &mut Account<'info, MarketBook>,
    ctx: &BuyCtx<'info>,
) -> Result<()> {
    if book.pending_taker_payout > 0 {
        let amount: u64 = book.pending_taker_payout.try_into()
            .map_err(|_| CoreError::MathOverflow)?;
        // CPI sooth_market::withdraw_for_order to taker
        sooth_market::cpi::withdraw_for_order(..., amount)?;
        book.pending_taker_payout = 0;
    }
    if book.pending_fees > 0 {
        let amount: u64 = book.pending_fees.try_into()
            .map_err(|_| CoreError::MathOverflow)?;
        // CPI a sooth_market helper that signs vault_authority transfer to market_fee_pool
        // (similar to W2b's transfer_fee_to_market_pool — but parent-ix gate is on
        //  sooth_book::buy_yes/buy_no this time)
        sooth_market::cpi::transfer_fee_to_market_pool_from_book(..., amount)?;
        book.pending_fees = 0;
    }
    Ok(())
}
```

**Note on the second transfer helper.** W2b's `transfer_fee_to_market_pool` is parent-ix-gated against `sooth_amm::sell_positions`. The flush from `sooth_book` needs the same vault-authority signing but gated against `sooth_book::buy_yes` / `buy_no` discriminators. **You have two options — pick one and document the choice in the commit message:**

1. Extend the existing `transfer_fee_to_market_pool` ix to accept either parent-ix family. The gate becomes "if parent is sooth_amm, require SELL_POSITIONS_DISCRIMINATOR; if parent is sooth_book, require BUY_YES or BUY_NO". Single ix, two-call-site gate.
2. Add a sibling `transfer_fee_to_market_pool_from_book` ix gated only on sooth_book parents (single-load gate via the new `require_sooth_book_cpi_parent` helper).

**Option 2 is cleaner** (single-load gate matches the rest of the sooth_book CPI auth pattern), but adds a second ix + discriminator. Lean toward 2 unless the duplication feels gratuitous.

### E. Integrate the matcher into `buy_handler` (§5 step 4)

Modify `programs/sooth_book/src/instructions/buy.rs` to insert step 4 between W3's existing step 3 (escrow predebit) and step 5 (dust check):

```rust
// ── 4. Auto-match (NEW in W4)
let remaining = match_buy(
    &mut ctx.accounts.market_book, side, tick, amount, escrow, match_limit,
    ctx.remaining_accounts,
)?;

if remaining == 0 {
    flush_accumulators(&mut ctx.accounts.market_book, &ctx)?;
    return Ok(());
}
let amount_to_rest = remaining;

// ── 5. Dust check (W3, now applied to `amount_to_rest` not `amount`)
let value_tick = if escrow { NUM_TICKS - tick } else { tick };
if amount_to_rest < min_resting_order_for_tick(value_tick) {
    if escrow {
        // Refund the predebit on the REMAINING amount only (the matched portion
        // was already credited to the taker via fill_order's share credit).
        sooth_market::cpi::credit_shares_for_order(..., amount_to_rest)?;
    }
    emit!(DustOrderSkipped { ... });
    flush_accumulators(...)?;
    return Ok(());
}

// ── 6. Resting deposit (W3, applied to amount_to_rest)
if !escrow {
    let resting_cost_base = wad_to_base(amount_to_rest * tick as u128 / NUM_TICKS as u128);
    sooth_market::cpi::deposit_for_order(..., resting_cost_base)?;
}

// ── 7+8. enqueue + bitmap set (W3, on amount_to_rest)
// ── 9. flush_accumulators (W4, replaces W3's no-op stub)
```

### F. Fee floor-on-sum verification (§7.3)

W2a's `fill_order` already implements floor-on-sum per spec §7.3:

```
takerBaseCost   = wad_to_base(baseCostWad)
takerCostPlusFee = wad_to_base(baseCostWad + feeWad)
feeBaseUnits    = takerCostPlusFee - takerBaseCost
```

**W4 verifies this against EVM golden-case fixtures.** Add `programs/sooth_market/tests/fee_rounding_golden.rs`:

1. Generate ≥10 golden test vectors from EVM `OrderEngine._collectTakerCostAndFee` covering the dust corners:
   - `baseCostWad` = 1 (smallest), 1e11, 1e12 (exactly 1 base unit), 1e12+1, 1e18, max
   - `feeWad` covers a spectrum that makes `floor(cost+fee)` vs `floor(cost)+floor(fee)` differ
   - Compute the expected `fee_base_units` per the EVM formula
2. Solana implementation must match each fixture to the base unit. Mismatch = test fail.

Suggest fixtures via a small TypeScript script that uses the EVM contract's actual formula:

```ts
// scripts/gen-fee-fixtures.ts
const fixtures = [
  { baseCostWad: 1n, feeWad: 1n, expectedFeeBase: 0n },
  { baseCostWad: 999999999999n, feeWad: 1n, expectedFeeBase: 0n },
  { baseCostWad: 999999999999n, feeWad: 2n, expectedFeeBase: 1n }, // sum crosses 1e12
  // ... 10+ rows
];
```

Commit the fixture table as a Rust test array (no runtime script needed).

### G. CU budget measurement (§11 W4 acceptance hint)

The W8 dispatch will lock the CU ceiling. W4's job is to **measure** the actual CU per buy ix with `match_limit=3` worst case (3 escrow makers + surplus + fee flush). Use `cargo test-sbf`'s built-in CU reporting, or extend the existing `_spikes/lmsr-cu/` pattern. Print the measured CU in the test output; commit the result as a comment in the test file.

Target documented in spec §11 W8: ≤ 800k CU per 3-fill tx. W4 doesn't enforce yet (that's W8's job), but measure + document.

### H. Tests

`programs/sooth_book/tests/matching.rs`:

1. **match_limit_unlimited** — `match_limit_arg = 0` → matcher loops until bitmap exhausted or remaining == 0. Set up a tick with 3 makers, taker buys all 3, assert all fills land + bitmap clears.
2. **match_limit_three_bounded** — `match_limit_arg = 3` → matcher exits after 3 fills even if more makers exist at later ticks.
3. **zero_bundles_no_cross** — taker tick below all maker ticks (no crossing). `remaining_accounts.len() == 0`. Order rests cleanly via the W3 path.
4. **missing_crossing_book_side** — pass a bundle whose BookSide seeds point at the wrong (opp_side, opp_tick) → `MissingCrossingBookSide`.
5. **maker_account_mismatch** — pass a bundle whose maker OrderbookPosition.user ≠ first live order's maker → `MakerAccountMismatch`.
6. **wrong_bundle_arity** — `remaining_accounts.len() == 4` (not multiple of 5) → `WrongBundleArity`.
7. **bitmap_walk_correctness** — populate ticks 100, 200, 300; taker tick 700 (NUM_TICKS - 700 = 300, min_opp_tick); matcher walks 300 → 200 → 100, fills all, asserts bitmap.bit(side ^ 1, 100/200/300) all cleared.
8. **fill_order_return_data_decoded** — assert `book.pending_fees` increments after each fill matches the floor-on-sum delta returned by `fill_order`.

Plus the **golden fixture file** from F above.

---

## Acceptance gates

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test -p sooth_book
NO_DNA=1 cargo test -p sooth_market
NO_DNA=1 cargo test -p sooth_market fee_rounding_golden -- --nocapture
NO_DNA=1 anchor build
```

The fee-rounding golden fixtures MUST pass byte-exact. Off-by-one is a parity break.

---

## Out of scope

- `distribute_fees` per-market redesign + `distribute_fees_legacy` → W5.
- `mint_complete_set_for_orderbook` etc. → W6.
- SDK adapter rewrite (cancel-path + multi-tx matching driver) → W7.
- E2E test fixes against Surfpool → W8.
- Devnet redeploy.

---

## Operational rules

- Branch: `feat/sooth_book-w4-matching` off current `main`.
- Suggested commit split:
  1. `feat(sooth_market): promote FillReturnData to public re-export`
  2. `feat(sooth_book): set_return_data decode helper + new error variants`
  3. `feat(sooth_book): match_buy + match_at_tick + bundle validation`
  4. `feat(sooth_market): transfer_fee_to_market_pool_from_book (single-load gate)` — IF you picked option 2 in section D
  5. `feat(sooth_book): flush_accumulators + integrate matcher into buy_handler`
  6. `test(sooth_market): EVM fee-rounding golden fixtures`
  7. `test(sooth_book): matching engine — 8 scenarios + bundle errors`
- **Do NOT push, tag, amend, or use `--no-verify`.** `NO_DNA=1` prefix.
- **Stop and ask** for:
  - The fee-rounding golden fixture format if the EVM formula is non-obvious to extract.
  - The W2b `transfer_fee_to_market_pool` extension choice in section D (option 1 vs option 2) if neither feels right.
  - Any divergence from spec §6 / §7 the implementation forces — these are EVM-parity load-bearing.

## When done

One-line per-gate pass/fail summary. Include the measured CU per 3-fill worst-case buy in the summary. Stop.
