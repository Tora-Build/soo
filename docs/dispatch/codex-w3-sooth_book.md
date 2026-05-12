# W3 dispatch — `BookSide` PDA + `InlineOrder` + place/cancel ix

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop after the
> acceptance gates pass; Claude reviews + pushes; do not push to
> origin from inside Codex.

W3 adds the per-tick resting-order book and the user-facing place / cancel ix on `sooth_book`. No matching engine yet — that's W4. Order placement walks straight into the resting path; cancel marks `amount = 0`. Estimated runtime: 25–35 minutes (similar to W2a).

---

## Context (read first)

1. **`docs/spec/sooth_book.md`**:
   - §3.2 (`BookSide` PDA + lifecycle + rent model)
   - §3.3 (`InlineOrder` packed layout)
   - §4.1 user-facing ix table (focus on `buy_yes` / `buy_no` /`cancel` / `cancel_by_id` / `compact_book_side` / `close_book_side` rows)
   - §4.4 composite `order_id` codec (already shipped W1 — reuse)
   - §5 buy ix pseudocode — **W3 implements steps 1, 2, 7, 8 only**. Steps 3–6 (escrow predebit, match, dust, resting deposit) defer to W4. With matching off, every order rests; the dust check in step 5 still applies; the resting-deposit step 6 also applies for non-escrow.
   - §7.1 `min_resting_order_for_tick` (used by W3 — dust check on the resting path)
   - §7.2 escrow `valueTick` rule
   - §7.4 deadline guards
   - §9.1 deletion table (Monaco vendor) — already done in W1; reference only
2. **`packages/programs-core/programs/sooth_book/src/state/market_book.rs`** + **`state/order_id.rs`** — shipped W1. Reuse.
3. **`packages/programs-core/programs/sooth_market/src/instructions/{deposit_for_order,credit_shares_for_order,debit_shares_for_order_before_deadline}.rs`** — shipped W2a. Reuse via CPI.
4. **`packages/programs-core/programs/sooth_amm/src/instructions/trade_positions.rs:115-135`** — pattern for `has_one` + seeds bindings to `Market` and `AmmState`.

---

## Scope

### A. `BookSide` PDA + `InlineOrder` (sooth_book::state)

New file `programs/sooth_book/src/state/book_side.rs`:

```rust
pub const MAX_ORDERS_PER_TICK: usize = 50;

#[account]
pub struct BookSide {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub head_index: u32,
    pub orders: Vec<InlineOrder>,  // realloc-grown, capped at 50
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InlineOrder {
    pub id: u64,
    pub maker: Pubkey,
    pub amount: u128,
    pub escrow: bool,
    pub _pad: [u8; 3],
}
```

Spec §3.2 byte math: header 51 B, each `InlineOrder` 60 B. `BookSide::space_for(n_orders: usize)` helper returning `51 + 60 * n_orders`. Re-export from `state/mod.rs`.

Seeds: `[b"book_side", market.market_id.as_ref(), &[side], &tick.to_le_bytes()]`.

### B. Bitmap helpers in sooth_book

The W1 `MarketBook::bitmap` / `bitmap_mut` exists. Verify the helper covers `set_bit(tick)` + `clear_bit(tick)` use here. No new bitmap code needed unless missing.

### C. Order-id seed-binding helper

Add a small helper (place in `state/order_id.rs` or a new `instructions/order_id_ix.rs`):

```rust
pub fn require_order_id_matches(order_id: u64, side: u8, tick: u16) -> Result<()> {
    let (decoded_side, decoded_tick, _seq) = decode_order_id(order_id)?;
    require!(decoded_side == side && decoded_tick == tick,
             CoreError::OrderIdSeedMismatch);
    Ok(())
}
```

`CoreError::OrderIdSeedMismatch` already exists from W1.

### D. User-facing ix on `sooth_book`

Five new ix files under `programs/sooth_book/src/instructions/`:

#### D.1 `buy.rs` — shared body for `buy_yes` / `buy_no`

```rust
pub fn buy_handler(ctx, side: u8, tick: u16, amount: u128, escrow: bool,
                   match_limit_arg: u32) -> Result<()> {
    // §5 step 1: Validation
    require!((MIN_TICK..=MAX_TICK).contains(&tick), CoreError::InvalidTick);
    require!(amount > 0, CoreError::ZeroAmount);
    require_clock_before_deadline(&ctx.accounts.market)?;

    // §5 step 2: MarketBook lazy-init + accumulator invariant
    let book = &mut ctx.accounts.market_book;
    if book.market == Pubkey::default() {
        book.market = ctx.accounts.market.key();
        book.base_token_mint = ctx.accounts.market_usdc_vault.mint;
        require_keys_eq!(book.base_token_mint, BASE_TOKEN_MINT, CoreError::WrongBaseMint);
        book.registrar = SOOTH_BOOK_PROGRAM_ID;
        book.next_order_id = 1;
        book.pending_fees = 0;
        book.pending_taker_payout = 0;
    }
    require_keys_eq!(book.base_token_mint, ctx.accounts.market_usdc_vault.mint,
                    CoreError::BaseMintDrift);
    require!(book.pending_fees == 0 && book.pending_taker_payout == 0,
             CoreError::AccumulatorNotReset);

    // §5 steps 3-6 (escrow predebit, match, dust check, resting deposit):
    // W3 SKIPS matching entirely. Order goes straight to resting.
    // - escrow predebit (step 3): YES — call sooth_market::debit_shares_for_order_before_deadline
    //   so escrow makers' shares are actually locked when their order rests.
    // - match (step 4): SKIP. W3 has no matcher — match_limit_arg is unused for now;
    //   parse it but document that W3 ignores it.
    // - dust check (step 5): YES, applied to the FULL amount since none was matched.
    //   Mirrors the post-match dust step in §5.
    // - resting deposit (step 6): YES, applied to the FULL amount for non-escrow.
    let value_tick = if escrow { NUM_TICKS - tick } else { tick };
    if amount < min_resting_order_for_tick(value_tick) {
        if escrow {
            sooth_market::cpi::credit_shares_for_order(...)?;  // refund the predebit
        }
        emit!(DustOrderSkipped { ... });
        return Ok(());  // accumulators stay at 0; no flush needed
    }

    if !escrow {
        let resting_cost_base = wad_to_base(amount * tick as u128 / NUM_TICKS as u128);
        sooth_market::cpi::deposit_for_order(ctx_for_deposit, resting_cost_base)?;
    }

    // §5 step 7: per-tick cap + enqueue
    let book_side = &mut ctx.accounts.book_side;
    require!(book_side.orders.len() < MAX_ORDERS_PER_TICK, CoreError::BookSideFull);
    let seq = book.next_order_id;
    let order_id = encode_order_id(side, tick, seq);
    book.next_order_id = seq.checked_add(1).ok_or(CoreError::MathOverflow)?;
    book_side.orders.push(InlineOrder { id: order_id, maker: ctx.accounts.taker.key(),
                                         amount, escrow, _pad: [0; 3] });

    // §5 step 8: bitmap set + event
    book.bitmap_mut(side).set_bit(tick);
    emit!(OrderPlaced { market, side, tick, maker: taker, amount, escrow, order_id });

    // §5 step 9: flush accumulators — W3 accumulators are always 0 (no matching),
    // so the flush is a no-op. Keep the call site as a stub for W4 to wire properly.
    Ok(())
}
```

**Accounts struct `BuyOrder`**: signer `taker`, `market` (sooth_market::Market, has_one), `market_book` (init_if_needed, payer=taker, space=MarketBook::SPACE, seeds=[b"market_book", market.market_id]), `book_side` (init_if_needed, payer=taker, space=BookSide::space_for(1), realloc with `realloc::zero=false` if appending), `market_usdc_vault`, `taker_orderbook_position` (init_if_needed for the maker side — wait, for buy_yes the taker IS the maker who places the resting order; need OrderbookPosition for that user), required CPI accounts for `deposit_for_order` + `debit_shares_for_order_before_deadline` + `credit_shares_for_order`, `instructions_sysvar`, `system_program`, `token_program`, `sooth_market_program`.

Two thin ix `buy_yes` / `buy_no` that wrap `buy_handler` with `side = SIDE_FOR` / `SIDE_AGAINST` respectively. Discriminators (`SOOTH_BOOK_BUY_YES_DISCRIMINATOR` / `SOOTH_BOOK_BUY_NO_DISCRIMINATOR`) already in W1's types crate.

#### D.2 `cancel.rs` — linear scan from head

```rust
pub fn cancel(ctx, side: u8, tick: u16) -> Result<()> {
    let book = &mut ctx.accounts.market_book;
    let book_side = &mut ctx.accounts.book_side;
    let signer = ctx.accounts.user.key();

    // Linear scan from head_index forward; cancel the FIRST live order owned by signer.
    let mut head = book_side.head_index as usize;
    while head < book_side.orders.len() && book_side.orders[head].amount == 0 {
        head += 1;
    }
    book_side.head_index = head as u32;

    let mut found = None;
    for i in head..book_side.orders.len() {
        if book_side.orders[i].amount > 0 && book_side.orders[i].maker == signer {
            found = Some(i);
            break;
        }
    }
    let idx = found.ok_or(CoreError::NoCancellableOrder)?;
    let order = book_side.orders[idx];

    // Refund per spec §8.3
    if order.escrow {
        sooth_market::cpi::credit_shares_for_order(ctx_credit, signer, side ^ 1, order.amount)?;
    } else {
        let refund_base = wad_to_base(order.amount * tick as u128 / NUM_TICKS as u128);
        sooth_market::cpi::withdraw_for_order(ctx_withdraw, signer, refund_base)?;
    }

    book_side.orders[idx].amount = 0;

    // If this was the only remaining live order, clear the bitmap bit
    if book_side.orders[head..].iter().all(|o| o.amount == 0) {
        book.bitmap_mut(side).clear_bit(tick);
    }

    emit!(OrderCancelled { market, side, tick, maker: signer, order_id: order.id });
    Ok(())
}
```

Cancel paths are NOT deadline-guarded (per spec §4.2 + §7.4 — cancel must work post-deadline). The internal CPIs into `withdraw_for_order` / `credit_shares_for_order` either skip the deadline gate (for `credit_shares_for_order`) or hit it (for `withdraw_for_order`). **Wait — `withdraw_for_order` has the deadline guard set to NO per spec §4.2.** Confirm by reading the W2a-shipped file before relying on this.

#### D.3 `cancel_by_id.rs` — direct lookup via composite id

```rust
pub fn cancel_by_id(ctx, order_id: u64, side: u8, tick: u16) -> Result<()> {
    // Seed binding: the Accounts struct binds book_side seeds to (side, tick).
    // Body asserts decoded_order_id matches:
    require_order_id_matches(order_id, side, tick)?;

    let book_side = &mut ctx.accounts.book_side;
    let signer = ctx.accounts.user.key();

    let idx = book_side.orders.iter().position(|o|
        o.id == order_id && o.amount > 0 && o.maker == signer
    ).ok_or(CoreError::NoCancellableOrder)?;

    // Refund + bitmap clear (same as cancel.rs)
    // ...
}
```

Same Accounts struct shape as `cancel` but with `#[instruction(_order_id, side, tick)]` binding to seeds (spec §4.4). Discriminator `SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR` already in types.

#### D.4 `compact_book_side.rs` — permissionless trailing-zero sweep

```rust
pub fn compact_book_side(ctx, max_drops: u8) -> Result<()> {
    require!(max_drops <= 16, CoreError::CompactBoundExceeded);
    let book_side = &mut ctx.accounts.book_side;

    // Drop trailing amount=0 orders, bounded.
    let mut dropped: u8 = 0;
    while dropped < max_drops && book_side.orders.last().map_or(false, |o| o.amount == 0) {
        book_side.orders.pop();
        dropped += 1;
    }
    // Anchor handles the realloc-shrink automatically when the vec serializes.
    Ok(())
}
```

Permissionless (any signer). No CPI. Just shrinks the vec.

#### D.5 `close_book_side.rs` — permissionless full-drain close

```rust
pub fn close_book_side(ctx) -> Result<()> {
    let book = &ctx.accounts.market_book;
    let book_side = &ctx.accounts.book_side;

    // Must be fully drained: head_index == orders.len() AND bitmap bit clear
    require!(book_side.head_index as usize == book_side.orders.len(),
             CoreError::BookSideNotDrained);
    require!(!book.bitmap(book_side.side).is_set(book_side.tick),
             CoreError::BookSideNotDrained);
    // Anchor close = closer (residual rent → invoker, per spec §3.2)
    Ok(())
}
```

Accounts struct with `#[account(mut, close = closer)]` on `book_side`. Permissionless.

### E. Events

Add `events.rs` (or a new file) with:

```rust
#[event]
pub struct OrderPlaced { ... }
#[event]
pub struct OrderCancelled { ... }
#[event]
pub struct DustOrderSkipped { ... }
```

Field shape per spec §5 / §6 / §8 emit calls. `event!` macros require Anchor.

### F. New errors

Add to `error.rs`:

- `ZeroAmount`
- `BookSideFull`
- `BookSideNotDrained`
- `CompactBoundExceeded`
- `WrongBaseMint`
- `BaseMintDrift`
- `AccumulatorNotReset`
- `NoCancellableOrder`

### G. Tests

`programs/sooth_book/tests/place_cancel.rs` integration tests via LiteSVM (mirror W2a's `sooth_book_cpi_gate.rs` pattern):

1. **place_at_empty_tick** — first order at a fresh (market, side, tick) inits BookSide + sets bitmap.
2. **append_at_populated_tick** — second order at the same tick reallocs BookSide +60 B; both orders present; `head_index == 0`.
3. **cap_rejects_51st_order** — 51st order at the same tick → `BookSideFull`.
4. **cancel_marks_amount_zero** — cancel zeroes the entry; rent stays in BookSide (no Anchor close-on-cancel).
5. **cancel_by_id_seed_mismatch** — wrong (side, tick) passed → `OrderIdSeedMismatch`.
6. **compact_drops_trailing_zeros** — set first three orders to amount=0, run `compact_book_side(3)`, assert vec length shrunk by 3 (not the middle ones — only trailing).
7. **compact_max_drops_bounded** — set 20 trailing zeros, run `compact_book_side(16)`, assert exactly 16 dropped.
8. **close_rejects_when_not_drained** — try close with `head_index < orders.len()` → `BookSideNotDrained`.
9. **close_succeeds_when_drained** — drain fully, clear bitmap, run close, assert PDA closed and rent returned to closer.
10. **dust_credit_back_for_escrow** — place an escrow order below `min_resting_order_for_tick(value_tick)`; assert refund via `credit_shares_for_order`, no BookSide created, no bitmap change.

### H. SDK UX disclosure copy (one file)

Per spec §9.2: SDK + demo UX must explain the pooled-rent model (cancel does NOT refund rent; rent stays until close). W3 lands the docs only — actual SDK + demo wiring is W6 / W7.

Create `packages/sdk-solana/docs/orderbook-cancel-ux.md` (or extend an existing UX doc) with the prose:

> When you cancel an orderbook order on Solana, **you do not receive a rent refund**. Rent for the `BookSide` resting-order container is pooled across all makers at that tick. The rent is returned only when the entire tick drains (zero live orders) and someone — including you — calls `close_book_side` to close the account. This breaks the convention from the AMM `Position` model where rent IS refunded on close.

Include a one-paragraph "for the curious" pointer to spec §3.2 explaining the design tradeoff vs Monaco/EVM. ~30 lines.

---

## Acceptance gates

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test -p sooth_book
NO_DNA=1 cargo test -p sooth_market
NO_DNA=1 anchor build
```

All `place_cancel.rs` tests pass. Existing `sooth_market::sooth_book_cpi_gate` tests still pass (W3 doesn't touch the gate).

---

## Out of scope (DO NOT do in W3)

- Auto-matching engine (`match_buy` / `match_at_tick`) — W4.
- Fee floor-on-sum rule — W4.
- `set_return_data` / `get_return_data` accumulator pattern — W4.
- `mint_complete_set_for_orderbook` etc. — W6.
- SDK helper rewrites — W7.
- Devnet redeploy.

---

## Operational rules

- Branch: `feat/sooth_book-w3-place-cancel` off current `main`.
- Suggested commit split:
  1. `feat(sooth_book): BookSide PDA + InlineOrder layout`
  2. `feat(sooth_book): events + new error variants`
  3. `feat(sooth_book): buy_yes / buy_no — place-only path (no matching yet)`
  4. `feat(sooth_book): cancel + cancel_by_id`
  5. `feat(sooth_book): compact_book_side + close_book_side`
  6. `test(sooth_book): place / cancel / compact / close integration suite`
  7. `docs(sdk-solana): pooled-rent UX disclosure for orderbook cancel`
- **Do NOT push, tag, amend, or use `--no-verify`.** `NO_DNA=1` prefix everywhere.
- If the `min_resting_order_for_tick` formula or the escrow-credit-back ordering is unclear, **stop and print a question to stdout**. The §7 rules are EVM-parity load-bearing.

## When done

One-line per-gate pass/fail summary. Stop. Claude reviews + pushes.
