# The order book

How `sooth_core`'s central limit order book is built: one account per market,
one price axis, matching on chain. Source of truth is
`packages/programs-core/programs/sooth-core/src/book/` (`arena.rs`,
`account.rs`, `matcher.rs`, `settlement.rs`) and the five instructions in
`src/instructions/book_init.rs`, `book_place.rs` and `book_ops.rs`.

---

## 1. The shape, in one paragraph

The whole book for a market — both sides, every resting order, and a ledger
seat for every trader currently holding something — lives in **one
dynamically-grown zero-copy account**. Prices are a **single YES axis** in
ticks `1..=999`: a NO order at price `p` is stored as a YES order at
`1000 − p`, so buying NO and selling YES are the same order. **Matching happens
on chain**: the caller sends one instruction with a side, a limit tick, a size
and a `match_limit`, and the program walks its own book — there are no maker
bundles to precompute and nothing for the client to get stale. A fill therefore
touches **no account outside the book**, so the transaction envelope is flat in
the number of fills.

---

## 2. The account

```
seeds = [b"book", market_id]

  [0 .. 8)              8-byte discriminator (BOOK_DISCRIMINATOR)
  [8 .. 8+HEADER)       BookHeader
  [8+HEADER .. )        blocks: [OrderNode] — the arena, grown by realloc
```

`BookHeader` carries `market`, `next_seq`, `free_head`, `bids_head`,
`asks_head`, `seats_head`, `block_count`, `order_count`, `bump` and 56 reserved
bytes.

The account is **cast in place**, never deserialized: `load_book` checks the
discriminator, then `bytemuck::try_from_bytes_mut` / `try_cast_slice_mut` hand
back `&mut BookHeader` and `&mut [OrderNode]` pointing at the account's own
bytes. That is why nothing here allocates, and it is what the alignment
discipline pays for:

- Solana guarantees account data is 8-byte aligned, so **no stored struct may
  contain a `u128`** (16-byte alignment). Compile-time asserts pin
  `align_of ≤ 8` for `OrderNode` and `BookHeader`.
- The discriminator is 8 bytes and the header is a multiple of 8, so the block
  array starts 8-aligned. `assert_layout_offsets_are_aligned` re-derives that
  from `size_of` at build time, so adding a header field cannot silently
  misalign the arena.
- The cast uses bytemuck's **checked** API: a misaligned or mis-sized account
  is an error, not an abort.

### Blocks

The arena is a flat array of uniform **64-byte** blocks (`BLOCK_SIZE`), each of
which is one of two kinds:

```rust
OrderNode { amount: u64, trader: Pubkey, seq: u64,
            next: u32, prev: u32, price_tick: u16, side: u8, flags: u8, _pad }

SeatNode  { credit: u64, trader: Pubkey, net: i64,
            next: u32, _pad0, kind: u8, _pad1 }
```

`SeatNode::kind` sits at the **same byte offset** as `OrderNode::flags`, so a
block can be identified before it is interpreted; a `const` assert on
`offset_of!` enforces it, and the SDK decoder self-checks the same invariant at
import.

`amount` is a `u64` in **USDC base units** (6 decimals; one share is
`1_000_000` and redeems for 1.00). The book therefore speaks the vault's units,
and there is no WAD→base rounding in the storage layer.

### Ordering

Each side is an **intrusive sorted doubly-linked list** through `prev`/`next`,
maintained in strict **price-then-time** priority: `bids_head` is the highest
price first, `asks_head` the lowest, ties broken by the lower `seq`. Insert is
O(n) but costs roughly 60 CU per step, which is invisible against the fixed
cost of a transaction. Blocks come from a free list (`free_head`), so a cancel
returns its block to be reused rather than shrinking the account.

### Capacity and growth

`MAX_ORDERS = 4096` bounds **blocks**, not orders, and orders share the arena
with seats — one per currently-seated trader. So the live constraint is

```
live orders + seated traders ≤ 4096
```

which in people is 4,096 position holders, or 2,048 traders each resting one
order (a maker needs a seat *and* an order block). This is pinned by
`capacity_in_participants_not_orders`, because the constant's face value is not
the number anyone sizing a market needs.

The cap is a **ceiling, not an allocation**. `book_init` takes an initial
capacity and `book_grow` extends toward the limit one `realloc` at a time,
permissionlessly — gating growth would let a market wedge at capacity because
the one authority that could extend it was away. Solana caps `realloc` at
**10,240 bytes per instruction** (measured from the length at instruction
entry), which is 160 blocks a call, so reaching 4,096 takes 26 `book_grow`
calls across several transactions. `grow_target` never returns a step over the
cap and returns `None` at the ceiling, so callers can tell "grow again" from
"full".

Rent tracks what a market actually uses: ~0.116 SOL at 256 blocks, ~1.83 SOL
fully extended.

---

## 3. One price axis

Ticks are `1..=999` out of `NUM_TICKS = 1000`; price is `tick / 1000`, and
`0` and `1000` are rejected. `SIDE_BID` is buying YES, `SIDE_ASK` is selling
YES — which is the same trade as buying NO at the complement. A NO order at
`p` is stored as a YES order at `1000 − p`, so the book has one ladder rather
than two complementary ones.

Crossing is then an ordinary limit comparison rather than the two-sided
`taker_tick + maker_tick >= 1000` rule: a bid crosses any ask at or below its
limit, an ask crosses any bid at or above it.

**Fills execute at the maker's price.** That is what delivers the crossing
surplus to the taker: a NO buy at 0.55 is a YES sell at 0.45, so a YES buy with
a 0.60 limit crossing it executes at 0.45 and the taker keeps the 0.15. It
arrives as ordinary price improvement, with no rebate accumulator, no `surplus`
field and no separate escrow/sell concept — "selling" is just an ask.

---

## 4. Matching

`Book::place(taker, side, limit_tick, amount, fee_bps, match_limit,
post_remainder)` walks the opposite side from its head:

- It walks with a **cursor**, not by repeatedly taking the best, so a
  self-owned order can be stepped over rather than ending the match.
- **Self-trade prevention cancels the resting order** and carries on. A seat
  holds one signed `net`, so a seat cannot trade against itself; of the three
  possible policies, resting the incoming order leaves the book crossed against
  its own owner, and dropping the incoming order silently does nothing, so the
  resting order goes. Its escrow had no fill, so the refund is exact, and
  `MatchResult::self_trade_cancelled` reports it.
- The walk stops at `match_limit` fills, at the first non-crossing price (the
  list is price-ordered), or when the size is exhausted. Any remainder rests as
  a new order when `post_remainder` is set.

`MatchResult` returns `filled`, `resting`, `taker_collateral_in`,
`taker_collateral_out`, `fee`, `fills`, `self_trade_cancelled`, `resting_seq`
and the per-fill records for the event.

### Settlement arithmetic

On a signed net position (`net > 0` long YES, `net < 0` long NO) one rule
covers every mode:

```
collateral_in  = |delta| * (p if buying YES else 1 - p)
collateral_out = closing_amount * 1.0
```

where "closing" is the part of the move that reduces existing opposite
exposure. Mint, transfer and merge are consequences, not cases:

| taker | maker | collateral | mode |
|---|---|---:|---|
| opening | opening | `+p` and `+(1−p)` = **+1.0** | MINT |
| closing | closing | **−1.0**, less `p`/`(1−p)` back | MERGE |
| opening | closing | **0** | TRANSFER |

So the vault holds exactly 1.0 per unit of open interest **by construction** —
solvency is structural, not a check that runs afterwards. Pinned by
`the_vault_holds_exactly_one_per_unit_of_open_interest`, which re-asserts it
after every fill of a sequence.

`leg_costs` **derives** the second leg rather than flooring both: computing each
as `amount * tick / NUM_TICKS` floors twice and the pair can sum to
`amount − 1`, which would leave the vault short one base unit per fill. The
maker leg is floored and the taker takes the remainder, so the legs always
close exactly and the sub-cent is absorbed by the party already receiving price
improvement. A sweep asserts closure across ~5,600 (amount, tick, side)
combinations.

### Fees

```
fee = book_fee_bps × min(p, 1−p) × amount
```

taker-only, charged on the **executed** price, with the rate read from
`ProtocolConfig.book_fee_bps` and never from the caller. `min(p, 1−p)` is
invariant under the YES↔NO swap, so the two ways of expressing the same
position cost the same — a rate charged on `p` alone would make one route free.
It is also the amount actually at risk, so near-certain outcomes are cheap to
trade. Mutation-verified: charging on `p` fails three tests; releasing 0
instead of 1.0 on a close fails five.

---

## 5. Seats: credit stays in the book

A fill credits `SeatNode::credit` **inside the arena** instead of transferring
to a maker's ATA. That is Phoenix's seat model, and it is what removes the last
per-fill account from the fill path: the maker's order, the maker's seat and
the taker's seat are all blocks in the account the instruction already holds.

- `book_cancel` refunds an order's escrow to the owner's **seat credit**, not
  to their wallet. Escrow is recomputed from the node (side, tick, remaining),
  so a partially filled order refunds only what is left.
- `book_withdraw` is the single place credit becomes USDC. It zeroes the credit
  *before* the transfer, in its own scope, so a re-entrant call finds nothing.
- `redeem_book_seat` pays a settled market's position: the seat's signed `net`
  against the winning outcome, each winning share worth exactly one unit,
  `OUTCOME_INVALID` splitting — the same rule `redeem_amm_position` applies, so
  the ledgers cannot drift. It can never overpay, because every matched share
  was backed by a full unit at fill time and exactly one of the two holders is
  paid.

**Empty seats are reclaimed.** `take_credit` and `take_settlement` look a seat
up rather than creating one — an allocating lookup on the exit paths let any
signer consume the arena by "withdrawing" from a seat they never had — and
`free_seat_if_empty` returns the block to the free list once `credit` and `net`
are both zero. That is safe because a seat holds only those two fields and
orders reference their owner by **pubkey**, never by seat index, so an emptied
seat carries no information and a resting order whose seat was freed simply
rebuilds it on the next fill. Freeing is deliberately confined to the exit
paths: the matching loop caches seat indices across mutations, so returning a
block there could hand that index to another trader mid-match.

The consequence is that the cap is a **live** limit — live orders plus
currently-seated traders — rather than a cumulative one that counted everybody
who had ever touched the market.

---

## 6. The instructions

| instruction | what it does |
|---|---|
| `book_init` | creates the book PDA by hand (no `#[account]` type to size), writes the discriminator and a zeroed header, allocates an initial capacity |
| `book_grow` | extends the arena by one realloc step toward `MAX_ORDERS`; permissionless |
| `book_place` | place/match/rest; the only instruction that moves tokens on the way in |
| `book_cancel` | pull a resting order by `seq`; refund lands in seat credit |
| `book_withdraw` | seat credit → wallet |
| `redeem_book_seat` | settled position → wallet |

`book_place`'s account set is flat: `book`, `market`, `vault_authority`,
`vault_book`, `taker_usdc_ata`, `fee_pool_book`, `protocol_config`, `taker`,
`token_program`, plus the `#[event_cpi]` pair. `vault_book` is pinned by
`address = market.vault_book` **and** `mint == BOOK_TOKEN_MINT`, so the book
venue cannot be made to draw on the AMM's currency.

Its gates, in order:

1. `require_not_paused`
2. `market.is_open()` — a LOCKED or SETTLED market must not match, or a known
   outcome is free money against anyone with a stale resting order
3. `market.book_enabled` — the book opens at graduation and not before, read
   from `Market` rather than `AmmState` so the check costs no extra account
   (see `docs/design/dual-token-venues.md`)

`book_cancel` and `book_withdraw` are ungated by the pause flag and by the
lifecycle, deliberately: an exit must always be available, and after settlement
`book_cancel` is the only way a maker recovers escrow behind a resting order.

Token movement is **netted per transaction**, not per fill: the taker's
collateral in, collateral out and fee are accumulated across the whole match
and settled once at the end, however many orders were crossed.

### Events

Three events, each carrying a `version` byte as its first field
(`BOOK_EVENT_VERSION`): `BookOrderPlaced`, `BookOrderCancelled` and
`BookFilled` — with the fills **batched into one event**, since one inner
instruction per fill would put per-event overhead straight back into the
marginal cost. Decoders reject an unknown version rather than guessing, and
throw on trailing bytes.

They are emitted with Anchor's `#[event_cpi]` / `emit_cpi!`, so the payload
lands in an inner instruction rather than a program log. Solana permits direct
self recursion, which is exactly the mechanism Anchor uses — no second program
and no second deploy is needed for this.

---

## 7. Cost

Measured on LiteSVM by `packages/sdk-solana/tests/book-cu-budget.test.ts`,
including token movement and events:

| fills | CU | tx bytes | writable |
|---:|---:|---:|---:|
| 1 | 42,360 | 540 | 5 |
| 5 | 42,973 | 540 | 5 |
| 20 | 63,288 | 540 | 5 |
| 40 | 100,036 | 540 | 5 |
| 60 | 127,764 | 540 | 5 |

**Zero accounts and zero bytes per fill.** Transaction size and writable-account
count are flat whether the taker crosses one order or sixty; the marginal cost
is ~1,448 CU/fill, so the binding constraint is compute and book depth rather
than the 1,232-byte packet limit. No address lookup table is needed.

The measurement guards against a vacuous pass: it reads `order_count` out of
the account and asserts the book was actually drained, because a matcher that
silently no-op'd would report a flat CU curve and "pass".

Nothing walks the whole book on chain — `iter_side` is test-only and the event's
fill list is bounded by `match_limit` — so a larger arena does not make a fill
more expensive. The worst-case *insert* grows with depth at ~60 CU/step, about
246k CU at 4,096 blocks (~18% of the budget).

---

## 8. The 256 KB heap frame

`sooth_core` installs a custom 256 KB bump `#[global_allocator]` under the
`custom-heap` feature, which is **on by default** so the artifact under test is
the artifact deployed. The allocator hands out addresses from the top of a
region the runtime only maps when asked, so:

> **Every transaction must prepend
> `ComputeBudgetInstruction::request_heap_frame(256 * 1024)`.**

Without it *every* instruction faults at ~215 CU with "Access violation in heap
section" — a total failure that looks nothing like an allocator problem, and one
that cannot be detected and reported nicely because the mapped size cannot be
queried at runtime. `@sooth/sdk-solana` prepends the frame on all paths; a
hand-rolled caller or Anchor's plain `.rpc()` must do it too, and
`SOOTH_CORE_HEAP_LEN` is the exact value to pass.

The book itself does not need the heap — it allocates nothing. The frame is a
program-wide contract, and the one place the book still touches it is
`MatchResult::filled_orders`, a `Vec` sized by `match_limit`.

---

## 9. Trade-offs this design accepts

**A single hot account per market.** Writes to any one account are capped per
block, so a market's throughput is bounded no matter how many validators are
idle. Many markets shard naturally, since the limit is per account. Phoenix and
Manifest live with exactly this.

**Growth is a rent surface.** Anyone can push orders to force the account to
grow, and the arena can only shrink through the internal free list, never by
shrinking the account. Grief-growth is bounded by the block cap.

**A hard ceiling instead of a soft one.** An account-per-price-level book grows
until rent runs out; here 4,096 blocks is real, and raising it costs CU on the
insert walk rather than being free. For the depth public Polymarket books show
(63–101 price levels on their 30 most liquid markets) that is comfortable.

**Price-time priority is explicit.** It is maintained on insert rather than
falling out of an append-only per-tick vector, so it is real logic — pinned by a
property test that random insert/cancel sequences leave the lists price-then-time
ordered with no leaked blocks.

**Zero-copy means `bytemuck` discipline.** `Pod` types only: no `Option`, no
`Vec`, explicit padding, alignment-safe field ordering, and no `u128` anywhere
in a stored struct.

**Makers hold credit, not wallet balance.** An extra `book_withdraw` call is
standard (Phoenix, OpenBook and Serum all work this way), but clients must
surface claimable credit or it looks like missing money.

---

## 10. How this compares to the rest of the ecosystem

| Protocol | Book storage | Market rent | Settlement |
|---|---|---|---|
| **Phoenix** | 1 account, 3 Sokoban red-black trees, preallocated | 0.59 – 12.0 SOL | internal seats; ≤1 deposit + 1 withdraw per ix |
| **OpenBook v2** | zero-copy critbit, 2 × 90,944 B | ~1.91 SOL | ≤15 makers inline, rest spill to a 600-slot EventHeap |
| **Serum v3** | critbit slab | ~2.78 SOL | crank required |
| **Manifest** | 1 account, uniform 80 B blocks + free list, grown by realloc | 0.0073 SOL | internal seats |
| **Drift v2** | no on-chain book; orders in per-user 4,376 B accounts | — | keepers pass maker `User`s in remaining_accounts |

On binary markets specifically: single-book venues (Kalshi, Drift BET, Monaco)
never let `a + b > 1` exist — a NO bid at `b` is stored as a YES ask at `1 − b`,
which is the axis used here. Where surplus can arise it goes 100% to the taker
(Polymarket refunds leftover collateral to the taker; Drift fills at the maker
price). Everyone uses discrete ticks.

Ecosystem rent figures were recomputed from `(128 + bytes) × 6960` rather than
taken from vendor docs. The Monaco GitHub org 404s and
`docs.monacoprotocol.xyz` does not resolve, so Monaco details are from
secondary write-ups and are lower-confidence.

- Phoenix — <https://github.com/Ellipsis-Labs/phoenix-v1>
- OpenBook v2, Serum v3 — on-chain program sources
- Manifest — README + program source
- Drift prediction markets — <https://docs.drift.trade/prediction-markets/prediction-markets-intro>
- Polymarket CTF Exchange — contract sources and `py-clob-client` issue #245
- Kalshi — public rulebook and fee schedule
