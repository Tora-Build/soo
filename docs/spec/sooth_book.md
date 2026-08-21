# Order book — one account, one price axis

> Subsystem: `book/` (`account.rs`, `arena.rs`, `matcher.rs`, `settlement.rs`)
> plus `instructions/book_init.rs`, `book_place.rs`, `book_ops.rs`,
> `redeem_book_seat.rs`, `distribute_fees_book.rs`.
> Canon law: [`law/orderbook.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/orderbook.md).

---

## 1. Shape of the design

The whole book for a market is **one account**. It holds both sides, every
resting order, and a per-trader seat carrying that trader's signed position and
withdrawable credit. Matching runs on chain: the caller submits an order and the
program walks the book. There are no maker bundles, no address lookup tables and
no account-per-tick.

Everything is quoted on a **single YES-price axis** in ticks `1..=999`. Buying NO
at price `b` is submitted as *selling YES* at `1 - b`. One axis, two directions,
and a position is a single signed number — which is what turns crossing into an
ordinary limit comparison and makes "the crossing surplus goes to the taker" fall
out of price improvement instead of a rebate accumulator.

The book is the **mature venue**: closed until the market graduates from the AMM
(§7), and priced in `BOOK_TOKEN_MINT` — USDC on mainnet, the project-controlled
mock on devnet — not in the AMM's instance token.

## 2. The `Book` account

**Seeds:** `[b"book", market.market_id]`.

Layout (`book/account.rs`):

```text
[0..8)      BOOK_DISCRIMINATOR = [0x4b,0x6f,0x6f,0x42,0x00,0x01,0x00,0x00]
[8..136)    BookHeader (128 B, zero-copy)
[136..)     OrderNode[] — the arena, BLOCK_SIZE = 64 B per block
```

`book_space(capacity) = 136 + 64 * capacity`, and `capacity_for(len)` truncates a
partial trailing block. The account is created by a hand-rolled
`system_program::create_account` CPI rather than Anchor `init`, because it is
loaded by raw `bytemuck` cast and its length changes over the market's life.
`load_book` checks length, discriminator and alignment; every failure surfaces as
`SoothCoreError::InvalidBookAccount`.

A compile-time assert pins every offset to an 8-byte boundary. Nothing in the
account is a `u128` — 16-byte alignment would break the cast on SBF.

### 2.1 `BookHeader`

| Field         | Type     | Meaning                                                 |
| ------------- | -------- | -------------------------------------------------------- |
| `market`      | `Pubkey` | owning market PDA                                        |
| `next_seq`    | `u64`    | monotonic per-market order sequence, assigned on insert   |
| `free_head`   | `u32`    | head of the free-block list, or `NIL`                    |
| `bids_head`   | `u32`    | best bid first: highest price, then earliest `seq`       |
| `asks_head`   | `u32`    | best ask first: lowest price, then earliest `seq`        |
| `block_count` | `u32`    | high-water mark of blocks handed out; never decreases     |
| `order_count` | `u32`    | live orders across both sides                            |
| `seats_head`  | `u32`    | head of the seat list, or `NIL`                          |
| `bump`        | `u8`     | book PDA bump                                            |

`NIL` is `u32::MAX`, not `0` — index 0 is a real block.

### 2.2 Capacity and growth

`MAX_ORDERS = 4096` caps **blocks**, and blocks are shared between orders and
seats. It is therefore neither an order cap nor a user cap: a pure position
holder costs one block (their seat), so 4096 of them fit; a resting maker costs a
seat plus an order, so 2048 of those fit. The ceiling comes from insert cost
(O(n), ~60 CU per step, ~246k CU at full depth) and rent (~1.83 SOL fully
extended), not from Solana's 10 MiB account limit.

Growth is incremental because the runtime permits at most
`MAX_PERMITTED_DATA_INCREASE = 10_240` bytes of growth per instruction:

| Instruction                        | Behaviour                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `book_init(initial_capacity: u16)` | clamps to `MAX_ORDERS`, then requires `book_space(capacity) <= 10_240` (`BookCapacityTooLarge`) — max 157 blocks (`blocks_offset()` is 136, so 158 needs 10,248 bytes) |
| `book_grow(wanted_capacity: u16)`  | one realloc step, at most 160 blocks; tops up rent from `payer` **before** `realloc`; reaching 4096 takes 26 calls |

Asking `book_grow` for a capacity the book already has is a logged no-op, not an
error. Both instructions are **permissionless** and neither is gated on
graduation: only rent is at stake, and a gate would let a market wedge itself at
capacity.

### 2.3 Arena nodes

`OrderNode` is exactly 64 bytes:

| Field        | Type     | Notes                                                          |
| ------------ | -------- | ---------------------------------------------------------------- |
| `amount`     | `u64`    | unfilled size in base units; `ONE_SHARE = 1_000_000`             |
| `trader`     | `Pubkey` | owner — orders name their owner, never a seat index               |
| `seq`        | `u64`    | per-market sequence; lower = higher time priority                 |
| `next`       | `u32`    | next in side list, or `NIL`; doubles as the free-list link        |
| `prev`       | `u32`    | back link                                                         |
| `price_tick` | `u16`    | YES price tick                                                    |
| `side`       | `u8`     | `SIDE_BID = 0` buy YES / `SIDE_ASK = 1` sell YES (= buy NO)       |
| `flags`      | `u8`     | shares its byte offset with `SeatNode::kind`                      |

`SeatNode` occupies the same 64 bytes, reached by `bytemuck` cast — **one seat
per trader**:

| Field    | Type     | Notes                                                 |
| -------- | -------- | ------------------------------------------------------- |
| `credit` | `u64`    | withdrawable base units                                 |
| `trader` | `Pubkey` |                                                          |
| `net`    | `i64`    | signed position: `> 0` long YES, `< 0` long NO          |
| `next`   | `u32`    | next seat, or `NIL` — same offset as `OrderNode::next`  |
| `kind`   | `u8`     | `KIND_SEAT`; same offset as `OrderNode::flags`          |

Allocation pops `free_head`, else bumps `block_count`; `BookError::Full` once the
index reaches `MAX_ORDERS` or the account's block count. `free(idx)` writes a
fully zeroed node whose `next` is the old free head, so a recycled block can
never surface a stale trader, and `remove` recognises that zeroed shape to refuse
a double free (`BookError::NotFound`).

### 2.4 Ordering

There is no bitmap and no per-tick list. Each side is a single intrusive **sorted
doubly-linked list** through the same blocks, kept ordered on insert by
`outranks`: better price wins, and at equal price the lower `seq` wins. Because
the list is price-ordered, the matcher can `break` at the first non-crossing
node. Insert is O(n) by deliberate choice; `next`/`prev` are tree-compatible if
that ever has to become a balanced tree.

`bitmap.rs` and `math/book.rs` are leftovers from the retired account-per-tick
book. Nothing in the live book calls them.

### 2.5 Seats

- `seat_mut(trader)` allocates a seat if the trader has none. Trading paths only.
- `seat_of(trader)` is the non-allocating lookup used by `take_credit` and
  `take_settlement`. With an allocating lookup there, any throwaway signer could
  consume the capped arena by "withdrawing" nothing.
- `free_seat_if_empty(trader)` unlinks and frees a seat once
  `credit == 0 && net == 0`. Safe because a seat is pure derived state and orders
  reference their owner by pubkey. It is deliberately never called inside the
  match loop, which caches seat indices that a free could re-alias to another
  trader mid-call.

## 3. `book_place`

```rust
book_place(ctx, side: u8, limit_tick: u16, amount: u64, match_limit: u32, post_remainder: bool)
```

| Arg              | Meaning                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `side`           | `SIDE_BID` buy YES, `SIDE_ASK` sell YES (= buy NO); anything else is `InvalidOutcome`    |
| `limit_tick`     | worst acceptable YES price, and the tick a remainder rests at                            |
| `amount`         | size in base units (shares × 1e6)                                                        |
| `match_limit`    | hard cap on distinct fills in this call; bounds CU and the fill event; `0` = pure post   |
| `post_remainder` | rest the unfilled part at `limit_tick`; otherwise it is dropped (IOC)                    |

The fee rate is **not** an argument — the handler passes
`ProtocolConfig.book_fee_bps`.

Preconditions: `require_not_paused`, `market.is_open()`, `market.book_enabled`
(`NotGraduated`), and `assert_within_trading_window(now, market.deadline)`
(`TradingClosed`) — so a resting order cannot outlive the deadline. `limit_tick` is not validated up front; an out-of-domain
tick fails inside `leg_costs` and surfaces as `MatchFailed`. There is no minimum
order size.

### 3.1 Crossing and execution price

`crosses(taker_side, taker_tick, resting_tick)` is an ordinary limit comparison
on the unified axis: a bid crosses when `resting_tick <= taker_tick`, an ask when
`resting_tick >= taker_tick`. A YES buy at `p_b` meeting a NO buy at `p_n` is a
bid at `p_b` against an ask at `1 - p_n`; they trade exactly when
`p_b + p_n >= 1`.

Execution is at the **maker's** tick, so the crossing surplus is price
improvement for the taker.

### 3.2 Leg math and the solvency invariant

`leg_costs(price_tick, amount, taker_side)` splits a fill into a bid leg and an
ask leg in base units, with `bid_cost + ask_cost == amount` guaranteed: the
maker's leg floors, the taker's leg takes the remainder. Flooring both legs
independently would lose a base unit per fill and bleed the invariant below.

`settle_leg` turns a leg into collateral movement using
`split_delta(old_net, delta)`, which separates the part of the trade that
*closes* existing opposite exposure from the part that *opens* new exposure:

- `collateral_in = own_cost`
- `collateral_out = closing` — a closed share releases the full 1.00 backing it
- `new_net = old_net ± amount`

No case analysis is needed anywhere. Two openings mint (1.00 flows in), two
closings merge (1.00 flows out), an opening against a closing transfers (nets to
zero). What falls out: **the vault holds exactly 1.00 per unit of open interest,
at all times.**

### 3.3 Escrow

A maker's collateral is escrowed when they post. `escrow_of(node)` recomputes it
from `side`, `price_tick` and the order's *remaining* `amount` — it is never
stored, so a partially filled order escrows only for what is left. On a fill the
maker's seat takes the position change and is credited only what the fill
*closed*.

The taker's collateral in and out are accumulated across all fills and settled
once at the end of the instruction. When `post_remainder` fires, the resting
escrow for the remainder is added to that total.

### 3.4 Self-trade prevention

A seat carries one signed `net`, so a seat cannot trade against itself. When the
walk reaches an order whose `trader` is the taker, that resting order is removed
and its escrow refunded to the taker's seat credit, and the walk **continues**.
Walking with a cursor (read before removal) rather than repeatedly taking the
best is what lets a self-owned order be stepped over without shielding strangers
queued behind it; FIFO among everyone else is preserved.

### 3.5 Fees

Taker-only, on the executed price:

```text
fee = amount * min(tick, NUM_TICKS - tick) * fee_bps / (NUM_TICKS * 10_000)
```

`min(p, 1-p)` is invariant under the YES↔NO swap, so two complementary routes to
the same exposure cost the same — a rate applied to one leg's cost is
arbitrageable by choosing the cheaper leg. The computation carries a `u128`
intermediate and floors; costs are whole base units here, so no floor-on-sum
ceremony is needed. `fee_bps` comes from `ProtocolConfig.book_fee_bps` (bounded
by `MAX_FEE_BPS = 10_000` at `initialize_protocol`), never from the caller.

### 3.6 Token movement

However many fills a call performs, at most **two** transfers move collateral,
plus one for the fee:

```text
owed = taker_collateral_in + fee
owed > out  →  pull (owed - out)   taker ATA → vault_book, taker signs
out  > owed →  pay  (out - owed)   vault_book → taker ATA, vault_authority signs
fee  > 0    →  fee                 vault_book → fee_pool_book, vault_authority signs
```

Accounts: `book`, `market`, `vault_authority` (`[b"vault", market_id]`),
`vault_book` (pinned to `market.vault_book`, mint pinned to `BOOK_TOKEN_MINT`,
else `VaultAuthorityMismatch`), `taker_usdc_ata`, `fee_pool_book`
(`[b"fee_pool_book", market_id]`), `protocol_config`, `taker`, `token_program`.
**A fill costs zero extra accounts and zero extra transaction bytes.**

Events (`emit_cpi!`, so they survive log truncation):
`BookFilled { version, market, taker, taker_side, fills, fee, ts }` batches every
fill in the call, and `BookOrderPlaced { version, market, seq, trader, side,
price_tick, amount, ts }` reports a resting remainder. `BOOK_EVENT_VERSION` is
`1`, carried as the first field. A self-trade cancellation is a `msg!` only.

## 4. Cancel and withdraw

The flow is **escrow → seat credit → wallet**, split in two so that a fill never
moves tokens.

`book_cancel(order_seq)` scans both sides for that sequence number, requires the
signer to own it (`NoCancellableOrder` covers both wrong-owner and not-found),
credits `escrow_of(node)` to the owner's seat, and frees the block. Its accounts
are `book`, `market`, `owner` — **no token accounts at all**. It is gated on
neither pause nor lifecycle: a maker must always be able to exit, and after
settlement cancelling is the only way to recover escrow. Emits
`BookOrderCancelled { version, market, seq, trader, refund, ts }`.

`book_withdraw()` zeroes the seat's `credit` **before** the transfer, moves it
from `vault_book` to the caller's ATA under the vault authority, then frees the
seat if it is now empty. Also ungated by pause. No seat means zero, not an error.

## 5. Settlement

`settle` does not touch the book. Book settlement is entirely pull-based.

`redeem_book_seat` requires `market.is_settled()` and calls
`take_settlement(user, market.winning_outcome)`:

| Outcome       | Payout from `net`     |
| ------------- | --------------------- |
| `YES` (1)     | `net > 0 ? net : 0`   |
| `NO` (0)      | `net < 0 ? -net : 0`  |
| `INVALID` (2) | `abs(net) / 2`        |

The seat's `credit` is added, both fields are zeroed **before** the transfer
(re-entrancy safety), the seat is freed if empty, and one
`vault_book → user ATA` transfer pays out under the vault authority. It emits
`Redeemed` with `yes_burned` and `no_burned` at zero — book positions are ledger
entries, not SPL outcome tokens.

The book cannot overpay: each matched share was backed by exactly 1.00 across the
two legs, and exactly one holder is paid for it. The `INVALID` half-payout
matches `redeem_amm_position` so the two ledgers cannot drift.

Resting orders are deliberately untouched by settlement; their escrow comes back
through `book_cancel`.

`Book::total_obligations(winning_outcome)` sums, over all seats, the winning-side
payout plus credit, and over both side lists every order's escrow — at full value
even post-settlement, since escrow is a pure refund obligation. It exists to prove
that `reclaim_subsidy` cannot reach into trader collateral.

There is **no residual sweep for the book venue**. The book is zero-sum between
seats and fees leave through the fee pool, so `vault_book` reaches zero
organically once every seat has withdrawn.

`close_market` takes the book as an optional account and, when it is present and
live, requires `order_count == 0` and every seat to satisfy
`net == 0 && credit == 0` (`BookNotEmpty`), plus empty `vault_book`,
`fee_pool_book` and `lp_yield_book`. The book's rent is then reclaimed.

## 6. Fee distribution

`distribute_fees_book` is a permissionless crank that drains the whole
`[b"fee_pool_book", market_id]` vault (`NothingToDistribute` when empty):

```rust
to_lp_yield    = total * cfg.lp_yield_share_bps    / 10_000;  // floor
to_adjudicator = total * cfg.adjudicator_share_bps / 10_000;  // floor
to_protocol    = total - to_lp_yield - to_adjudicator;        // remainder
```

`b_base_share_bps` is deliberately unread here: that slice exists to deepen LMSR
liquidity, which is denominated in the AMM's token, so on the book side it folds
into the protocol remainder rather than becoming undrainable dust. If
`lp_mint.supply == 0` the LP slice folds into the protocol share too — yield paid
after the last LP token was burned would be unclaimable and would block
`close_market`.

Destinations: the `lp_yield_book` vault (`[b"lp_yield_book", market_id]`), the
adjudicator's token account, and the protocol treasury; all pinned to
`BOOK_TOKEN_MINT`, none chosen by the caller. Zero-amount legs are skipped. Emits
`MarketFeesDistributed` with `to_b_base: 0`.

## 7. Gating

`Market.book_enabled` starts `false` and is set `true` at exactly one site: in
`trade_positions`, immediately after AMM graduation fires. Graduation is one-way,
so the two flags (`AmmState.is_graduated` and `Market.book_enabled`) cannot
drift. The mirror exists because `book_place` loads `Market` and not `AmmState`;
reading the real flag would add an account and 32 bytes to every order,
permanently, to learn one bit.

| Instruction        | Gate                                    |
| ------------------ | --------------------------------------- |
| `book_init`        | none — permissionless, rent only        |
| `book_grow`        | none                                    |
| `book_place`       | `is_open` + `book_enabled` + not paused + before `deadline` |
| `book_cancel`      | owner signature only                    |
| `book_withdraw`    | signature only                          |
| `redeem_book_seat` | `is_settled`                            |

## 8. Constraints

- **The heap frame is mandatory.** Matching allocates on the program's 256 KB
  bump heap; every transaction must prepend
  `request_heap_frame(256 * 1024)` or the program dies on a mapped-memory
  violation before it can report anything.
- **Never floor both legs of a fill.** `leg_costs` exists precisely so
  `bid + ask == amount` holds exactly; the alternative bleeds the vault.
- **Never charge the fee on one leg's cost.** The `min(p, 1-p)` form is what
  makes the YES and NO routes to the same exposure cost the same.
- **Never call the allocating seat lookup on a withdraw or settlement path.** The
  arena is capped; an allocating lookup there is a denial-of-service vector.
- **Never free a seat inside the match loop.** The loop caches seat indices, and
  a freed index can be re-allocated to a different trader mid-call.
- **Never gate cancel or withdraw.** An exit that can be paused or expired traps
  maker collateral.
- **Zero before you transfer.** Both `take_credit` and `take_settlement` clear
  the seat fields before the CPI.

## 9. Cross-references

- Decision log: D14 (on-chain book only), D21 (two venues, two tokens),
  D23 (one account, one price axis)
- Design note: [`docs/design/orderbook-redesign.md`](../design/orderbook-redesign.md)
- Sibling specs: [`sooth_market.md`](./sooth_market.md),
  [`sooth_amm.md`](./sooth_amm.md), [`sooth_launchpad.md`](./sooth_launchpad.md)
