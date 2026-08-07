# `develop` vs `main` — what changed and why

As of 2026-08-07. `develop` is 86 commits ahead of `main`.

This document exists because the two branches are no longer variations on the
same design. `main` is the six-program port of the EVM contracts; `develop` is
one program with a different orderbook. Reading a diff top to bottom will not
tell you that, so this explains the shape first and the details after.

---

## 1. The short version

Three things happened, in order of how much they matter.

**The six programs became one.** `main` splits the protocol across
`sooth_market`, `sooth_amm`, `sooth_book`, `sooth_launchpad`,
`sooth_adjudicator` and `sooth_log`, which talk to each other by CPI. Every
call that touches two of them pays for the hop, and every account constraint
has to be re-proved on the far side. `develop` is a single `sooth_core`. Half
the Rust disappeared: 24,914 lines to 10,176.

**The orderbook was rebuilt.** `main` stores one account per price level, so a
market with orders at forty ticks is forty accounts, and a trade that sweeps
five levels needs all five passed in by the caller — who has to know which
five before sending. `develop` holds the whole book in one account and walks it
on chain. This is the change everything else follows from.

**A class of bug was closed.** Not a rewrite — specific, found defects, each of
which could take or strand real money. They are listed in §6 because they are
the part an auditor should read first.

The capacity consequence, since it is the question most often asked: a
transaction goes from **5 fills to several hundred**, and a fill costs ~20×
less compute.
That is not extra parallelism — neither branch parallelizes within a market —
it is density. It is bought with book capacity: the cap counts *blocks*, which
orders share with one seat per currently-seated trader. §5 has the
measurements and the trade.

The other trade-off: `develop` is younger. `main` has had more eyes and more
calendar time. What `develop` has instead is a settlement path verified end to
end on a validator, which `main` never had.

---

## 2. The numbers

```
                              main          develop
Programs                      6             1
Rust (packages/programs-core) 24,914        10,176
TypeScript test files         65            85
Rust #[test]                  247           111
```

Overall: **372 files changed, +39,724 / −46,243**.

By area:

| Area | Files | Added | Removed |
|---|---:|---:|---:|
| `packages/programs-core` | 192 | 8,856 | 23,355 |
| `packages/sdk-solana` | 56 | 17,408 | 19,400 |
| `apps/demo` | 83 | 6,709 | 3,386 |
| `packages/sooth-data` | 34 | 4,031 | 0 |
| `docs` | 4 | 1,342 | 42 |

Two of these need a caveat, because the raw figure misleads:

- **Rust tests fell from 247 to 111.** No test was deleted from surviving code.
  Five programs and the legacy orderbook were removed and their tests went with
  them. Coverage per surviving line is higher, not lower — but the headline
  number is down and it would be dishonest to present it otherwise.
- **`sdk-solana` shows +17k/−19k** mostly because the generated Anchor IDL is
  checked in and regenerates wholesale. The hand-written change is far smaller.

---

## 3. Six programs to one

On `main`, placing an order crossed three program boundaries: `sooth_book`
matched, then CPI'd `sooth_market` to move shares, which CPI'd the SPL token
program. Each hop costs compute, and — the real problem — each hop needs its
own account list, so the *caller* had to assemble the union of accounts for
every program that might be touched. Get it wrong and the transaction fails at
simulation with no useful message.

`develop` calls the same logic as ordinary Rust functions. There is one
`declare_id!`, one upgrade authority, one deploy.

What was lost: the programs can no longer be upgraded independently. Nobody was
doing that, and a single audited artifact is easier to reason about than six
that must be audited together anyway because they trust each other's CPI.

`sooth_log` is gone entirely. Anchor's `#[event_cpi]` / `emit_cpi!` does what it
existed for.

---

## 4. The orderbook

This is the substantive design change, so it is worth being precise.

### How `main` works

An account per price level:

```
seeds = [b"book_side", market_id, side, tick]     // one PDA per tick
MAX_ORDERS_PER_TICK = 50
```

Consequences, all of them awkward:

- A taker sweeping five levels must pass five accounts, which means the client
  has to know which levels it will hit *before* it sends. The book can move in
  between; then the transaction fails or fills less than it should.
- A tick with 51 orders cannot take a 52nd. The cap is per level, not per
  market, so a busy price is unusable while the market as a whole is nearly
  empty.
- Rent is per level. An empty level still costs until someone closes it, which
  is why `close_book_side` and `compact_book_side` exist on `main` — two
  instructions whose entire job is cleaning up after the data layout.

### How `develop` works

One account per market:

```
seeds = [b"book", market_id]
MAX_ORDERS = 4096, BLOCK_SIZE = 64 bytes, zero-copy via bytemuck
```

A linked-list arena inside a single zero-copy account: orders and seats are
fixed-size blocks, sorted by price then time. A taker passes one account and the
program walks the list. Matching happens on chain, so what fills is decided by
the book's actual state at execution, not by the client's guess a second ago.

The account grows on demand. Solana caps growth at 10,240 bytes per
instruction, so `book_init` issues several — that is what `buildBookInitIxs`
is for.

Two consequences worth naming:

- **4,096 blocks per market, not 50 orders per tick.** A busy price level can
  no longer be hit sideways. Orders and seats share those blocks, so the usable
  order count is lower than the constant suggests — §5 has the measurement.
- **`close_book_side` / `compact_book_side` are gone.** There is nothing to
  compact.

### Unified price axis

Both branches quote one number. Buying NO at *q* is the same trade as selling
YES at 1−*q*, so the book has a single ladder rather than two.

This preserves *excess-to-the-filler*: a NO buy at 0.55 is a YES sell at 0.45,
so a YES buy with a 0.60 limit that crosses it executes at the maker's 0.45 and
the taker keeps the 0.15. Fill-at-the-maker's-price is what delivers that, and
it is a matching-engine rule, not a UI convention.

### Self-crossing

If your order would match your own resting order, the resting one is cancelled
and yours is placed. Not an error, and not a silent no-op — both of which were
tried and both of which blocked legitimate trades where the crossing order was
incidental to a fill against someone else.

---

## 5. Capacity and throughput

Measured, not projected — both figures come from the same LiteSVM harness
(`packages/sdk-solana/tests/book-cu-budget.test.ts`, which exists to check this
claim rather than assume it). The `main` row is the legacy harness the redesign
was measured against.

### Per transaction

| fills | `main` CU | `main` bytes | `main` writable | `develop` CU | `develop` bytes | `develop` writable |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 66,708 | 778 | 10 | 42,360 | 540 | 5 |
| 5 | 184,749 | 1,174 | 22 | 42,973 | 540 | 5 |
| 20 | — | — | — | 63,288 | 540 | 5 |
| 40 | — | — | — | 100,036 | 540 | 5 |
| 60 | — | — | — | 127,764 | 540 | 5 |

`main` stops at **five fills, and not because of compute**. Each fill adds 99
transaction bytes and 3 writable accounts, so a sixth makes the transaction
1,273 bytes against Solana's 1,232-byte packet limit — rejected before it
executes. That is the real ceiling, and it is a data-layout consequence: the
accounts have to be listed because the fills touch different ticks.

`develop` is flat at 540 bytes and 5 writable accounts whether it fills 1 or
60, because the book is one account. Marginal cost is **1,448 CU/fill against
29,510** — roughly **20× cheaper per fill** — and the binding constraint moves
from transaction size to book depth.

**Fills per transaction: 5 → ~900, bounded by compute rather than transaction
size.** `main`'s ceiling was the 1232-byte packet; here the bytes are flat, so
the limit is the 1.4M CU budget at ~1,448 CU/fill (and whatever `match_limit`
the caller passes). See "The cost side" below for why a block is not the same
thing as an order.

### Throughput

Solana caps writes to any single account at 12M CU per block. This is the
number that matters, and it is where the intuition misleads.

`main`'s per-tick accounts *look* like they let different price levels trade in
parallel. They do not: every buy also write-locks `market_fee_pool`, which is
per-market. So **neither branch parallelizes within a market** — both serialize
on a per-market writable account, and the per-tick split buys nothing in
throughput. Across *different* markets both scale the same way.

Per market, per block:

| | `main` | `develop` | gain |
|---|---:|---:|---:|
| small trades (5 fills/tx) | ~325 fills | ~1,396 fills | 4.3× |
| batched (60 fills/tx) | not possible | ~5,636 fills | ~17× |

At ~2.5 blocks/sec: roughly 800 fills/sec, against 3,500–14,000 depending on
how well trades batch.

### What this means for volume

Notional volume per fill is unchanged — a fill can be any size on either
branch. The economically meaningful difference is **atomicity**, not rate.

On `main`, sweeping twenty price levels took four transactions, and the book
could move between them: partial fills at drifting prices, with no way to
express "all of it or none". On `develop` the same sweep is one transaction
against the book state at that instant.

### The cost side: seats share the arena

`MAX_ORDERS` bounds **blocks, not orders**, and orders share the arena with
seats — one per distinct trader. So the constraint is

```
live orders + seated traders ≤ MAX_ORDERS
```

Measured: 60 makers fit a 150-block book at two blocks each (one order, one
seat); 80 did not.

Seats were originally never freed, which made that a *lifetime* limit rather
than a depth one — with the cap then at 256, a market stopped accepting orders
once ~256 wallets had ever touched it, and cancelling never gave the space
back. Worse, `take_credit` used
the allocating seat lookup, so `book_withdraw` from a wallet that had never
traded allocated a block to record a zero balance: ~256 throwaway signers could
fill the arena and brick a market for the price of transaction fees.

Both are fixed. Seats are now looked up rather than created on the exit paths,
and a seat is returned to the free list once `credit` and `net` are both zero
(`arena.rs::free_seat_if_empty`). What makes that safe is that a seat holds
*only* those two fields, and orders reference their owner by **pubkey**, never
by seat index — so an emptied seat carries no information and a resting order
whose seat was freed simply rebuilds it on the next fill.

The freeing is deliberately confined to `book_withdraw` and `redeem_book_seat`.
The matching loop caches seat indices across mutations, so returning a block
there could hand that index to another trader mid-match — which is what the
original "zeroed, not freed" note was guarding against. That concern was right
about the matcher and too broad about everywhere else.

The limit is now what it should be: **live** orders plus **currently-seated**
traders, where a trader stops being seated as soon as they withdraw.

### What the cap means in people

Not a user count. It depends what they are doing, because a trader placing an
order needs a seat *and* an order block:

| a trader who is… | blocks | fits in 4,096 |
|---|---:|---:|
| holding a position (seat only) | 1 | **4,096** |
| resting one order | 2 | **2,048** |

Pinned by `capacity_in_participants_not_orders`, because it is the number
anyone sizing a market needs and it is not the constant's face value.

`MAX_ORDERS` was 256, which meant 256 concurrent position holders. The first
row is the one that binds: a prediction market is buy-and-hold, so a position
occupies its seat from the fill until redemption after settlement — months, on
a long-dated market. A market with 256 holders had no room left for anyone to
quote, and the Polymarket books in §5 imply hundreds of live orders on their
own before counting a single holder.

Raising it was cheap because **the cap is a ceiling, not an allocation**.
`book_init` takes an initial capacity and `book_grow` extends toward the limit
one realloc at a time, permissionlessly, so a thin market still pays thin-market
rent (0.116 SOL at 256 blocks) and only a market that earns the room pays for
it (1.83 SOL fully extended). Reaching the ceiling takes 26 `book_grow` calls,
since Solana permits 10,240 bytes per instruction.

Nothing walks the whole book on chain — `iter_side` is test-only and the
event's fill list is bounded by `match_limit` — so a bigger arena does not make
a fill more expensive. The worst-case *insert* grows with depth at ~60 CU/step,
which is ~246k CU at 4,096, about 18% of the budget.

### Headroom if the cap is raised

Measured against a devnet RPC for rent, and on LiteSVM for the walk. The
insert is O(n) but costs about **60 CU per step**, invisible against the ~40k
fixed cost, so it is not the binding constraint anyone expects it to be.

| blocks | account | rent | worst-case insert |
|---:|---:|---:|---:|
| 256 | 16.5 KB | 0.116 SOL | ~15k CU |
| 1,024 | 65.7 KB | 0.458 SOL | ~61k CU |
| 4,096 | 262 KB | 1.83 SOL | ~246k CU |
| 16,384 | 1.05 MB | 7.30 SOL | ~983k CU |
| 163,840 | 10.5 MB | 72.98 SOL | — |

What binds, in order: **rent** (paid per market at creation), then the
**growth rate** — Solana permits 10,240 bytes per instruction, so 160 blocks
per instruction, and 4,096 blocks needs 26 `book_init` instructions across
several transactions — then the **insert walk** past ~16k blocks. The absolute
ceiling is Solana's 10 MiB account limit at 163,840 blocks. The block index is
`u32`, so index space is never the constraint.

### How much depth is actually needed

From Polymarket's public CLOB, the 30 most liquid open markets on 2026-08-07:

```
price levels per book:   min 63    median 76    max 101
```

Polymarket prices on a 1¢ grid, so only ~99 levels exist — those books occupy
most of the available ladder. Our grid is 999 ticks (0.1¢), ten times finer,
so equivalent coverage could span more levels if makers use the granularity.

Two caveats that cannot be removed from public data:

- Those are **aggregated price levels, not individual orders**. Polymarket's
  CLOB aggregates by price; this book stores individual orders because it keeps
  FIFO time priority. Orders ≥ levels and the multiplier is not observable.
- **Kalshi yielded nothing.** Its public endpoints returned no order books and
  null volume unauthenticated across 200 markets, so no comparison is offered
  rather than an extrapolated one.

Sizing on that: ~100 levels of Polymarket-class coverage with several orders
per level is a few hundred live orders, plus a block for each trader holding a
position or un-withdrawn credit. The cap is **4,096 blocks** — comfortably past
that, at 1.83 SOL fully extended and ~18% of the CU budget on a worst-case
insert. Because seats are reclaimed and growth is incremental, that number now
tracks live depth rather than cumulative footfall, and a thin market never pays
for the headroom.

### Caveats

These are LiteSVM numbers, not devnet or mainnet under contention. The 12M
per-account figure is Solana's current limit and the scheduler does not
guarantee any market the full budget. Treat the throughput table as a ceiling,
not a forecast.

---

## 6. Correctness fixes

The ones with money on the other side. Each is a real defect that existed, not
a hardening measure.

**`wad_mul` silently dropped 2^128.** The 128×128 multiply derived its carry
from an expression that itself overflowed. Below the threshold everything was
right, so no test caught it; above it, results were wrong and plausible —
`cost_delta(307, 303, b=50, +4)` returned **−338.16**, a negative cost for a
buy. It fires when `lmsr_cost` exceeds 340.282366920938463463, which a market
with a realistic `b` reaches in ordinary trading. Now uses a schoolbook carry
and is mutation-tested.

**B0 — the LMSR subsidy was unreclaimable.** A market creator posts `b·ln(2)`
to seed the AMM. Fees repay it as the market trades, but no instruction ever
returned the unspent remainder, so it stayed in the vault forever. Added
`reclaim_subsidy`, which pays only `vault − obligations` and never more than
`posted − reclaimed`, counting all three ledgers (mint supply, AMM `q` above
seed, book seats) so it cannot pay the creator money owed to a trader.

**B1 — AMM buyers had no exit after settlement.** `trade_positions` credited
`Position.yes_shares` and took the USDC, and nothing paid it back: `redeem`
reads SPL token balances an AMM buyer never receives; `sell_positions` requires
an open market; `claim_refund` only applies to a dismissed one. Every winning
AMM buyer's funds were permanently stranded. `redeem_amm_position` fixes it.

**B1 was, until 2026-08-07, unreachable.** The instruction was correct and had
no SDK builder and no UI route — so the program was fixed and the money was
still stuck, for exactly the reason the instruction was written. This is the
failure mode worth internalising: *an on-chain fix that nothing calls is not a
fix.*

**Book positions could not be redeemed.** `redeem_book_seat` added; a settled
market's book seats now convert to USDC.

**A settled market still accepted orders.** `book_place` now requires
`market.is_open()`.

### Verified, not just written

Settlement is driven end to end on a validator across YES / NO / INVALID:

| | YES | NO | INVALID |
|---|---|---|---|
| `redeem_amm_position` (5 YES) | 5.000000 | 0 | 2.500000 |
| replay | 0 | 0 | 0 |
| `redeem` SPL (4 sets) | 4.000000 | 4.000000 | 4.000000 |
| legs burned | YES | NO | both |
| vault | solvent | solvent | solvent |

`reclaim_subsidy` returns exactly `b·ln(2)` = 34.657359 at b=50.

This mattered: running it is how `reclaim_subsidy` was found to have invented
its mint seeds — a bug no unit test could see, because unit tests do not check
that Anchor can resolve an account constraint.

---

## 7. New: `packages/sooth-data`

Does not exist on `main`. An indexer for book history.

Solana validators prune, so "show me my fills from last week" cannot be
answered from the chain. This polls `getSignaturesForAddress`, decodes the CPI
events, and stores them in SQLite (WAL, idempotent inserts). Its cursor only
advances after a clean pass — an early version advanced past unread
transactions and lost history permanently, which is silent and unrecoverable.

Alchemy's Account Archive is integrated for **price history** specifically,
where it genuinely removes work: the LMSR price is a pure function of three
numbers in `AmmState`, so a chart is a series of account reads at past slots,
one request per *state change* rather than per slot.

It does **not** replace the event index. The archive is per slot; fills are per
transaction. Two transactions in one slot collapse to one state, so a fill can
be invisible in the archive while sitting plainly in an event. State answers
"what was it then"; events answer "what happened, to whom, at what price".

---

## 8. Deployment

`develop` is live on devnet at a **fresh program id**, deliberately — not an
upgrade over `main`'s, so no account written by the old layout is reachable at
the address the app uses.

```
sooth_core   DHnXeCJThuejPHkpRwg8QrmS6GCMJWPUefGKU74ZHGPD
USDC (mock)  ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX
```

`main`'s deployment (`BgcooFgT…`) has been closed and its rent reclaimed.

**Every transaction must request a 256 KB heap frame.** `sooth_core` installs a
custom `#[global_allocator]` that addresses from the top of a region the
runtime only maps on request. Without it *every* instruction faults at 215 CU
with "Access violation in heap section" — a total failure that looks nothing
like an allocator problem. `@sooth/sdk-solana` does this on all paths; Anchor's
plain `.rpc()` does not.

---

## 9. Known gaps

Stated plainly, because a comparison document that only lists improvements is
not useful for deciding anything.

- **The demo's chain-shim.** `apps/demo/src/lib/chain-shim/` is 3,810 lines
  translating Ethereum-shaped calls (`useReadContract`, `0x…` addresses) into
  Solana. It is a porting artifact and a genuine source of bugs — hex-vs-base58
  market keys, case-folded pubkeys, WAD-vs-base-unit confusion all came from
  it. It is confined to the demo: nothing in `programs-core` or `sdk-solana`
  imports it.
- **4,096 blocks is a real ceiling**, on live orders plus currently-seated
  traders (§5) — about 4,096 position holders or 2,048 makers. Large enough for
  the depth the public Polymarket books show, but a genuinely popular market
  would still reach it, and the next raise costs CU on the insert walk rather
  than being free.
- **No parallelism within a market.** Every trade write-locks the book, so one
  market's throughput is capped by Solana's 12M CU per-account budget however
  many validators are free. `main` has the same limit for a different reason.
- **Younger code.** Fewer calendar-weeks of review than `main`.
- **No mainnet deployment**, and no audit yet.
- **The indexer polls.** Fine for devnet and a handful of markets; a busy
  market wants Geyser/Yellowstone or a provider webhook. The swap is contained
  — the RPC surface is a two-method interface for this reason.

### Suggested audit scope

`packages/programs-core` and `packages/sdk-solana`. Exclude `apps/demo` and
`packages/sooth-data`: a bug there costs a wrong chart, not funds.

---

## 10. Running it

```bash
cd apps/demo && pnpm dev        # http://localhost:5175
```

`.env.local` already points at devnet. Import `.localnet/user-keypair.json`
into Phantom for a wallet preloaded with mock USDC.

To reseed devnet markets:

```bash
SOLANA_RPC_URL="https://solana-devnet.g.alchemy.com/v2/<key>" \
SOLANA_WS_URL="wss://api.devnet.solana.com/" \
  bash scripts/seed-fixture.sh
```

The split endpoints are not optional: Alchemy serves no WebSocket
subscriptions on the current key, and `confirmTransaction` needs them, so every
confirm retries a subscribe that can never succeed. The provider handles HTTP
(seeding a graduated market is thousands of transactions and the public
endpoint rate-limits); a plain validator handles subscriptions.

Never put a keyed URL in a `VITE_`-prefixed variable — Vite inlines those into
the browser bundle.
