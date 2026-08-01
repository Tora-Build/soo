# Orderbook & Matching Engine — Redesign Plan

Status: **proposal**. Written 2026-07-31 against `develop` @ `87afc51`.

Context: we are deploying at fresh program IDs, so nothing here is constrained by
migration, account compatibility, or the existing devnet deployment. This is a
clean-sheet design bounded only by what we want to keep.

---

## 1. Recommendation in one paragraph

Keep the tick grid. Throw away the account-per-tick model. Move the entire book
into **one dynamically-grown, zero-copy account per market** holding both sides
plus an internal maker-credit ledger, and collapse the two-sided YES/NO book into
a **single price axis** where a NO order at price `b` is stored as a YES order at
`1 - b`. Together these take a fill from *3 accounts + ~99 bytes + ~29.5k CU* down
to *0 accounts + 0 bytes + an estimated 5–10k CU*, which moves the ceiling from
**5 fills per transaction to somewhere in the 50–150 range**, removes the need for
address lookup tables entirely, removes the 256 KB heap allocator, and cuts
thin-book rent roughly 2.5×. The AMM needs no change.

---

## 2. What we have today (measured, not recalled)

### Structure

| Account | Cardinality | Size | Created |
|---|---|---|---|
| `MarketBook` | 1 per market | 432 B fixed | `init_if_needed` on first buy |
| `BookSide` | 1 per **(market, side, tick)** | `51 + 60n`, cap 50 orders | lazily, on first resting order at that tick |
| `OrderbookPosition` | 1 per (market, user) | 120 B | lazily, by hand |

Ticks are `1..=999` out of `NUM_TICKS = 1000`; price = `tick/1000`. Crossing is
`taker_tick + maker_tick >= 1000`. Best-price-first is a **bitmap scan**
(`find_next_down`) over two `[u64;16]` tick bitmaps in `MarketBook`.

Matching is entirely **caller-driven**: the client computes the crossing sequence
off-chain and passes one 3-account bundle per fill in `remaining_accounts` —
`[book_side, maker_orderbook_position, maker_usdc_ata]`. The program never
discovers makers.

### Costs

| fills | tx bytes | writable | CU |
|---:|---:|---:|---:|
| 1 | 778 | 10 | 66,708 |
| 3 | 976 | 16 | 128,661 |
| 5 | 1174 | 22 | 184,749 |
| 6 | **1273 → rejected** | | |

Marginal per fill: **99 bytes** (3 keys × 32 + 3 index bytes), **3 writable
accounts**, **~29,510 CU**. Fixed floor: 679 bytes, 7 writable, ~37,200 CU.

The binding limit is **transaction size**. Compute sits at 13.2% of the 1.4M cap
and account locks at 22 of 64. There is only 58 bytes of headroom at 5 fills — one
priority-fee instruction eats the 5th fill.

### Rent, for a thin book (10 orders across 8 ticks)

19 accounts, 2,640 bytes of payload → **0.0353 SOL ≈ $7.06** at SOL=$200.

The naive `bytes × 6960` model says $3.67. The real number is nearly double
because rent is `(128 + bytes) × 6960` — **every account carries a 128-byte
surcharge**, ~$0.178 each. With 19 accounts, $3.38 of that $7.06 is pure
per-account overhead. This is the single most important number in this document:
**splitting state across accounts is what costs money, not the bytes.**

### Why the 256 KB heap exists

`BookSide` is a borsh `Vec<InlineOrder>` of up to 50. `try_deserialize` heap-
allocates the whole thing, and the nine `Box<Account<..>>` in `BuyOrder` add more.
Measured: ~5 KB base + ~8 KB per fill, OOMing at 4 fills on the stock 32 KB heap.
So we installed a custom 256 KB bump `#[global_allocator]` and made
`requestHeapFrame(262144)` a mandatory contract on **every instruction in the
program**, including AMM ones that have nothing to do with the book.

`matching.rs` then works around its own data structure: it deliberately does *not*
deserialize `BookSide` inside the loop, and instead hand-parses raw bytes at fixed
offsets. That is the code that silently broke this morning when padding shifted
one field.

---

## 3. Bugs found during the study — fix these regardless of redesign

These are independent findings. Several are more urgent than the redesign.

### Resolved (2026-07-31)

**B0 — the LMSR subsidy was never funded.** `seed_lp` recorded
`seed_deposit_wad` and transferred nothing, so the vault was structurally short
by up to `b·ln(2)` and could not pay a winning AMM position at all. Fixed:
`seed_lp` now requires and transfers the subsidy. See decision-log D19. Residual
gap: no reclaim path for the *unspent* subsidy after settlement — that needs
outstanding-obligation accounting across all three ledgers, which this redesign
restructures anyway.

**B1 — AMM winners had no exit.** Fixed by `redeem_amm_position`. **B2** ticks
un-swapped and surplus split out of the payout. **B4** replaced with the shared
`create_orderbook_position`. **B6** — which turned out to be a permissionless
drain of the entire LP yield vault, not merely weak binding — bound to a single
market and verified by mutation. **B5** was a false positive and is closed.

Remaining from §3: B3, B7–B12.

### Original writeup

**B1 — AMM winners have no exit.** There is no instruction anywhere that reads
`Position.yes_shares` / `Position.no_shares` and pays out. `redeem` drains SPL
outcome tokens, `redeem_orderbook` drains the CLOB ledger, `redeem_from_program_owned`
handles program-owned sets — **nothing pays an AMM position after settlement**.
Every AMM buyer's winnings are currently stranded on-chain. This is a
funds-are-stuck bug and it is not caused by anything in this redesign.

**B2 — `FillRecord.yes_tick` / `no_tick` are swapped** (`matching.rs:191-195`), and
`FillRecord.surplus` double-counts escrow sale proceeds (`matching.rs:202`). The
indexer and anything built on `/v12/fills` is reading wrong data today.

### High

**B3 — a price level can wedge permanently.** `MAX_ORDERS_PER_TICK` is checked
against `bs.orders.len()`, which counts zeroed tombstones, and `compact_book_side`
only pops **trailing** zeros. One cancelled order in the middle of a full tick
means that tick returns `BookSideFull` forever.

**B4 — the D-2 bug pattern is back.** `cancel.rs::ensure_position_exists_for_cancel`
funds the position PDA with a bare system transfer and writes the discriminator
without `allocate` + `assign` — the exact hazard `orderbook_common.rs:48-52`
documents as mandatory, and the one we fixed in `create_orderbook_position`.

**B5 — self-cross double-init.** When `taker == maker`, `fill_order_internal` calls
`load_or_init_position` twice on the same account; if it does not yet exist both
calls see `data_is_empty()`.

**B6 — `redeem_lp` account binding is weak.** `amm_state` is constrained only on
`is_graduated` — no seeds, no `has_one = market`, no link to `lp_mint`.

### Medium

- **B7** — `cancel_by_id` scans from index 0, but the bitmap-clear check only
  inspects `orders[head_index..]`, so bitmap accounting diverges between
  `cancel.rs` and `cancel_by_id.rs`.
- **B8** — `match_at_tick` writes back a partially-advanced `head_index` on early
  exit (bundle exhaustion or `match_limit`).
- **B9** — divergent tick validation: `orderbook_common.rs` accepts `tick <= 1000`
  (so 0 and 1000 pass) while `math/book.rs` requires `1..=999`.
  `fill_order_internal` uses the loose check.
- **B10** — graduation mints LP off a **stale pre-trade snapshot**, so the trade
  that graduates a market still mints LP.
- **B11** — escrow (sell) legs pay **zero protocol fee**; the fee block is gated on
  `!taker_escrow`. Whether that is intended is a product question, but it is
  undocumented.
- **B12** — rent ratchets: `BookSide` only grows, compaction never refunds, and
  `close_book_side` pays the reclaimed rent to whichever permissionless caller
  races for it — not to the makers who funded the growth.

---

## 4. What the rest of the ecosystem does

| Protocol | Book storage | Market rent | Settlement | Fills/tx |
|---|---|---|---|---|
| **Phoenix** | 1 account, 3 Sokoban red-black trees (bids/asks/traders), preallocated | 0.59 – 12.0 SOL | internal "seats"; ≤1 deposit + 1 withdraw per ix regardless of fill count | uncapped, CU-bound |
| **OpenBook v2** | zero-copy critbit, 2 × 90,944 B | ~1.91 SOL | ≤15 makers settle inline, rest spill to a 600-slot EventHeap | ~15 inline |
| **Serum v3** | critbit slab | ~2.78 SOL | crank required | — |
| **Manifest** | 1 account, 256 B header + **uniform 80 B blocks**, red-black trees + free list, **grown by realloc** | **0.0073 SOL** | internal seats | — |
| **Drift v2** | no on-chain book; orders in per-user 4,376 B accounts | — | keepers pass maker `User`s in remaining_accounts | account-lock bound |

And on binary-market matching specifically:

- **Two families exist.** Polymarket-style *two-token* exchanges hold separate
  YES/NO mints and cross two buys when `price_a + price_b >= 1`, minting a
  complete set. Single-book venues (**Kalshi, Drift BET, Monaco**) never let
  `a + b > 1` exist: a NO bid at `b` is *stored as* a YES ask at `1 - b`, which
  makes the two-bid case structurally identical to buy-vs-sell.
- **Where surplus can arise, it goes 100% to the taker.** Polymarket refunds
  leftover collateral to the taker; Drift explicitly fills at maker price.
- **Everyone uses discrete ticks.** Kalshi 1¢ hard, Polymarket 0.01 tightening to
  0.001 at the tails, Monaco a 317-rung ladder, Drift a per-market `tick_size`.
- **Monaco's cost of FIFO** is a per-(outcome, price, side) PDA — up to ~1,268
  accounts per binary market. That is our design, and it is why they need a crank.

---

## 5. The two insights this points to

### Insight 1 — ticks are not the problem; *account-per-tick* is

Every serious venue uses a discrete price grid. Our tick grid is fine. What is
expensive is that `tick` is a **PDA seed**, so each price level is its own account
that must be created, rent-funded, passed into the transaction, locked, and
hand-parsed. That is where the 99 bytes/fill, the 3 writable/fill, the 19-account
thin book, and the raw-offset parsing all come from.

Manifest is the proof that you can have a single-account book *without* Phoenix's
0.59 SOL floor: uniform fixed-size blocks in one account, allocated from a free
list, grown by `realloc` on demand. Market creation costs 0.0073 SOL.

### Insight 2 — the surplus you want is just price improvement on a unified axis

You asked for: *"matches YES + NO to one, and excess goes to whoever makes the
order fill."* Today that is implemented literally — two-sided book, cross when
`tick_y + tick_n >= 1000`, rebate the excess to the taker
(`fill_order_internal.rs:120-133`). Confirmed: **100% of surplus already goes to
the taker**, and that matches Polymarket and Drift.

But the same economics fall out of a **single price axis** for free:

> A NO buy at 0.55 *is* a YES sell at 0.45.
> A YES buy at 0.60 crossing a YES sell at 0.45 executes at the maker's 0.45.
> The taker keeps 0.15 — which is exactly the surplus, arriving as ordinary
> price improvement rather than as a separate rebate accumulator.

This is not a semantic change. It is the same market, expressed in one axis
instead of two. What it buys:

- One book instead of two sides that must be kept complementary.
- `surplus` stops being a concept — no `pending_taker_payout` accumulator, no
  `FillRecord.surplus` field (and no B2-class bug in it).
- The `escrow` flag disappears. Today `escrow=true` means "collateralized with
  shares of the opposite side, i.e. a sell", with mirrored dust thresholds
  (`value_tick = NUM_TICKS - tick`), inverted share indices (`side ^ 1`), and a
  fee exemption. All of that is just "this is a sell order".
- All four trade shapes collapse into one code path, with the settlement layer
  choosing what to do based on what each party holds:

  | taker | maker | settlement |
  |---|---|---|
  | buy YES | sell YES (holds shares) | transfer shares |
  | buy YES | buy NO (posts collateral) | **mint** a complete set |
  | sell YES | buy YES | transfer shares |
  | sell YES | sell NO | **merge** and burn a complete set |

---

## 6. Proposed design

### 6.1 One `Book` account per market

```
Book (zero-copy, #[account(zero_copy)], grown by realloc)
├── header  (~256 B, fixed)
│     market, bump, next_seq, free_list_head,
│     bids_root, asks_root, traders_root, block_count,
│     _reserved
└── blocks[] (uniform 80 B, allocated from a free list)
      each block is one of:
        Order  { prev, next, price_tick, seq, trader_idx, amount, flags }
        Trader { pubkey, credit_usdc, yes_shares, no_shares, ... }
```

Uniform-size blocks in one arena, Manifest-style. Orders and trader seats share
the arena, so a market with many orders and few traders and a market with the
reverse both fit without preallocating for the worst case of each.

**Ordering structure: start with an intrusive sorted doubly-linked list**, not a
red-black tree. Insert is O(n), but for the book sizes we actually see (tens of
orders) pointer-chasing in zero-copy memory is a few hundred CU, and a linked
list is perhaps 150 lines against a red-black tree's 600+. The block layout is
deliberately tree-compatible (`prev`/`next` become child pointers), so if a market
gets deep enough to need O(log n) we swap the index without touching the arena,
the settlement layer, or the wire format. **Ship the list; earn the tree.**

### 6.2 Maker credits live in the book (seat model)

A fill credits `Trader.credit_usdc` inside the arena instead of doing an SPL
transfer to `maker_usdc_ata`. A separate `withdraw` instruction moves credit to a
real ATA. This is exactly what Phoenix seats do and it is what removes the maker
ATA — and therefore the last per-fill account — from the fill path.

### 6.3 What a fill costs after this

Per fill: **0 additional accounts, 0 additional transaction bytes.** The entire
book and every trader seat live in the one `Book` account, which is already
writable in the transaction.

Fixed account set for a buy becomes roughly: `taker`, `market`, `book`, `vault`,
`fee_pool`, `taker_usdc_ata`, `config`, `token_program` — about 8, flat,
**independent of fill count**.

| | today | proposed |
|---|---|---|
| accounts per fill | 3 | **0** |
| bytes per fill | 99 | **0** |
| CU per fill | ~29,510 | **est. 5,000–10,000** |
| fills per tx | **5** | **est. 50–150** (CU-bound) |
| thin-book rent | $7.06 / 19 accounts | **est. $2.76 / 1 account** |
| ALT needed? | yes, to get past 5 | **no** |
| 256 KB heap? | mandatory | **removable** |

The CU estimate is the least certain number here and must be measured on the
prototype before anyone relies on it. It assumes no per-fill CPI (credits are
memory writes) and no per-fill account load.

### 6.4 The AMM stays as-is

The study confirmed the AMM and CLOB are **structurally decoupled**: they share
exactly `market.vault`, `market_fee_pool`, `Market` and `ProtocolConfig`, and
nothing else. No AMM code reads the book; no CLOB code reads `AmmState`. The
spec'd "no orderbook before graduation" gate does not exist in `buy.rs`.

**Replacing the book requires zero AMM changes.** The only things the redesign
must preserve are the shared vault's solvency and the fee-pool PDA address.

LMSR is also not a bottleneck — measured 32.7k–55.5k CU worst case for the math,
inside a ~75–80k CU trade. Leave it alone. (But fix **B1** — the missing redeem
path — which is an AMM bug, not a CLOB one.)

---

## 7. Tradeoffs — what this costs us

**A single hot account per market.** `MAX_WRITABLE_ACCOUNT_UNITS` is 24M CU per
account **per block**. At ~60k CU per order that is ~400 orders/block for a single
market. For a prediction-market launchpad this is a non-issue — and note the limit
is *per account*, so many markets shard naturally. For a single hyper-active
market it would be the ceiling. Phoenix and Manifest live with exactly this.

**Realloc growth is a rent-griefing surface.** Anyone can push orders to force the
account to grow, and it can only shrink via the internal free list — never by
shrinking the account. Manifest mitigates with a refundable per-order lamport
deposit. We should do the same, and it composes with our existing dust threshold.

**Realloc is capped at 10,240 B per instruction** (measured from length at
instruction entry). 10 KB = 128 blocks per instruction, chainable across
instructions. Fine, but the growth path must handle the cap explicitly.

**Maker funds sit as credit, not in their wallet.** Makers need an extra
`withdraw` call. This is standard (Phoenix, OpenBook, Serum all work this way) but
it is a UX change and the demo must surface claimable credit.

**We lose FIFO-across-price-levels simplicity.** Today time priority is implicit
in a per-tick `Vec`. In a sorted list, price-time ordering must be maintained
explicitly on insert. Straightforward, but it is real logic that needs tests.

**Zero-copy means `bytemuck` discipline.** `#[account(zero_copy)]` requires `Pod`
types: no `Option`, no `Vec`, explicit padding, alignment-safe field ordering. The
compiler enforces most of it, but it is a different idiom than the rest of the
program.

**One big rewrite, not an incremental one.** The book, the matcher, the SDK
matching driver, and the event schema all move together. There is no useful
half-way state.

---

## 8. Blast radius

### On-chain — smaller than expected

The tick/BookSide model touches **9 of 41 source files**, ~851 lines. Book-native:
`buy`, `cancel`, `cancel_by_id`, `compact_book_side`, `close_book_side`,
`fill_order_internal`, `matching.rs`, `bitmap.rs`, `math/book.rs`.

**Untouched:** market lifecycle, AMM, complete sets, LP/launchpad, adjudication,
settlement, redeem, pause. The CLOB's only interface to the rest of the program is
`OrderbookPosition` — a plain yes/no share ledger with no tick or order-id concept.

Only **3 of 47 cargo tests** are book-specific (all in `state::order_id::tests`).
`bitmap.rs` and `math/book.rs` have **zero** unit tests, so we delete almost no
coverage — and inherit none.

Two traps:
- **Error discriminants are positional.** Deleting any of the 12 book-specific
  error variants renumbers every variant after it, silently remapping AMM and
  lifecycle errors off-chain. **Tombstone, don't delete.**
- **`OrderIdSeedMismatch` cannot go with the book** — `sell_positions.rs:137`
  reuses it for a `lock_nonce` check.

### Off-chain — five choke points

1. **PDA + wire encoding**: `pdas.ts:365` (`bookSidePda`) and `adapter.ts` — manual
   sighash, hand-rolled borsh, byte-offset account decoders at `:4001`/`:4013`
   that read literal offsets with only a min-length guard. **These mis-parse
   silently rather than throwing.**
2. **Order-id decode is duplicated in three places**: `adapter.ts:3899`,
   `amm-bridge.ts:1233`, `sooth-book-builders.test.ts:247`. The demo copy is the
   likely miss.
3. **`decode-ordersfilled.ts`** throws on trailing bytes — adding one field to
   `FillRecord` takes down `GET /v12/fills` with a 500. Conversely a renamed event
   returns an **empty list with HTTP 200**: silent data loss.
4. **The demo is saturated with `tick/1000`** — `useOrderbook`, `useIndexerOrders`,
   `useSoothBookPriceHistory`, `ActiveOrdersCard`, `types.ts:213`, plus a
   cancel-by-level path that synthesizes `${side}:${tick}` string ids and parses
   them back with a **regex**, and refund math that hardcodes `/1000n`.
5. **Legacy transactions only** — no `VersionedTransaction`, no ALT anywhere.

Test inventory: **52 SDK orderbook tests** across 9 files, **9 e2e specs**, **23 of
29 sooth-data tests** touch tick/event shapes. Most SDK tests assert *behaviour*
(crossing, self-cross, cancel semantics, pause) and should survive with new
fixtures; the *structural* ones (`sooth-book-builders`, PDA goldens, error-ordinal
tables) get rewritten.

Note: `pdas.test.ts` asserts four hardcoded base58 strings, and the same
derivation is **duplicated** in `apps/demo/e2e/helpers/sdk-helpers.ts`. Someone
regenerating the goldens to make the suite green will not notice the e2e copy.

---

## 9. Phased plan

Each phase ends green and independently reviewable.

**Phase 0 — bug fixes, independent of everything else.** B1 (AMM redeem — do this
first, it is stuck funds), B2 (swapped ticks), B4, B5, B6. Ship before any
redesign work starts.

**Phase 1 — spike the arena.** `Book` account, block allocator + free list, sorted
insert/remove, zero-copy. Pure Rust unit tests, no instructions. Deliverable: a
property test that random insert/cancel sequences keep the list sorted, the free
list consistent, and no block leaked.

**Phase 2 — settlement layer. DONE (2026-08-01).** `src/book/settlement.rs`,
15 tests, cargo 58 → 73.

The "four-way table" turned out not to be a table. On a signed net position
(`net > 0` long YES, `net < 0` long NO), one rule covers every mode:

```
collateral_in  = |delta| * (p if buying YES else 1 - p)
collateral_out = closing_amount * 1.0
```

where `closing` is the part of the move that reduces existing opposite
exposure. Mint, transfer and merge are *consequences*:

| taker | maker | collateral | mode |
|---|---|---:|---|
| opening | opening | `+p` and `+(1−p)` = **+1.0** | MINT |
| closing | closing | **−1.0**, less `p`/`(1−p)` back | MERGE |
| opening | closing | **0** | TRANSFER |

So the vault holds exactly 1.0 per unit of open interest by construction —
solvency is structural, not a check that runs afterwards. Pinned by
`the_vault_holds_exactly_one_per_unit_of_open_interest`, which walks a sequence
of fills and re-asserts it after each.

**Fees are now symmetric.** `fee = rate × min(p, 1−p) × amount`, taker-only, on
the executed price. Today selling 100 YES @ 0.80 costs **zero** (escrow legs are
fee-exempt) while the identical position — buying 100 NO @ 0.20 — costs 1% of
$20, and split/merge converts between them for free, so the fee is simply
avoidable. `min(p, 1−p)` is invariant under the YES↔NO swap, which is exactly
what split/merge performs. It is also the amount actually at risk, so
near-certain outcomes are cheap to trade.

Floor-on-sum rounding carried over verbatim for EVM bit-parity, tested with a
constructed case where the two rules provably disagree (`amount =
1_999_999_999_998` at tick 500: the fee is 0 base units on its own but tips the
sum over a boundary).

Mutation-verified: charging on `p` instead of `min(p, 1−p)` fails 3 tests;
floor-on-fee instead of floor-on-sum fails 2; releasing 0 instead of 1.0 on a
close fails 5.

Still to do in this phase: the seat credit ledger primitives, which land with
the instructions in Phase 3 since they need account plumbing.

**Phase 3 — instructions.** `place`, `cancel`, `withdraw_credit`, plus matching in
`place`. Port the behavioural LiteSVM suite (crossing, multi-fill, self-cross,
pause, place/cancel) to the new surface. **Measure CU and fills/tx here** — this
is where §6.3's estimate gets confirmed or falsified.

*Started 2026-08-01.* Building the account layer surfaced two corrections to
Phases 1–2 that had to land first:

**No `u128` in stored structs.** `u128` has 16-byte alignment; Solana account
data is guaranteed only 8. A `bytemuck` cast of a 16-aligned type onto account
data fails on-chain — and because host and SBF alignment need not agree, the
layout could have passed `cargo test` and been wrong in production. `OrderNode`
now holds `amount: u64` in **USDC base units**, which drops the block from 80 to
**64 bytes** (matching Phoenix's node size) and removes WAD→base rounding from
the storage layer entirely: the book speaks the vault's units. Compile-time
asserts pin `align_of` ≤ 8 for both structs.

**Legs must be derived, not both floored.** In base units,
`amount * tick / NUM_TICKS` per leg floors *twice*, so the pair can sum to
`amount - 1` — the vault would be short one base unit **per fill** and the
"1.0 per unit of open interest" invariant would bleed away. `leg_costs` now
floors the maker leg and gives the taker the remainder, so they always close
exactly; the taker absorbs the sub-cent, which is the party already receiving
price improvement. A sweep asserts closure over ~5,600 (amount, tick, side)
combinations and fails if it never hits an uneven case.

Two claims from Phase 2 also turned out to be wrong and were corrected rather
than defended:

- **Floor-on-sum does not apply here.** It exists because the WAD path carries
  costs with sub-base-unit fractions that a small fee can tip. In base units a
  cost is a whole number, so floor-on-sum and floor-on-fee are provably the same
  function. EVM fee parity is in any case *already* deliberately broken by
  `min(p, 1-p)`; preserving a rounding convention for a formula we no longer use
  would be parity theatre.
- **Division order does not matter.** `floor(floor(x/a)/b) == floor(x/(a*b))`
  for positive integers, verified by brute force over every tick and amounts to
  20,000. An earlier test asserted the single-floor form was strictly better
  somewhere; that is mathematically false and the assertion was removed.

**Phase 4 — off-chain.** SDK driver (much simpler: no bundles to precompute, which
also retires audit finding H1), event schema **with a version field this time**,
indexer decoders, demo.

**Phase 5 — deploy fresh.** New program IDs for `sooth_core` and `sooth_log`,
generated and backed up before deploying.

---

## 10. Decisions — settled 2026-07-31

1. **Unified price axis.** Adopted. Economically identical to the two-sided book
   and much simpler. Crucially it **preserves excess-to-the-filler**: a NO buy at
   0.55 is a YES sell at 0.45, so a YES buy with a 0.60 limit crossing it executes
   at the maker's 0.45 and the taker keeps 0.15. Same number, same recipient — it
   arrives as ordinary price improvement rather than a separate rebate
   accumulator. The rule that delivers it is *fill at the maker's price*, which is
   a matching-engine rule and must be stated explicitly in Phase 2. UI changes
   (one ladder, not two) are accepted.

2. **FIFO is preserved and tested.** §7 previously said we "lose FIFO
   simplicity", which was misleading. We keep strict **price-time priority**; what
   we lose is its free-ness. Today FIFO is implicit in a per-tick `Vec` (append =
   last). In a sorted list it becomes explicit insert logic, and Phase 1 ships a
   property test: random insert/cancel sequences must always leave the list
   price-then-time ordered with no leaked blocks.

3. **Order cap: 256 per market.** ~20 KB, ~$2.9 rent at full extension.

4. **Refundable lamport deposit per order.** Adopted, Manifest-style, to price
   the realloc-grief surface.

5. **Fees: Polymarket model.** `fee = rate × min(p, 1−p) × size`, taker-only,
   charged on the **executed** price. Today's rule is exploitable: selling 100 YES
   @ 0.80 and buying 100 NO @ 0.20 are the same position, and split/merge makes
   converting between them free — but the sell leg pays **zero** (escrow legs are
   fee-exempt, B11) while the buy leg pays 1% × $20. Everyone routes through the
   free side. `min(p, 1−p)` is invariant under the YES↔NO swap, which is exactly
   the transformation split/merge makes free, so both routes cost the same. It
   also fixes charging on the taker's *limit* tick rather than the executed price.

6. **Tick granularity: keep 1000.** The redesign decouples granularity from cost
   (no bitmap, no per-tick accounts), so changing it later is nearly free — unlike
   today, where it is baked into PDA seeds and every rendered price.

---

## 11. Sources

Ecosystem numbers were gathered from source and docs where reachable; the
Manifest rent figures were independently recomputed from
`(128 + bytes) × 6960` rather than taken from their README. The Monaco GitHub org
now 404s and `docs.monacoprotocol.xyz` does not resolve, so Monaco details are
from secondary write-ups and should be treated as lower-confidence.

- Phoenix — <https://github.com/Ellipsis-Labs/phoenix-v1>
- OpenBook v2, Serum v3 — on-chain program sources
- Manifest — README + program source
- Drift prediction markets — <https://docs.drift.trade/prediction-markets/prediction-markets-intro>
- Polymarket CTF Exchange — contract sources and `py-clob-client` issue #245
- Kalshi — public rulebook and fee schedule
