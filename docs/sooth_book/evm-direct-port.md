# SoothBook EVM-Direct Port — Implementation Spec

> Status: **implementation-ready**, 2026-05-11.
> Direction: direct port of EVM `SoothBook.sol`; on-chain CLOB only (Path A); Monaco vendor deleted.
> Supersedes [`docs/sooth_book/fork-plan.md`](./fork-plan.md).
> Companion to [`docs/research/ladder-vs-density.md`](../research/ladder-vs-density.md).
> Within Path A fee/accounting/matching: no parity gaps. Out of scope: Path B (signed orders), T\* retroactive settlement, TruthMarket `invalidate()` parity — see §15.

---

## 1. Why this exists

The Monaco fork (in-flight W1–W6) shipped the matching primitives but inherited Monaco's design tax — per-order PDAs, `MarketLiquidities` aggregate, `PriceLadder` PDA, `MarketOrderRequestQueue`, `OrderStatus` enum, 12-field `Order`. The cost envelope was incompatible with the founder's <$50 hard cap on market creation (Monaco at density=100 hits ~$15 empty / ~$1,940 saturated).

EVM `SoothBook.sol` is structurally simpler — ~600 LOC, 4-field `Order`, no aggregate, lazy-delete via `amount=0`, two-level bitmap, separation of matching (SoothBook) from custody (OrderEngine). Mirroring EVM directly on Solana is shorter, cheaper, and stays inside the cost cap with 60× headroom.

**EVM source mirrored:**

- `sooth-alpha/packages/contracts-core/src/SoothBook.sol` — matching engine, 678 LOC
- `sooth-alpha/packages/contracts-core/src/OrderEngine.sol` — custody/settlement (Path A `fillOrder` only; Path B `matchSignedOrders` deferred per §15)
- `sooth-alpha/packages/contracts-core/src/libraries/TickBitmap.sol` — two-level bitmap
- `sooth-alpha/packages/contracts-core/src/TruthMarket.sol` — lifecycle (already mirrored in `sooth_market`)
- `sooth-alpha/packages/contracts-core/src/AMMEngine.sol` — for `_marketCollateral` parity, achieved structurally via per-market `MarketFeePool` rather than an accumulator field

---

## 2. Architecture overview

```
sooth_book (rewrite)                       sooth_market (extended)
───────────────────────                    ─────────────────────────
MarketBook PDA × 1/market                  Existing:
  bitmap_for [u64; 16] (1024 bits)           market lifecycle (LIVE/RESOLVING/...)
  bitmap_against [u64; 16]                   complete-set mint/merge
  next_order_id, pending_fees,               redeem (post-settle)
  pending_taker_payout                       custody (USDC vault, position PDAs)
  base_token_mint (← market_usdc_vault.mint)

BookSide PDA × N/(market, side, tick)      NEW (filler-only via parent-ix CPI auth):
  Lazy-init on first order                   fill_order(...) → returns (fee_base, taker_payout_delta)
  Permissionless close/compact ix            deposit_for_order / withdraw_for_order
  head_index: u32 (lazy-delete head)         credit_shares_for_order
  orders: Vec<InlineOrder>                   debit_shares_for_order_before_deadline
  (realloc-grow, capped at 50/tick)
                                           NEW user-facing on OrderbookPosition:
InlineOrder (60 B packed)                    OrderbookPosition PDA × 1/(market, user)
  id u64 (composite: side|tick|seq)          mint_complete_set_for_orderbook
  maker Pubkey                                merge_complete_set_for_orderbook
  amount u128, escrow bool                    redeem_orderbook

sooth_launchpad (extended)                 sooth_amm (one-line fee redirect)
──────────────────────                     ───────────────────────────────────
MarketFeePool × 1/market                   trade_positions SPL transfer
  Lazy-init by first AMM or book fee         destination: global → per-market pool
  TokenAccount, USDC mint                    (sell-path fee wiring added)
  Authority = fee_pool_authority singleton

distribute_fees(market) — per-market crank
distribute_fees_legacy — one-time global drain on deploy day
```

**Mapping to EVM:**

| EVM                                                            | Solana                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mapping(market => mapping(side => bitmap))`                   | `MarketBook.bitmap_for` / `bitmap_against`                                                                   |
| `mapping(market => mapping(side => mapping(tick => Order[])))` | `BookSide` PDA per (market, side, tick)                                                                      |
| `mapping(... => uint256) _orderHead`                           | `BookSide.head_index`                                                                                        |
| `mapping(uint64 => OrderPointer)`                              | Composite `order_id` (no separate index — §4.4)                                                              |
| `OrderEngine.fillOrder`                                        | `sooth_market::fill_order` (CPI-only, parent-ix gated; **returns deltas**, does not mutate sooth_book state) |
| `OrderEngine._positions[market][user]`                         | `sooth_market::OrderbookPosition` (split from existing AMM `Position`)                                       |
| `AMMEngine._marketCollateral[market]`                          | Per-market `MarketFeePool` token-account balance (Solana reads natively; no accumulator field needed)        |

**Sealevel parallelism:** across markets parallel (different `MarketBook` PDAs). Within one market, matching contends on `MarketBook` for bitmap writes and `next_order_id` increments — acceptable, matches EVM single-contract serialization.

---

## 3. Data model

### 3.1 `MarketBook` (one PDA per orderbook-enabled market, owned by `sooth_book`)

```rust
#[account]
pub struct MarketBook {
    pub market: Pubkey,                  // bound to sooth_market::Market PDA
    pub base_token_mint: Pubkey,         // copied from market_usdc_vault.mint at lazy-init
    pub registrar: Pubkey,               // sooth_book program id (for audit-readable provenance)
    pub next_order_id: u64,              // monotonic; 40 of 64 bits used for sequence
    pub bitmap_for: [u64; 16],           // 1024 bits; ticks 1..999 use 1000
    pub bitmap_against: [u64; 16],
    pub pending_fees: u128,              // base-unit accumulator; flushed end-of-buy ix
    pub pending_taker_payout: u128,      // base-unit accumulator; flushed end-of-buy ix
    pub _reserved: [u8; 32],
}
// Total: 8 + 32 + 32 + 32 + 8 + 128 + 128 + 16 + 16 + 32 = 432 B → ~$0.42 rent
```

**Seeds:** `[b"market_book", market.market_id.as_ref()]`.
**Owner:** `sooth_book` program.
**Init:** lazy via `init_if_needed` on first `sooth_book::buy_yes`/`buy_no` after AMM graduation. First orderbook user pays the rent.

**Accumulator ownership rule (load-bearing):** `pending_fees` and `pending_taker_payout` are written ONLY by `sooth_book` ix bodies (the owner). `sooth_market::fill_order` does NOT mutate these fields — it returns `(fee_base_delta, taker_payout_delta)` to the caller, and `sooth_book::buy_yes`/`buy_no` accumulate the deltas into MarketBook itself. This obeys Solana's rule that only the owning program can write account data.

### 3.2 `BookSide` (one PDA per populated `(market, side, tick)`, owned by `sooth_book`)

```rust
#[account]
pub struct BookSide {
    pub market: Pubkey,                  // for has_one binding
    pub side: u8,
    pub tick: u16,
    pub head_index: u32,                 // EVM _orderHead — lazy-delete head pointer
    pub orders: Vec<InlineOrder>,        // realloc-grow on enqueue, capped at 50
}
// Header: 51 B → ~$0.050 rent (empty)
// Each InlineOrder: 60 B → ~$0.058 per order
```

**Seeds:** `[b"book_side", market.market_id.as_ref(), &[side], &tick.to_le_bytes()]`.
**`MAX_ORDERS_PER_TICK = 50`** — bounds `cancel_by_id` linear scan. Enqueue past cap returns `BookSideFull`. Mirrors Monaco's `Cirque::QUEUE_LENGTH=50` precedent.

**Lifecycle:**

- Created lazily on first order at this `(market, side, tick)`. Placer pays header + first slot rent.
- Realloc-grown on enqueue. Each subsequent order adds 60 B; new placer pays delta. Capped at 50.
- **Rent is pooled, not per-order-tracked.** Cancellation marks `amount=0`; rent stays in PDA.
- Permissionless `compact_book_side(max_drops: u8)` ix sweeps trailing `amount=0` slots (bounded ≤16 per call to stay under realloc cost).
- Permissionless `close_book_side` ix closes the PDA when `head_index == orders.len()` AND bitmap bit cleared (fully drained). **Residual lamports go to whoever invokes the close ix** (any user); standard `close = closer` Anchor pattern. Mild unfairness vs original placers is bounded; not load-bearing.

This is a deliberate parity break with EVM gas refunds. Placer-paid rent is the dominant dust deterrent.

### 3.3 `InlineOrder` (60 B packed, stored inside `BookSide.orders`)

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InlineOrder {
    pub id: u64,                  // composite — see §4.4
    pub maker: Pubkey,            // EVM Order.maker
    pub amount: u128,             // shares remaining (WAD); 0 = lazy-deleted
    pub escrow: bool,             // EVM Order.escrow
    pub _pad: [u8; 3],
}
// 8 + 32 + 16 + 1 + 3 = 60 B
```

Mirrors EVM `Order` struct 1:1. No `OrderStatus` enum — `amount = 0` is the deleted/filled marker.

### 3.4 `OrderbookPosition` (one PDA per `(market, user)`, owned by `sooth_market`)

```rust
#[account]
pub struct OrderbookPosition {
    pub market: Pubkey,
    pub user: Pubkey,
    pub yes_shares: u128,         // WAD
    pub no_shares:  u128,         // WAD
    pub _reserved:  [u8; 16],
}
// 8 + 32 + 32 + 16 + 16 + 16 = 120 B → ~$0.10 rent (refundable on redeem-close)
```

**Seeds:** `[b"orderbook_position", market.market_id.as_ref(), user.as_ref()]`.
Mirrors EVM `OrderEngine._positions[market][user]`. **Separate from existing `sooth_market::Position`** (which stays AMM-only — LMSR shares + locked sell proceeds). Decoupling matches EVM's `OrderEngine._positions` vs `AMMEngine._positions` split.

### 3.5 `MarketFeePool` (one TokenAccount per market, owned by `sooth_launchpad`)

```rust
// SPL TokenAccount (165 B) — not a custom Anchor account
//   mint = market_usdc_vault.mint (validated against `sooth_protocol_types::ids::USDC_MINT_DEVNET` at init)
//   owner = fee_pool_authority PDA (existing singleton at [b"fee_pool_authority"])
```

**Seeds:** `[b"market_fee_pool", market.market_id.as_ref()]`.
**Owning program:** `sooth_launchpad::ID`. All producers (`sooth_amm`, `sooth_book`, `sooth_market`) derive the address against `sooth_launchpad::ID` and `require_keys_eq!` against the passed account.
**Init:** lazy via new `sooth_launchpad::init_market_fee_pool(market)` ix on first need (AMM trade post-graduation OR first orderbook ix, whichever fires first). ~$0.18 rent.

EVM's `_marketCollateral[market]` accumulator is replaced by Solana's native read of this token balance.

---

## 4. Instruction surface

### 4.1 User-facing (`sooth_book` and `sooth_market`)

| ix                                                   | Program        | EVM equivalent                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | -------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buy_yes(market, tick, amount, escrow, match_limit)` | `sooth_book`   | `SoothBook.buyYes`             | `_buy(side=1, ...)`. SDK default `match_limit = 3` — see §11 budget. **`match_limit == 0` is treated as `u32::MAX`** (the matcher loops until bitmap exhausted or `remaining=0`) for EVM-parity semantics (`SoothBook.sol:477-478`). On Solana the effective per-tx ceiling is ~3 fills, bounded by the 32-writable-account cap. **EVM-equivalent partial-cross behavior:** if `match_limit` OR the SDK-provided `remaining_accounts` bundle count is exhausted with `amount > 0`, the unmatched remainder rests on the taker's tick (per §5 step 7) — same as EVM `_buy` after `_match` returns with positive `remaining`. The SDK is responsible for deciding whether to re-submit in a follow-up tx with fresh bundles. |
| `buy_no(market, tick, amount, escrow, match_limit)`  | `sooth_book`   | `SoothBook.buyNo`              | `_buy(side=0, ...)`. Same default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cancel(market, side, tick)`                         | `sooth_book`   | `SoothBook.cancel`             | Linear scan from head, mark `amount=0`. No rent refund (see §3.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cancel_by_id(order_id, side, tick)`                 | `sooth_book`   | `SoothBook.cancelById`         | `order_id` composite u64 + `(side, tick)` args for Anchor seed binding. Body asserts `decode_order_id(order_id) == (side, tick, _)`. See §4.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `compact_book_side(max_drops: u8)`                   | `sooth_book`   | (none — Solana-native cleanup) | Permissionless; drops trailing `amount=0` slots, bounded ≤16 per call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `close_book_side`                                    | `sooth_book`   | (none — Solana-native cleanup) | Permissionless; closes drained `BookSide`. Residual lamports → closer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mint_complete_set_for_orderbook(market, amount)`    | `sooth_market` | `OrderEngine.mint`             | Pulls USDC, credits both yes/no on `OrderbookPosition`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `merge_complete_set_for_orderbook(market, amount)`   | `sooth_market` | `OrderEngine.merge`            | Burns equal yes/no on `OrderbookPosition`, returns USDC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `redeem_orderbook(market)`                           | `sooth_market` | `OrderEngine.settlePosition`   | Post-settle, redeems `OrderbookPosition` against winning outcome. Closes PDA on zero balance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 4.2 Filler-only ix on `sooth_market` (callable ONLY via CPI from `sooth_book`)

Gated by `require_sooth_book_cpi_parent(sysvar, &allowed_discriminators)`. This helper:

```rust
pub fn require_sooth_book_cpi_parent(
    sysvar: &AccountInfo,
    allowed_discriminators: &[[u8; 8]],
) -> Result<()> {
    require_keys_eq!(*sysvar.key, sysvar::instructions::ID, CoreError::InvalidSysvar);
    let current_index = ix_sysvar::load_current_index_checked(sysvar)? as usize;
    // From inside a CPI'd program, current_index returns the top-level ix's index.
    let parent_ix = ix_sysvar::load_instruction_at_checked(current_index, sysvar)?;
    require!(parent_ix.program_id == SOOTH_BOOK_PROGRAM_ID, CoreError::WrongCpiParent);
    let disc: [u8; 8] = parent_ix.data[..8].try_into()
        .map_err(|_| CoreError::WrongCpiDiscriminator)?;
    require!(allowed_discriminators.contains(&disc), CoreError::WrongCpiDiscriminator);
    Ok(())
}
```

This loads ONLY the instruction at `current_index` (no scan), so a bundled-but-unrelated `sooth_book` ix earlier in the tx cannot satisfy the gate.

| ix                                                                                           | EVM equivalent                          | Allowed parent discriminators                         | Deadline guard                      | Return                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| `fill_order(taker, maker, side, shares, taker_tick, maker_tick, taker_escrow, maker_escrow)` | `OrderEngine.fillOrder`                 | `sooth_book::{buy_yes, buy_no}`                       | YES                                 | `(fee_base_delta: u128, taker_payout_delta: u128)` — see §3.1 |
| `deposit_for_order(market, from, base_units)`                                                | `OrderEngine.deposit`                   | `sooth_book::{buy_yes, buy_no}`                       | YES                                 | ()                                                            |
| `withdraw_for_order(market, to, base_units)`                                                 | `OrderEngine.withdraw`                  | `sooth_book::{cancel, cancel_by_id}`                  | NO (cancel must work post-deadline) | ()                                                            |
| `credit_shares_for_order(market, user, outcome, amount)`                                     | `OrderEngine.creditShares`              | `sooth_book::{buy_yes, buy_no, cancel, cancel_by_id}` | NO                                  | ()                                                            |
| `debit_shares_for_order_before_deadline(market, user, outcome, amount)`                      | `OrderEngine.debitSharesBeforeDeadline` | `sooth_book::{buy_yes, buy_no}` (escrow predebit)     | YES                                 | ()                                                            |

Cancel paths use `credit_shares_for_order` only (escrow refund credits opposite shares back). No unconditional-debit variant is exposed.

### 4.3 Cross-program init (`sooth_launchpad`)

| ix                             | Caller                                                                               | Purpose                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `init_market_fee_pool(market)` | Permissionless; typically called by SDK before first AMM trade or first orderbook ix | Allocates per-market `MarketFeePool` TokenAccount (§3.5). |

`MarketBook` (sooth_book) and `BookSide` (sooth_book) and `OrderbookPosition` (sooth_market) are all lazy-init via `init_if_needed` inside their respective user-facing ix — no separate registration ix.

### 4.4 Composite `order_id` codec

EVM stores `_orderPointers[orderId] → (market, side, tick, index)` so `cancelById` only needs the id. Solana lacks free mappings; instead of allocating a per-order pointer PDA, we encode the seed components into the id:

```rust
fn encode_order_id(side: u8, tick: u16, seq: u64) -> u64 {
    debug_assert!(seq < (1u64 << 40));   // 40-bit sequence (~1.1T per market)
    debug_assert!(tick >= 1 && tick <= 999);
    debug_assert!(side <= 1);
    (seq & ((1 << 40) - 1))             // bits  0..40 sequence
        | ((tick as u64) << 40)          // bits 40..56 tick
        | ((side as u64) << 56)          // bits 56..64 side
}

fn decode_order_id(id: u64) -> Result<(u8, u16, u64)> {
    let seq  = id & ((1 << 40) - 1);
    let tick = ((id >> 40) & 0xFFFF) as u16;
    let side = ((id >> 56) & 0xFF) as u8;
    require!(side <= 1, CoreError::InvalidOrderId);
    require!(tick >= 1 && tick <= 999, CoreError::InvalidOrderId);
    Ok((side, tick, seq))
}
```

`cancel_by_id(order_id, side, tick)` accounts struct uses `#[instruction(_order_id, side, tick)]` to bind seeds at compile-time:

```rust
#[derive(Accounts)]
#[instruction(_order_id: u64, side: u8, tick: u16)]
pub struct CancelById<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"market_book", market.market_id.as_ref()], bump,
              has_one = market)]
    pub market_book: Account<'info, MarketBook>,
    #[account(mut, seeds = [b"book_side", market.market_id.as_ref(),
                             &[side], &tick.to_le_bytes()], bump,
              has_one = market)]
    pub book_side: Account<'info, BookSide>,
    pub market: Account<'info, sooth_market::Market>,
    // + sooth_market accounts for credit_shares_for_order or withdraw_for_order CPI
    // + USDC vault, ATAs, sooth_market program, sysvar instructions, system program
}
```

Body asserts `decode_order_id(order_id) == (side, tick, _)` at the top. Mismatch → `OrderIdSeedMismatch`. Client cannot tamper with seed routing.

**Order ids are per-market** (sequence lives in `MarketBook.next_order_id`). SDK and indexer always pair `order_id` with `market` Pubkey for global uniqueness.

---

## 5. End-to-end `buy_yes` / `buy_no` ix sequence

Mirrors EVM `SoothBook._buy` (`SoothBook.sol:407-463`):

```rust
fn buy(ctx, side: u8, tick: u16, amount: u128, escrow: bool, match_limit_arg: u32) -> Result<()> {
    // ── 1. Validation
    require!(tick >= MIN_TICK && tick <= MAX_TICK, CoreError::InvalidTick);
    require!(amount > 0, CoreError::ZeroAmount);
    require_clock_before_deadline(&ctx.accounts.market)?;

    // Match-limit semantics mirror EVM: 0 = unlimited (SoothBook.sol:477-478)
    let match_limit = if match_limit_arg == 0 { u32::MAX } else { match_limit_arg };

    // ── 2. MarketBook lazy-init + accumulator invariant
    if ctx.accounts.market_book.market == Pubkey::default() {
        let book = &mut ctx.accounts.market_book;
        book.market               = ctx.accounts.market.key();
        // Base mint is read from the existing per-market USDC vault account passed in
        // the Buy accounts struct (vault.mint is the canonical source). `sooth_market::Market`
        // does not carry a base_mint field today; the USDC vault's mint IS the market's base.
        book.base_token_mint      = ctx.accounts.market_usdc_vault.mint;
        require_keys_eq!(
            book.base_token_mint,
            sooth_protocol_types::ids::USDC_MINT_DEVNET,
            CoreError::WrongBaseMint
        );
        book.registrar            = sooth_protocol_types::ids::SOOTH_BOOK_PROGRAM_ID;
        book.next_order_id        = 1;
        book.pending_fees         = 0;
        book.pending_taker_payout = 0;
    }
    require!(
        ctx.accounts.market_book.pending_fees == 0
            && ctx.accounts.market_book.pending_taker_payout == 0,
        CoreError::AccumulatorNotReset
    );

    // ── 3. Escrow predebit (mirrors SoothBook.sol:421-426)
    if escrow {
        sooth_market_cpi::debit_shares_for_order_before_deadline(
            ctx, ctx.accounts.taker.key(), side ^ 1, amount
        )?;
    }

    // ── 4. Auto-match against opposite-side book (§6 matcher)
    //      Each fill calls fill_order which RETURNS deltas; we accumulate here.
    let remaining = match_buy(
        &mut ctx.accounts.market_book, side, tick, amount, escrow, match_limit,
        ctx.remaining_accounts,
    )?;

    if remaining == 0 {
        flush_accumulators(&mut ctx.accounts.market_book, ctx)?;
        return Ok(());
    }

    // ── 5. Anti-dust on resting remainder (§7.1, §7.2)
    let value_tick = if escrow { NUM_TICKS - tick } else { tick };
    if remaining < min_resting_order_for_tick(value_tick) {
        if escrow {
            sooth_market_cpi::credit_shares_for_order(
                ctx, ctx.accounts.taker.key(), side ^ 1, remaining
            )?;
        }
        emit!(DustOrderSkipped { market, side, tick, user: taker, amount: remaining, escrow });
        flush_accumulators(&mut ctx.accounts.market_book, ctx)?;
        return Ok(());
    }

    // ── 6. Resting deposit (non-escrow; mirrors SoothBook.sol:442-448)
    if !escrow {
        let resting_cost_base = compute_cost_base(remaining, tick);  // §7.3 floor rule
        sooth_market_cpi::deposit_for_order(ctx, ctx.accounts.taker.key(), resting_cost_base)?;
    }

    // ── 7. Per-tick cap check + enqueue
    let book_side = load_resting_book_side(ctx, side, tick)?;
    require!(book_side.orders.len() < MAX_ORDERS_PER_TICK, CoreError::BookSideFull);
    let seq = ctx.accounts.market_book.next_order_id;
    let order_id = encode_order_id(side, tick, seq);
    ctx.accounts.market_book.next_order_id = seq.checked_add(1)
        .ok_or(CoreError::MathOverflow)?;
    book_side.orders.push(InlineOrder {
        id: order_id, maker: ctx.accounts.taker.key(),
        amount: remaining, escrow, _pad: [0; 3],
    });

    // ── 8. Bitmap set + event
    ctx.accounts.market_book.bitmap_mut(side).set_bit(tick);
    emit!(OrderPlaced { market, side, tick, maker: taker, amount: remaining, escrow, order_id });

    // ── 9. Flush accumulators (§7.4)
    flush_accumulators(&mut ctx.accounts.market_book, ctx)?;
    Ok(())
}
```

`flush_accumulators` drains `pending_taker_payout` and `pending_fees` via two SPL transfers (see §7.4), resets both to 0. Atomic with the rest of the ix.

---

## 6. Auto-matching algorithm

Direct port of `SoothBook.sol:_match` and `:_matchTick` (lines 469-555). The matcher walks the opposite-side bitmap downward from `NUM_TICKS`, filling at each crossing tick until exhausted, the match limit is hit, or no crossing tick remains.

```rust
fn match_buy(
    book: &mut MarketBook,
    taker_side: u8,
    taker_tick: u16,
    mut amount: u128,
    taker_escrow: bool,
    mut match_limit: u32,
    remaining_accounts: &[AccountInfo],
) -> Result<u128 /* remaining */> {
    let opp_side = taker_side ^ 1;
    let min_opp_tick = NUM_TICKS - taker_tick;
    let mut opp_tick = book.bitmap(opp_side).find_next_down(NUM_TICKS);
    let mut fill_index: usize = 0;   // increments once PER MAKER FILL, not per tick

    while amount > 0 && opp_tick >= min_opp_tick && opp_tick <= MAX_TICK {
        // match_at_tick may consume multiple consecutive bundles if multiple makers
        // exist at this tick. It returns the next fill_index to read from.
        let result = match_at_tick(
            book, remaining_accounts, fill_index,
            taker_side, opp_side, taker_tick, opp_tick,
            amount, taker_escrow, match_limit,
        )?;
        amount = result.remaining;
        match_limit = result.match_limit_remaining;
        fill_index = result.next_fill_index;

        if match_limit == 0 || opp_tick == 0 { break; }
        opp_tick = book.bitmap(opp_side).find_next_down(opp_tick);
    }
    Ok(amount)
}

struct MatchTickResult { remaining: u128, match_limit_remaining: u32, next_fill_index: usize }

fn match_at_tick(
    book: &mut MarketBook,
    remaining_accounts: &[AccountInfo],
    mut fill_index: usize,
    taker_side: u8, opp_side: u8,           // opp_side passed explicitly (was missing before)
    taker_tick: u16, opp_tick: u16,
    mut remaining: u128,
    taker_escrow: bool,
    mut match_limit: u32,
) -> Result<MatchTickResult> {
    // First bundle for this tick carries the BookSide. Loads + validates seeds against opp_side/opp_tick.
    let first_bundle = load_fill_bundle(remaining_accounts, fill_index, market, opp_side, opp_tick)?;
    let book_side = &mut first_bundle.book_side;
    let mut head = book_side.head_index as usize;

    while remaining > 0 && head < book_side.orders.len() && match_limit > 0 {
        let maker_order = &mut book_side.orders[head];
        if maker_order.amount == 0 { head += 1; continue; }   // lazy-deleted

        // Per-maker bundle: positions 1 (OrderbookPosition) and 2 (USDC ATA) bind to THIS maker.
        // The BookSide at position 0 is the same PDA across all bundles at this tick — Solana
        // dedupes writable accounts at tx level, so this is free.
        let bundle = load_fill_bundle(remaining_accounts, fill_index, market, opp_side, opp_tick)?;
        require_keys_eq!(
            bundle.maker_position.user, maker_order.maker,
            CoreError::MakerAccountMismatch
        );

        let fill = remaining.min(maker_order.amount);

        // CPI to sooth_market::fill_order — RETURNS deltas, does NOT mutate MarketBook
        sooth_market_cpi::fill_order(
            bundle, taker, maker_order.maker, taker_side, fill,
            taker_tick, opp_tick, taker_escrow, maker_order.escrow,
        )?;
        let (fee_base_delta, taker_payout_delta) = decode_fill_return_data()?;  // §6.3

        // Caller (sooth_book) owns MarketBook and writes accumulators (§3.1 ownership rule)
        book.pending_fees = book.pending_fees.checked_add(fee_base_delta)
            .ok_or(CoreError::MathOverflow)?;
        book.pending_taker_payout = book.pending_taker_payout.checked_add(taker_payout_delta)
            .ok_or(CoreError::MathOverflow)?;

        maker_order.amount -= fill;
        remaining -= fill;
        if maker_order.amount == 0 { head += 1; }
        match_limit -= 1;
        fill_index += 1;
    }
    book_side.head_index = head as u32;

    // Clear bitmap bit on the opposing side (the side we just consumed from), NOT taker_side
    if head == book_side.orders.len() {
        book.bitmap_mut(opp_side).clear_bit(opp_tick);
        // BookSide remains allocated; close_book_side ix (permissionless) reclaims rent later.
    }

    Ok(MatchTickResult {
        remaining,
        match_limit_remaining: match_limit,
        next_fill_index: fill_index,
    })
}
```

### 6.1 `remaining_accounts` bundle layout

Deterministic 5-account bundle **per maker fill** (not per tick), repeated up to `match_limit` bundles. A single tick with N maker fills requires N consecutive bundles in `remaining_accounts` — the `BookSide` PDA appears in all N (Solana deduplicates writable accounts at the tx level, so this is free). Each bundle's positions 1 and 2 reference the SPECIFIC maker for that fill — positions are not shared across fills.

Caller (SDK) simulates the matching walk: for each tick the bitmap surfaces, look up the BookSide head and walk the FIFO; emit one bundle per maker that will be touched (up to `match_limit` total across all ticks).

| Position | Account                                        | Validation                                                                                                                        |
| -------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0        | `BookSide` PDA at (market, opp_side, opp_tick) | seeds match decoded opp_tick from bitmap; writable                                                                                |
| 1        | Maker `OrderbookPosition` PDA                  | seeds `[b"orderbook_position", market_id, maker]`; `maker == book_side.orders[head_index].maker` after lazy-delete skip; writable |
| 2        | Maker USDC ATA                                 | `owner == maker`; mint == USDC; writable when `maker.escrow`                                                                      |
| 3        | _reserved_                                     | pass `system_program` placeholder                                                                                                 |
| 4        | _reserved_                                     | pass `system_program` placeholder                                                                                                 |

For `match_limit=3`: 3 × 5 = 15 max remaining_accounts. **Zero bundles IS valid** (no-cross order — bitmap walk found no crossing tick; all of `amount` rests).

**Three exit states from the match loop:**

| State             | Condition                                                                          | Behavior                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Bitmap exhausted  | `find_next_down` returns no further crossing tick                                  | Loop exits cleanly. Any `remaining` flows to §5 step 5 (dust check) or §5 step 7 (resting).                                       |
| `match_limit` hit | `match_limit_remaining == 0`                                                       | Loop exits cleanly. Same downstream as above. EVM-parity partial-cross.                                                           |
| Bundle budget hit | `fill_index >= remaining_accounts.len() / 5` while bitmap still has crossing ticks | Loop exits cleanly. SDK chose to pass fewer bundles than match_limit's worst case; matcher honors that. Same downstream as above. |

**Errors (return `Err`, not silent rest):**

- `MissingCrossingBookSide` — bundle present at `fill_index` but its BookSide seeds don't validate against the bitmap's current `opp_tick`. SDK bug or stale-bitmap race; SDK should re-simulate and resubmit.
- `MakerAccountMismatch` — bundle's Maker `OrderbookPosition.user` ≠ `BookSide.orders[head_after_skip].maker`. SDK passed the wrong maker accounts.
- `WrongBundleArity` — `remaining_accounts.len() % 5 != 0`. Zero is fine; non-multiple-of-5 is not.

**The program never silently rests a CROSSED remainder.** "Crossed" means a tick that would have matched but couldn't because of a bundle bug. "Uncrossable" remainders (bitmap exhausted, match_limit hit, bundles exhausted) follow the §5 resting-order flow — EVM-equivalent partial-cross behavior.

### 6.2 CPI return-data contract for `fill_order`

Anchor does not natively support typed multi-value CPI returns. The pattern uses Solana's `set_return_data` / `get_return_data` primitives with Borsh serialization. Spec'd canonically:

```rust
// In sooth_market::fill_order (callee), after computing deltas:
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FillReturnData {
    pub fee_base_delta: u128,
    pub taker_payout_delta: u128,
}

pub fn fill_order(ctx: Context<FillOrder>, ...) -> Result<()> {
    // ... compute deltas (per §8.2) ...
    let ret = FillReturnData { fee_base_delta, taker_payout_delta };
    solana_program::program::set_return_data(&ret.try_to_vec()?);
    Ok(())
}

// In sooth_book caller, after CPI:
fn decode_fill_return_data() -> Result<(u128, u128)> {
    let (program_id, data) = solana_program::program::get_return_data()
        .ok_or(CoreError::MissingFillReturnData)?;
    require_keys_eq!(program_id, sooth_market::ID, CoreError::WrongFillReturnProgram);
    let ret = FillReturnData::try_from_slice(&data)
        .map_err(|_| CoreError::MalformedFillReturnData)?;
    Ok((ret.fee_base_delta, ret.taker_payout_delta))
}
```

`set_return_data` is bounded at 1024 bytes total per Solana runtime; 32 bytes (two u128) fits easily. `get_return_data` returns the data set by the most recent CPI in the call chain — safe to call immediately after `sooth_market_cpi::fill_order` returns. The caller MUST verify `program_id == sooth_market::ID` to defend against return-data poisoning from a malicious inner CPI.

### 6.3 `findNextDown` / `findNextUp` port

Translates `TickBitmap.sol:194-237` to Rust. Two-level bitmap collapses to flat `[u64; 16]` on Solana (no sparse-mapping cost benefit). LSB/MSB primitives use `u64::trailing_zeros` / `u64::leading_zeros` instead of EVM assembly.

---

## 7. Anti-dust, escrow, deadlines, fee rounding

### 7.1 `min_resting_order_for_tick`

Port of `SoothBook.sol:644-647`:

```rust
fn min_resting_order_for_tick(tick: u16) -> u128 {
    let base_unit_wad: u128 = 1_000_000_000_000;   // 1e12 for USDC (6 decimals)
    (base_unit_wad * (NUM_TICKS as u128) + (tick as u128) - 1) / (tick as u128)
}
```

### 7.2 Escrow `valueTick` rule

Mirrors `SoothBook.sol:431-437`:

```rust
let value_tick = if escrow { NUM_TICKS - tick } else { tick };
let min_threshold = min_resting_order_for_tick(value_tick);
if remaining < min_threshold {
    if escrow {
        sooth_market_cpi::credit_shares_for_order(ctx, taker, side ^ 1, remaining)?;
    }
    emit!(DustOrderSkipped { ... });
    return Ok(());
}
```

### 7.3 Fee rounding (pinned — EVM parity at the dust boundary)

EVM rule (`OrderEngine.sol:720-735`):

```
takerBaseCost   = wadToBase(baseCostWad)
takerCostPlusFee = wadToBase(baseCostWad + feeWad)
feeBaseUnits    = takerCostPlusFee - takerBaseCost
```

Solana mirrors exactly:

```rust
fn compute_taker_pull(base_cost_wad: u128, fee_wad: u128) -> (u64 /* base */, u64 /* fee */) {
    let taker_base_cost = wad_to_base(base_cost_wad);
    let taker_cost_plus_fee = wad_to_base(base_cost_wad.checked_add(fee_wad)?);
    let fee_base = taker_cost_plus_fee - taker_base_cost;
    (taker_base_cost, fee_base)
}
fn wad_to_base(wad: u128) -> u64 {
    (wad / BASE_UNIT_WAD).try_into().unwrap()   // floor; BASE_UNIT_WAD = 1e12 for USDC
}
```

The `floor(sum) - floor(base)` rule is what makes EVM's per-fill fee rounding match `feeRouter.distributeExactFee`. Naive separate-floor would undercollect ~1 base unit per fill under heavy traffic. Pinned in spec; W4 must include golden-case tests against EVM fixture data.

### 7.4 Deadline guards

Mirrors `OrderEngine.sol:598-610`. Filler ix that mutate state during active trading call `require_clock_before_deadline(market)` before any token movement:

| ix                                       | Deadline guard |
| ---------------------------------------- | -------------- |
| `fill_order`                             | YES            |
| `deposit_for_order`                      | YES            |
| `debit_shares_for_order_before_deadline` | YES (in name)  |
| `withdraw_for_order` (refund)            | NO             |
| `credit_shares_for_order` (refund)       | NO             |

Helper reads `Clock::get()?.unix_timestamp` and compares against `Market.deadline`. Matches existing AMM pattern (`trade_positions.rs:322-324`).

### 7.5 End-of-ix accumulator flush

```rust
fn flush_accumulators(book: &mut MarketBook, ctx: &Context<Buy>) -> Result<()> {
    // Taker payout (escrow + surplus + non-escrow proceeds)
    if book.pending_taker_payout > 0 {
        let amount: u64 = u64::try_from(book.pending_taker_payout)
            .map_err(|_| CoreError::MathOverflow)?;
        spl_transfer_signed(
            from: ctx.accounts.market_usdc_vault,
            to: ctx.accounts.taker_usdc_ata,
            authority_seeds: &[b"vault_authority", market_id, &[bump]],  // sooth_market vault auth
            amount,
        )?;
        // sooth_market::Market.collateral_backing decrement happens inside fill_order's
        // returned-delta accounting; the caller doesn't double-decrement here.
        book.pending_taker_payout = 0;
    }

    // Fee transfer to per-market MarketFeePool
    if book.pending_fees > 0 {
        let amount: u64 = u64::try_from(book.pending_fees)
            .map_err(|_| CoreError::MathOverflow)?;
        spl_transfer_signed(
            from: ctx.accounts.market_usdc_vault,
            to: ctx.accounts.market_fee_pool,
            authority_seeds: &[b"vault_authority", market_id, &[bump]],
            amount,
        )?;
        book.pending_fees = 0;
    }
    Ok(())
}
```

Both transfers signed by `sooth_market` vault authority because the source is the market USDC vault. The `MarketFeePool`'s `fee_pool_authority` PDA signs only the drain side (§9.5).

**Accumulator invariants:**

- Zero at ix entry (asserted in §5 step 2).
- All increments use `checked_add` with `MathOverflow` on saturation.
- Reset unconditionally at end of ix (safe no-op when zero).
- If a CPI fails mid-flow, Solana atomic-tx rolls back the entire ix — accumulators stay at start-of-ix state.

---

## 8. Cross-program wiring

### 8.1 Lazy `MarketBook` initialization (no CPI from `sooth_amm` to `sooth_book`)

`sooth_book::buy_yes` / `buy_no` declare `market_book` via `init_if_needed`. AMM graduation is checked via `amm_state.is_graduated`, with the `AmmState` account bound by `seeds = [b"amm", market.market_id.as_ref()]` + `has_one = market` (mirrors existing AMM pattern at `trade_positions.rs:119-126`) — prevents cross-market AMM substitution. First orderbook user pays MarketBook rent (~$0.42).

`sooth_amm::trade_positions` is NOT modified to add CPI into `sooth_book`. (It IS modified for the fee-flow change in §9.4 — fee transfer destination swap — but that's an independent edit to the same file, no `sooth_book` CPI involved.)

### 8.2 Fill-time settlement (`sooth_book` → `sooth_market`)

Each fill in `match_at_tick` CPIs to `sooth_market::fill_order` (§3.1 ownership rule: returns deltas only, doesn't write MarketBook). Auth via `require_sooth_book_cpi_parent` against discriminators `{buy_yes, buy_no}`.

`fill_order` is a full port of EVM `OrderEngine._fill` + `_collectTakerCostAndFee` + `_settleEscrowAndSurplus` + `_creditMatchedShares` (`OrderEngine.sol:598-674, 714-741, 787-836`). Per fill:

1. Deadline check (§7.4).
2. If `!takerEscrow`: pull `taker_cost_base + fee_base` from taker USDC ATA into market USDC vault using §7.3 floor-on-sum rule. **Return `fee_base` and `0` for taker_payout_delta to the caller** (caller accumulates).
3. If `makerEscrow`: pay `wad_to_base((NUM_TICKS - makerTick) * fill / NUM_TICKS)` USDC from market vault to maker ATA (per-fill, can't batch — different makers).
4. If `takerEscrow`: include `wad_to_base((NUM_TICKS - takerTick) * fill / NUM_TICKS)` in `taker_payout_delta` returned to caller.
5. Surplus: when `takerTick + makerTick > NUM_TICKS`, add `wad_to_base((sum - NUM_TICKS) * fill / NUM_TICKS)` to `taker_payout_delta`.
6. Credit shares on `OrderbookPosition`: `(maker, takerSide ^ 1, fill)` if `!makerEscrow`; `(taker, takerSide, fill)` if `!takerEscrow`.
7. Emit `FillRecorded { market, taker, maker, takerSide, shares, yesTick, noTick, fillId }`.
8. **Return** `(fee_base_delta, taker_payout_delta)` to the caller.

### 8.3 Cancel-time refund

`sooth_book::cancel` / `cancel_by_id` CPI into `sooth_market`:

- `withdraw_for_order` (non-escrow USDC refund): `wad_to_base(remaining * tick / NUM_TICKS)` base units → user
- `credit_shares_for_order` (escrow refund): credits opposite shares back to user

Gated by `require_sooth_book_cpi_parent` against `{cancel, cancel_by_id}`.

---

## 9. Migration plan

### 9.1 What gets deleted from current `sooth_book`

| Path                                                                                                                                                                                                                          | Action                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `programs/sooth_book/src/state/{market_liquidities,market_matching_pool_account,market_matching_queue_account,market_order_request_queue,market_position_account,order_account,price_ladder,market_type,operator_account}.rs` | delete                                                                   |
| `programs/sooth_book/src/state/market_account.rs`                                                                                                                                                                             | rewrite as `MarketBook`                                                  |
| `programs/sooth_book/src/instructions/{order,order_request,matching,market_position}/*`                                                                                                                                       | rewrite/delete per new model                                             |
| `programs/sooth_book/src/instructions/close.rs`, `mint_into_book.rs`, `settle_resting_orders.rs`                                                                                                                              | rewrite                                                                  |
| `programs/sooth_book/src/instructions/fee_route.rs`                                                                                                                                                                           | rewrite — full fill-flow port from EVM `OrderEngine._fill` per §7 + §8.2 |
| `programs/sooth_book/vendor/`                                                                                                                                                                                                 | delete (Monaco vendor + LICENSE/NOTICE)                                  |

### 9.2 What gets preserved

| Asset                                                                                   | Why                                                                                           |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Program ID `DKxaVqA38Y2zvtM2fqoAJJQUPCefSoCL41dCjeACgo5X` and keypair                   | deploy continuity (verified in `lib.rs:26`, `Anchor.toml:13,20`, SDK adapter, deploy scripts) |
| `Cargo.toml`, Anchor scaffolding                                                        | reuse                                                                                         |
| `instructions/math.rs` (`PRICE_TICK`, `PRICE_WAD`, `calculate_*`)                       | already EVM-aligned (W4 work survives)                                                        |
| SDK `@sooth/sdk-solana` builder _function signatures_ (`buildOrderbookBuy/Sell/Cancel`) | interfaces stable; internals require full rewrite                                             |

**SDK rewrite scope (larger than internals-only):**

- `packages/sdk-solana/src/adapter.ts:2641-2718` — cancel paths read Monaco `Order` PDA; rewrite for composite `order_id` + BookSide-only reads
- `packages/sdk-solana/src/pdas.ts:462-630` — delete Monaco PDA helpers (`MarketLiquidities`, `MarketMatchingPool`, `MarketOrderRequestQueue`, `priceLadderPda`, `marketOutcomePda`); replace with `MarketBook` / `BookSide` / `OrderbookPosition` / `MarketFeePool` helpers
- `apps/demo/e2e/helpers/sdk-helpers.ts:1028-1073` — delete Monaco-shape seed paths; rely on lazy-init

`SOOTH_BOOK_PROGRAM_ID` const added to `packages/programs-core/crates/sooth-protocol-types/src/ids.rs`. Buy/cancel discriminator constants (`SOOTH_BOOK_{BUY_YES,BUY_NO,CANCEL,CANCEL_BY_ID}_DISCRIMINATOR`) added to `packages/programs-core/crates/sooth-protocol-types/src/discriminators.rs`.

**SDK + demo UX disclosure:** users currently expect Anchor's default `close = user` rent-refund behavior on cancel. The new BookSide pooled-rent model breaks this. SDK `cancel` / `cancelById` receipts must explicitly state `rentRefundedSol: 0`; demo `/portfolio` cancel button copy must explain rent stays in the book until close; SDK README documents the parity break. Required UX work in W7.

### 9.3 What gets added to `sooth_market`

- **`OrderbookPosition` PDA** (§3.4) — new account type
- **`fill_order`** ix — returns `(fee_base_delta, taker_payout_delta)`, does NOT mutate caller-owned MarketBook (§8.2)
- **`deposit_for_order` / `withdraw_for_order`** — filler-only collateral movement
- **`credit_shares_for_order` / `debit_shares_for_order_before_deadline`** — filler-only `OrderbookPosition` mutators. Cancel paths use credit only.
- **`mint_complete_set_for_orderbook`** / **`merge_complete_set_for_orderbook`** / **`redeem_orderbook`** — user-facing OrderbookPosition lifecycle
- **`require_sooth_book_cpi_parent`** helper in `instruction_introspection.rs` — single `load_instruction_at_checked(current_index)`, no scan

### 9.4 What changes in `sooth_amm`

**Fee transfer destination only.** `trade_positions.rs:50-52` body's second SPL transfer destination changes from global `fee_pool_vault` (legacy) to per-market `market_fee_pool`. Signer = user (source is user's USDC ATA — user signs both `cost_usdc → market_vault` and `fee_usdc → market_fee_pool` transfers). `TradePositions` accounts struct replaces the `fee_pool_vault` field with `market_fee_pool`.

**Sell-path fee wiring** added at the same time (existing TODO at `trade_positions.rs:66-73` — sells produce 0 fee revenue today).

`AmmState` layout unchanged (no migration). No CPI into `sooth_book`.

### 9.5 What changes in `sooth_launchpad`

**New ix `init_market_fee_pool(market)`** — lazy-init the per-market `MarketFeePool` TokenAccount. Permissionless; SDK calls before first AMM trade or first orderbook ix. Mint validated against protocol-config USDC. Authority = `fee_pool_authority` singleton.

**`distribute_fees(market)` redesigned per-market.** `DistributeFees` accounts struct adds `market` + `market_fee_pool`. Drain source = `market_fee_pool.amount` (was: global `fee_pool_vault.amount`). 4-way bps split unchanged (b-base / lp-yield / adjudicator / treasury). Anyone can crank any market independently.

**`distribute_fees_legacy`** — separate ix variant, drains the legacy global `fee_pool_vault` once on rev-deploy day. Kept for migration; after one invocation, the global pool is permanently empty.

---

## 10. Cost model

### 10.1 Creator costs (paid at market creation)

| Item                       | Cost      | Notes                     |
| -------------------------- | --------- | ------------------------- |
| `sooth_market::Market` PDA | unchanged | not affected by this port |
| `sooth_amm::AmmState` PDA  | unchanged | not affected              |

**Creator pays $0 for any new orderbook-related state.** All new state lazy-inits on first use.

### 10.2 Protocol-init costs (paid by first user to trigger each path)

| Item                                 | Cost (USD @ $140 SOL) | Paid by                                                    | Refundable |
| ------------------------------------ | --------------------- | ---------------------------------------------------------- | ---------- |
| `MarketFeePool` TokenAccount (165 B) | ~$0.18                | first AMM trader OR first orderbook user (whichever fires) | no         |
| `MarketBook` PDA (432 B)             | ~$0.42                | first orderbook user                                       | no         |

### 10.3 Per-user costs

| Item                            | Cost   | Paid by                                         | Refundable                                   |
| ------------------------------- | ------ | ----------------------------------------------- | -------------------------------------------- |
| `OrderbookPosition` PDA (120 B) | ~$0.10 | each orderbook participant, one-time per market | yes, on `redeem_orderbook` post-settle close |

### 10.4 Per-order costs

| Item                                                           | Cost                   | Paid by         | Refundable                                                 |
| -------------------------------------------------------------- | ---------------------- | --------------- | ---------------------------------------------------------- |
| First order at a fresh tick (BookSide 51 B + InlineOrder 60 B) | +$0.108                | placer          | no — rent pools in BookSide; closer recovers on full drain |
| Subsequent order at same tick (60 B realloc)                   | +$0.058                | placer          | no                                                         |
| Cancel (mark amount=0)                                         | $0                     | —               | n/a                                                        |
| `compact_book_side` sweep                                      | small tx fee           | anyone          | n/a                                                        |
| `close_book_side` on full drain                                | residual BookSide rent | closer (anyone) | n/a                                                        |
| Taker match fill                                               | tx fee + CU            | taker           | n/a                                                        |

### 10.5 Worst-case first-orderbook-user

A single first user on a freshly graduated market with no prior AMM trades pays:

| Component                      | Cost       |
| ------------------------------ | ---------- |
| `MarketFeePool` init           | $0.18      |
| `MarketBook` init              | $0.42      |
| Their `OrderbookPosition`      | $0.10      |
| First `BookSide` at their tick | $0.108     |
| **Total worst case**           | **~$0.81** |

**62× under the $50 hard cap.** Subsequent users pay only $0.10 (OrderbookPosition) + per-order rent.

### 10.6 Load profiles

| Profile       | Active ticks | Orders/tick | Total rent (distributed across placers) |
| ------------- | ------------ | ----------- | --------------------------------------- |
| Cold market   | 0            | 0           | $0.42 (MarketBook only)                 |
| Quiet market  | 5            | 3           | ~$1.54                                  |
| Active market | 20           | 10          | ~$13.02                                 |
| Heavy market  | 100          | 30          | ~$179                                   |
| Saturated     | 200          | 50          | ~$590                                   |

Per-byte rent: ~6960 lamports/byte (2-epoch exemption) × $1.4e-7/lamport at $140/SOL ≈ $9.74e-4 per byte. Verified arithmetic.

---

## 11. Implementation timeline

**9 weeks** via Codex-tmux. Custody primitives before matching (depend-on-then-use ordering).

| Week   | Scope                                                                                                                                                                                                                                                                                                                                                                                                              | Acceptance (must be measurable, not aspirational)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1** | Delete Monaco vendor + `vendor/`; new `sooth_book` skeleton; port `TickBitmap` library; `MarketBook` PDA + composite `order_id` codec; add `SOOTH_BOOK_PROGRAM_ID` to `sooth-protocol-types::ids` + discriminator constants to `sooth-protocol-types::discriminators`                                                                                                                                              | `cargo check` clean; bitmap unit tests pass (round-trip `find_next_down` / `find_next_up` against 1000 random patterns); `order_id` codec round-trip tests pass on all valid (side, tick, seq) triples                                                                                                                                                                                                                                                                                                                    |
| **W2** | Custody primitives: `OrderbookPosition` PDA; `require_sooth_book_cpi_parent` helper; all 5 filler-only ix on `sooth_market` (`fill_order`, `deposit_for_order`, `withdraw_for_order`, `credit_shares_for_order`, `debit_shares_for_order_before_deadline`); `init_market_fee_pool` ix on `sooth_launchpad`; `sooth_amm` fee-redirect + sell-path wiring; auth tests via test-only SoothBook-impersonating CPI stub | All filler ix reject direct call (negative test); reject wrong-discriminator parent ix (negative test); reject earlier-but-unrelated SoothBook ix in same tx (negative test against the scan-bypass attack); AMM trades fund per-market pool not global pool; sell-path emits non-zero fee; deadline guards reject post-deadline mutations                                                                                                                                                                                |
| **W3** | `BookSide` PDA + lazy-init; `InlineOrder`; place/cancel/cancel_by_id/compact_book_side/close_book_side ix; `MAX_ORDERS_PER_TICK=50` enforcement; SDK UX disclosure copy                                                                                                                                                                                                                                            | LiteSVM round-trips: place at empty tick / append at populated tick / cap rejection / cancel marks `amount=0` (no rent refund); `compact_book_side` drops trailing zeros (bounded ≤16); `close_book_side` returns residual to closer; SDK receipt shows `rentRefundedSol: 0`                                                                                                                                                                                                                                              |
| **W4** | Auto-matching engine (`match_buy` / `match_at_tick`); 5-account bundle validation per §6.1; `min_resting_order_for_tick` + escrow `valueTick` + dust-credit-back; fee floor-on-sum rule per §7.3; end-to-end `buy_yes`/`buy_no` ix per §5 pseudocode (predebit → match → dust → rest → enqueue → bitmap → flush); **`match_limit=0` → unlimited path tested**                                                      | LiteSVM tests: `match_limit=0` (unlimited), `match_limit=3` (bounded), zero-bundles no-cross order, `MissingCrossingBookSide`, `MakerAccountMismatch`, `WrongBundleArity`, bitmap walk correctness; **EVM golden-case fee-rounding fixtures** against `OrderEngine.sol:714-740` line-by-line (dust corner cases must match to the base unit)                                                                                                                                                                              |
| **W5** | `sooth_launchpad::distribute_fees(market)` per-market redesign + `distribute_fees_legacy` for one-time global drain on rev-deploy day                                                                                                                                                                                                                                                                              | Per-market crank works end-to-end; legacy drain works exactly once (idempotency tested); 4-way bps split numerically unchanged from current; replay protection on legacy ix                                                                                                                                                                                                                                                                                                                                               |
| **W6** | `mint_complete_set_for_orderbook` + `merge_complete_set_for_orderbook` + `redeem_orderbook` ix; SDK PDA helpers (`pdas.ts:462-630`) full rewrite; demo helpers (`sdk-helpers.ts`) updated                                                                                                                                                                                                                          | Round-trip mint/merge/redeem on `OrderbookPosition`; SDK reads `MarketBook` + `BookSide` + `MarketFeePool` correctly via lazy-init flow; demo `/portfolio` mint/merge work end-to-end on Surfpool                                                                                                                                                                                                                                                                                                                         |
| **W7** | SDK adapter cancel-path rewrite (`adapter.ts:2641-2718`); error-classifier maps `{BookSideFull, MissingCrossingBookSide, MakerAccountMismatch, WrongBundleArity, AccumulatorNotReset, OrderIdSeedMismatch, MarketNotGraduated}` to user-readable messages; demo chain-shim verification                                                                                                                            | Each new error code has an asserted-against test in the SDK; error messages reviewed by a non-engineer; demo orderbook flows pass smoke tests on Surfpool                                                                                                                                                                                                                                                                                                                                                                 |
| **W8** | E2E specs against Surfpool; **CU + writable-account measurement**; SDK error-classifier updates                                                                                                                                                                                                                                                                                                                    | All 19 prior orderbook e2e specs pass against new program; new specs for escrow + dust + missing-account-error + per-market fee distribution + per-tick cap. **CU ceilings: `match_limit=3` worst-case (3 escrow makers + surplus + fee flush) ≤ 800k CU per tx.** The writable-account budget (§13 Q2) caps per-tx fills at ~3.7 regardless of `match_limit` value, so unlimited matching requires multi-tx retry orchestration in the SDK — not a single-tx threshold. Acceptance fails if a 3-fill tx exceeds 800k CU. |
| **W9** | Codex review pass; audit-prep notes (threat model, EVM-parity diff, parent-ix gate audit checklist, fee-flow rewrite delta); decision-log entries D13–D16 committed; supersede `fork-plan.md`; status.md update                                                                                                                                                                                                    | Codex re-review reports 0 critical / 0 high; founder sign-off                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## 12. Risks tracked

| Risk                                                                         | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`match_limit=3` insufficient for realistic depth**                         | High       | Med    | SDK does multi-tx for deeper crosses. `match_limit=0` (unlimited) is available per call (§4.1). Document expected latency hit.                                                                                                                 |
| Bitmap walk passes a tick whose BookSide isn't in `remaining_accounts`       | High       | High   | Hard error path `MissingCrossingBookSide` (§6.1). SDK simulates the crossing walk pre-submission; on stale-bitmap race, retries.                                                                                                               |
| `MarketBook` write contention serializes within-market matching              | High       | Low    | Acceptable per §2. Mirrors EVM single-contract behavior. Across-market parallelism preserved.                                                                                                                                                  |
| `BookSide` lazy-close rent stranded if nobody triggers close                 | Low        | Low    | `close_book_side` is permissionless; any user can crank for the rent. If nobody bothers, rent stays — no protocol harm.                                                                                                                        |
| Parent-ix auth bypass via tx-bundling                                        | High       | High   | Closed: `require_sooth_book_cpi_parent` loads ONLY `instructions[current_index]` (no scan). Tested in W2 negative cases.                                                                                                                       |
| Composite `order_id` collision across markets                                | Low        | Med    | Sequence is per-market (40 bits, ~1.1T). SDK + indexer always pair with market Pubkey.                                                                                                                                                         |
| `init_if_needed` audit smell on `MarketBook`                                 | Low        | Med    | Standard Anchor pattern with documented guards: deterministic seeds, `market == Pubkey::default()` first-touch check, end-user payer (not privileged). Covered in W9 audit-prep notes.                                                         |
| Fee dust rounding parity break vs EVM                                        | Med        | High   | Pinned in §7.3 (floor-on-sum). W4 acceptance includes golden-case fixtures against EVM `OrderEngine.sol:714-740`.                                                                                                                              |
| CU ceiling unknown for worst case                                            | Med        | High   | W8 acceptance defines a hard 800k-CU-per-tx threshold for a 3-fill worst case. The writable-account budget caps per-tx fills at ~3 regardless of `match_limit`; unlimited matching is implemented as multi-tx SDK retry, not a single mega-tx. |
| Existing `settle_resting_orders.rs:208-221` parent-ix gap (current-code bug) | Med        | Med    | Closed as side effect when `settle_resting_orders` is rewritten with `require_sooth_book_cpi_parent` in W3.                                                                                                                                    |

---

## 13. Resolved design questions

### Q1. Position storage — split (EVM-literal). ✓ RESOLVED

`sooth_market::Position` (existing) stays AMM-only. `sooth_market::OrderbookPosition` (new) tracks orderbook-side complete-set shares. Mirrors EVM `OrderEngine._positions` vs `AMMEngine._positions` split. Per-user cost +$0.10 (refundable on redeem-close).

### Q2. `match_limit` default = 3 (rev-stable). ✓ RESOLVED

SDK defaults `match_limit = 3`. Per-fill writables ≈ 6 (MarketBook, BookSide, taker/maker OrderbookPosition, maker USDC ATA on escrow path, market USDC vault). End-of-ix one-shot writables ≈ 3 (taker USDC ATA, market USDC vault, MarketFeePool). Per-tx fixed (signer + program ids + sysvars + sysvar_instructions) ≈ 7. Budget: `(32 - 7 - 3) / 6 ≈ 3.7` → 3 fits with margin. **Validate empirically W8** with measured per-fill account count; raise to 4 if budget permits.

`match_limit = 0` is a callable special-case meaning unlimited (§4.1, §5). EVM parity.

### Q3. BookSide rent refund — permissionless closer gets residual. ✓ RESOLVED

When a tick drains, `close_book_side` is invokable by any user. Whoever calls it receives the residual lamports via standard Anchor `close = closer` pattern. ~10 LOC. Mild unfairness vs original placers; not load-bearing. Consistent across §3.2 (lifecycle), §12 (risk row), §13 Q3 (this).

---

## 14. Decision-log entries (drafts for `docs/decision-log.md`)

- **D13.** EVM-direct port supersedes Monaco fork (P1 revisited). Reason: Monaco's design tax incompatible with $50 hard creation cap. Direct port hits ~$0.42/market vs Monaco's ~$15–$1,940 envelope.
- **D14.** Path A on-chain CLOB only for v1. Path B (signed orders / off-chain operator) deferred — Solana Path B is non-trivial (Ed25519 typed-data + operator authorization + nonce tracking) and the on-chain path alone meets the cost target.
- **D15.** Split position model — separate `OrderbookPosition` PDA from existing `Position`. Mirrors EVM `OrderEngine` vs `AMMEngine` literally.
- **D16.** Per-market fee pools replace the global `fee_pool_vault`. Closes the EVM `_marketCollateral[market]` parity question structurally (Solana's native token-balance read = EVM's accumulator field). Touches `sooth_amm::trade_positions` (fee transfer destination only) + `sooth_launchpad::distribute_fees` (per-market crank). Existing global pool drained once via `distribute_fees_legacy` on deploy day.

---

## 15. Out of scope

Tracked but not in this 9-week window:

- **Path B (signed orders / off-chain CLOB operator)** — adds Solana-native EIP-712 equivalent + operator authorization + matchSignedOrders ix. Estimate: 3-4 weeks additional. Defer.
- **T\* retroactive settlement** — EVM `OrderEngine.postSettlementRoot` for time-truth markets. Already deferred per existing roadmap.
- **TruthMarket `invalidate()` parity** — EVM has permissionless `invalidate()` after `deadline + invalidationBuffer` (`TruthMarket.sol:177-188`). Current `sooth_market::lifecycle.rs:15-18` notes the gap exists today. Not introduced by this port; recommend pulling forward into the same audit window as a separate fix.

Within Path A fee/accounting/matching: **no known parity gaps.**

---

## 16. Cross-references

- [`docs/decision-log.md`](../decision-log.md) D7 (P1 — Monaco fork direction; superseded by D13)
- [`docs/research/ladder-vs-density.md`](../research/ladder-vs-density.md) (cap analysis)
- [`docs/sooth_book/fork-plan.md`](./fork-plan.md) (superseded by this spec)
- [`docs/sooth_book/cu-analysis.md`](./cu-analysis.md) (CU bound)
- EVM source: `sooth-alpha/packages/contracts-core/src/{SoothBook,OrderEngine,AMMEngine,TruthMarket}.sol`, `libraries/TickBitmap.sol`
- Parent-ix introspection precedent: `packages/programs-core/programs/sooth_market/src/instruction_introspection.rs:71-156`

---

_Spec version: clean rewrite, 2026-05-11. Successor to rev 13. Bakes in all converged design decisions plus the 4 fresh-eyes findings (cross-program account-write violation, `matchLimit=0` parity gap, fee-dust rounding rule, W8 CU thresholds). Internally consistent in one pass._
