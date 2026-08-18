# `develop` vs `main` — what changed and why

As of 2026-08-16. `develop` is **128 commits** ahead of `main`
(`git rev-list --count main..develop`).

This document exists because the two branches are no longer variations on the
same design. `main` is the multi-program port of the EVM contracts; `develop` is
one program with a different orderbook. Reading a diff top to bottom will not
tell you that, so this explains the shape first and the details after.

---

## 1. The short version

Five things happened, in order of how much they matter.

**The five programs became one.** `main` splits the protocol across
`sooth_market`, `sooth_amm`, `sooth_book`, `sooth_launchpad` and
`sooth_adjudicator`, which talk to each other by CPI. Every call that touches
two of them pays for the hop, and every account constraint has to be re-proved
on the far side. `develop` is a single `sooth_core`. Well over half the Rust
disappeared: 24,514 lines to 10,678.

**The orderbook was rebuilt.** `main` stores one account per price level, so a
market with orders at forty ticks is forty accounts, and a trade that sweeps
five levels needs all five passed in by the caller — who has to know which
five before sending. `develop` holds the whole book in one account and walks it
on chain. This is the change everything else follows from.

**The two venues got separate tokens.** This is the newest change and the one
that most alters what the protocol *is*. On `main` there is one collateral
token: USDC funds the AMM and the book alike. On `develop` the AMM prices in an
instance token fixed at deploy, the book stays in USDC, and a market cannot
trade on the book until it graduates. Two vaults, two fee pools, two fee rates.
§4a explains why this is not a cosmetic relabelling.

**A class of bug was closed.** Not a rewrite — specific, found defects, each of
which could take or strand real money. They are listed in §6 because they are
the part an auditor should read first.

**The frontend grew two surfaces.** Both branches ship one app, `apps/demo`. On
`develop` it gained the Eastboard shell at `/options` and Arena at `/play`, both
over the same chain-shim. §7a.

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

If you only want the verdict, skip to §11 — it states where each branch is
actually better and which one scales.

---

## 2. The numbers

```
                              main          develop
Programs                      5             1
Rust (packages/programs-core) 24,514        10,678
Instructions                  51            30
Frontend surfaces             1             2 (Eastboard, Arena)
Collateral tokens             1             2 (one per venue)
Fee rates                     1 (fee_bps)   2 (amm / book) + graduation_bps
Vaults per market             1             2 (vault_amm, vault_book)
Outcome SPL mints             2 (YES/NO)    0
TypeScript test/spec files    53            81
Rust #[test]                  244           120
```

Overall: **459 files changed, +56,161 / −50,501**
(`git diff --shortstat main...develop`). Every figure in this section is
measured against the two committed branch tips; uncommitted work in a worktree
is not counted, so re-derive rather than trusting these after a busy week.

By area (`git diff --shortstat main...develop -- <area>`):

| Area | Files | Added | Removed |
|---|---:|---:|---:|
| `packages/programs-core` | 197 | 10,318 | 24,299 |
| `packages/sdk-solana` | 64 | 20,324 | 20,551 |
| `apps/demo` | 152 | 17,082 | 5,515 |
| `packages/sooth-data` | 34 | 4,031 | 0 |
| `docs` | 9 | 2,653 | 44 |

Three of these need a caveat, because the raw figure misleads:

- **Rust tests fell from 244 to 120.** No test was deleted from surviving code.
  Four programs and the legacy orderbook were removed and their tests went with
  them. Coverage per surviving line is higher, not lower — but the headline
  number is down and it would be dishonest to present it otherwise. The
  TypeScript count moves the other way, 53 files to 81.
- **`sdk-solana` shows +20k/−21k** mostly because the generated Anchor IDL is
  checked in and regenerates wholesale. The hand-written change is far smaller.
- **`apps/demo` grew** rather than shrank: the Eastboard and Arena surfaces
  landed there on top of the existing demo, so its diff is new UI, not book
  work.

---

## 3. Five programs to one

On `main`, placing an order crossed three program boundaries: `sooth_book`
matched, then CPI'd `sooth_market` to move shares, which CPI'd the SPL token
program. Each hop costs compute, and — the real problem — each hop needs its
own account list, so the *caller* had to assemble the union of accounts for
every program that might be touched. Get it wrong and the transaction fails at
simulation with no useful message.

`develop` calls the same logic as ordinary Rust functions. There is one
`declare_id!`, one upgrade authority, one deploy.

What was lost: the programs can no longer be upgraded independently. Nobody was
doing that, and a single audited artifact is easier to reason about than five
that must be audited together anyway because they trust each other's CPI.

There is also no separate event program. `develop` briefly carried a
`sooth_log` alongside `sooth_core`, built on the belief that a program cannot
CPI into itself; Solana permits direct self recursion, which is exactly what
Anchor's `#[event_cpi]` / `emit_cpi!` uses, so the payload lands in an inner
instruction with no second `declare_id` and no second deploy.

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

## 4a. Two venues, two tokens

The largest architectural difference, and the newest. `main` has one
collateral token; `develop` has one per venue.

```
                    main                     develop
AMM collateral      USDC                     instance token (EAST on devnet)
Book collateral     USDC                     USDC
Book before grad.   open                     refused by the program
Fee rate            fee_bps                  amm_fee_bps / book_fee_bps
Fee pool            one per market           one per market PER VENUE
Vault               market.vault             market.vault_amm / vault_book
Outcome tokens      YES/NO SPL mints         none — internal accounting
```

### Why it is not a relabelling

**An SPL token account holds exactly one mint.** That single fact forces every
other change here. Two collateral tokens cannot share a vault, so `vault`
became `vault_amm` + `vault_book`. They cannot share a fee pool, so
`fee_pool` split by seed. They cannot share a treasury account, which is why
`protocol_treasury_vault` is now bound by `token::authority` rather than
`address` — one pubkey can own two accounts, but cannot *be* two accounts.

The rename from `vault` to `vault_book` was deliberate rather than
conservative: it makes the compiler visit all 17 call sites, because the
failure mode of getting one wrong is silent. The wrong vault still exists,
still deserializes, still has a balance — it just holds the other currency.

### What it buys

A market can be incubated in a token the protocol controls, then graduate to
USDC once it has proven demand. The bonding-curve phase and the mature phase
are economically distinct, and they now have distinct fee rates to match
(5% AMM, 1% book on the current config). The book being *program-refused*
before graduation rather than UI-hidden is what makes that a guarantee.

### What it costs

- **Two balances to fund.** A wallet holding only USDC cannot trade any market
  before graduation. Every client and fixture has to know which venue it is
  touching — which is exactly the bug class §6 records under the faucet, the
  launchpad and the settlement harness.
- **Cross-venue mixing is a silent failure.** The `venue-separation` test
  exists because reviewing ~30 constraint lines once proves nothing about the
  next edit; it asserts from the Rust source that no instruction names both
  venues' symbols.
- **A stranded ledger.** Book LP yield accrues in USDC but `redeem_lp` pays
  only the AMM token, so that balance has no claim path yet (§9).

### Complete sets are gone

`main` mints YES/NO SPL tokens and carries eight instructions to manage them
(`mint_complete_set`, `merge_complete_set`, the `_for_orderbook` and
`_to_program_owned` variants, `redeem_from_program_owned`, …). `develop`
deleted all of it in favour of internal accounting.

The trade: those tokens were transferable, so a third party could in principle
have integrated them — an external AMM, a lending market. Nothing was planned,
nothing consumed them, and under two collateral tokens they would have become
genuinely ambiguous (redeemable against *which* vault?). What was gained is 66
bytes of `Market`, two mints and two ATAs of rent per market, eight
instructions of surface area, and the CPI cost of minting on every trade.

If external composability becomes a requirement, this is the decision to
revisit, and it is easier to add later than to remove.

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
`posted − reclaimed`, so it cannot pay the creator money owed to a trader. It
counts one ledger — AMM `q` above seed — and draws on the AMM vault only,
because the deposit was posted in the AMM token; the book's seats are owed from
a different vault holding a different mint, and subtracting them here would
strand the creator's own capital.

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

**90% of every market's fee pool was withdrawable by anyone.**
`distribute_fees` takes `cranker: Signer` — deliberately permissionless, so
fees are never hostage to one keeper. But three of its four destinations
carried `token::mint` and nothing else, which means the *caller* chose them:
the b_base, LP and adjudicator shares could be routed into accounts the cranker
owned. Nothing prevented it except that no client had built the instruction,
which is not a security property — it is a gap waiting for someone to write the
builder. All four are now pinned by address or authority. `main` has the same
shape in `distribute_fees.rs` and should be checked against this.

**Neither venue's fees could be distributed.** `protocol_treasury_vault` was
`address = config.treasury` *and* `token::mint = venue_mint`. One pubkey, two
different mints: no account satisfies both, so whichever venue the treasury
account did not hold could never drain. Found only by driving a distribution on
a validator. Now bound by `token::authority`.

**The e2e settlement harness reported skipped paths as success.** Two of them:
the solvency check read `decoded.vault`, a field the vault split removed, so
`undefined` fell through the guard and the check silently did nothing; and
actors were funded in book tokens only, so the AMM buy failed on balance, was
caught, and the run still printed "all payouts matched". Both are fixed and
skips now exit non-zero. Recorded here because the same shape — *the failure
mode is a passing test* — has now appeared three times in this codebase.

### Verified, not just written

`apps/demo/scripts/settle-e2e.mjs` drives a market end to end on a validator
across YES / NO / INVALID: a book trade and an AMM buy, then `request_lock` →
`attest_outcome` → veto window → `settle`, then every claim path —
`redeem_book_seat` for both sides, `redeem_amm_position`, `book_withdraw`,
`reclaim_subsidy`, and `distribute_fees_amm` followed by `redeem_lp` against
the yield vault.

| | YES | NO | INVALID |
|---|---|---|---|
| `redeem_amm_position` (5 YES) | 5.000000 | 0 | 2.500000 |
| replay | 0 | 0 | 0 |
| each venue's vault vs its own obligations | solvent | solvent | solvent |

`reclaim_subsidy` returns exactly `b·ln(2)` = 34.657359 at b=50.

This is the layer of check unit tests cannot reach: they prove the payout
arithmetic, not that the account list is right, that the PDA seeds resolve,
that the lifecycle gates admit the call, or that the vault authority can sign —
and every one of those is a way for a settled market to strand funds.

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

## 7a. New: the Eastboard and Arena surfaces

Neither exists on `main`. Both landed inside `apps/demo` on `develop`, on top of
the classic pages rather than beside them.

**Eastboard** (`/options`) is the primary UI: a shell wrapping the strike ×
expiry option grid and the main trading surfaces — `/markets`, `/portfolio`,
`/faucet`, `/launchpad`, `/liquidity`, `/amm`, `/orderbook`, `/create` — so the
classic pages render inside it.

**Arena** (`/play`) is the gaming, competitive treatment of the same markets,
with `/learn`, `/operator`, `/lp-forecast` and `/geek` as standalone routes
alongside it.

Both reach the program the same way the rest of the demo does: through
`src/lib/chain-shim/`, 3,810 lines translating Ethereum-shaped calls into
Solana. That layer is a porting artifact and a real source of bugs (§9); the
surfaces inherit it rather than bypassing it.

---

## 8. Deployment

`develop` is live on devnet at a **fresh program id**, deliberately — not an
upgrade over `main`'s, so no account written by the old layout is reachable at
the address the app uses.

```
sooth_core   EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw
AMM token    CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu   (AMM venue)
USDC (mock)  ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX   (book venue)
```

Both `main`'s deployment (`BgcooFgT…`) and the pre-venue-split one
(`DHnXeCJT…`) have been closed and their rent reclaimed.

The second closure is why the id moved again. The venue split changed field
OFFSETS inside `ProtocolConfig` without changing its size — `fee_bps` became
`amm_fee_bps` + `book_fee_bps` + `graduation_bps`, and `_reserved` shrank to
match. An in-place upgrade therefore left a 165-byte account that still
deserialized, but with every field after the treasury shifted: the new program
read `config.bump` off the wrong byte and `create_market` failed its seeds
check. Nothing warned, because nothing was corrupt — the bytes were simply
being read against a different struct. A fresh id makes every PDA derive anew,
which is the only migration that does not require carrying a privileged
"overwrite protocol config" instruction in the program forever.

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
  Solana, and the Eastboard and Arena surfaces sit on top of it. It is a
  porting artifact and a genuine source of bugs — hex-vs-base58 market keys,
  case-folded pubkeys, WAD-vs-base-unit confusion all came from it. It is
  confined to `apps/demo`: nothing in `programs-core` or `sdk-solana` imports
  it. Every frontend surface still sits behind it.
- **4,096 blocks is a real ceiling**, on live orders plus currently-seated
  traders (§5) — about 4,096 position holders or 2,048 makers. Large enough for
  the depth the public Polymarket books show, but a genuinely popular market
  would still reach it, and the next raise costs CU on the insert walk rather
  than being free.
- **No parallelism within a market.** Every trade write-locks the book, so one
  market's throughput is capped by Solana's 12M CU per-account budget however
  many validators are free. `main` has the same limit for a different reason.
- **A market's life can now END.** `sweep_residual` moves a settled market's
  provably-unowed AMM surplus to the treasury (gated on every winning share
  being redeemed — `redeem_amm_position` retires shares from `AmmState.q`, so
  the gate is exact, not a timeout), and `close_market` reclaims the rent once
  every vault and fee pool is empty. The Market account survives as an 8-byte
  tombstone so the market_id can never be re-created — full deletion would
  resurrect every old Position PDA against a fresh vault. What still cannot be
  reclaimed: an absent maker's resting escrow, an unclaimed sell-lock, a
  dismissed market's surplus (no sweep gate exists for refund accounting), and
  the LP mint (classic SPL mints have no close authority). Each blocks close
  by design — the money is someone's.
- ~~Book LP yield has no claim path~~ — RESOLVED. `redeem_lp` burns once and
  pays both venues' yield vaults pro-rata; the vaults are per-market (the
  global predecessor let one market's LPs claim every market's yield), LP
  unlocks at graduation OR settlement/dismissal, and fees distributed after
  the last LP burns fold into the protocol share instead of stranding.
- **Two balances to fund.** A wallet holding only USDC cannot trade any market
  before graduation (§4a). Every client, fixture and script has to know which
  venue it is touching, and getting it wrong fails on balance rather than on
  anything that names the cause.
- **`AMM_TOKEN_MINT` is a compile-time constant.** Immutable at deploy by
  design, and `--features mainnet` is a deliberate `compile_error!` so shipping
  to mainnet forces someone to choose the token. Changing it later means a
  redeploy at a new program id.
- **A layout change forced a new program id.** The venue split moved field
  offsets inside `ProtocolConfig` without changing its size, so the old account
  still deserialized — against a different struct. Every PDA written by the
  pre-split program is stale in the same way. Worth knowing before any future
  in-place upgrade: same-size does not mean same-layout.
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
cd apps/demo && pnpm dev        # http://localhost:5175 — demo, Eastboard, Arena
```

`.env.local` already points at devnet. Import `.localnet/user-keypair.json`
into Phantom for a wallet preloaded with **both** venue tokens — the faucet
dispenses one card per venue, and the AMM's is the one needed first, since
every market trades there until it graduates.

No indexer is required. State lives in accounts, so current prices, orders,
balances and status are direct reads refreshed by polling; an indexer is only
needed for history and charts, and is a performance layer rather than a
correctness one.

After pulling changes that touch the SDK, rebuild it before starting the demo —
`dist/` is untracked and per-worktree, and a stale one fails in ways that do
not name the cause:

```bash
pnpm -F @sooth/sdk-solana build
```

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

---

## 11. Which branch is better, and at what

A comparison that only lists changes does not answer the question anyone
actually has. This section does, including where `main` wins.

### Where `main` is better

- **Maturity.** More calendar time, more eyes, more Rust unit tests in absolute
  terms (244 vs 120). Nothing in `develop` compensates for review time that has
  not happened yet.
- **Independent upgrades.** Five programs can be upgraded, paused or
  authority-rotated separately. `develop` has one upgrade authority and one
  deploy — a blast radius decision that goes the wrong way if you ever want to
  ship a fix to the book without touching settlement.
- **Composable outcome tokens.** YES/NO are real SPL mints, so a third party
  could integrate them without asking. `develop` deleted that surface. Nothing
  used it, but "nothing uses it yet" and "nothing can" are different positions.
- **One collateral token.** Simpler in every client: one balance, one faucet,
  no venue to get wrong. A whole class of client-side bug does not exist under
  `main`'s model.
- **Smaller per-market rent for the book**, since `main` allocates price-level
  accounts on demand rather than one large book account up front. A market that
  never trades costs `main` less.

### Where `develop` is better

- **Density.** ~5 fills per transaction to several hundred; ~29,510 CU per fill
  to ~1,448. This is the change that decides whether a market can clear a
  queue.
- **No caller-side account discovery.** On `main` the caller must know which
  price-level accounts a sweep will touch *before* sending. That is impossible
  to do reliably against a moving book, and it is the source of the failure
  mode where a trade simulates fine and fails on landing.
- **Correctness.** §6 is a list of live defects, several of which take or
  strand funds, and the arithmetic ones (`wad_mul`, the fee/quote direction
  bugs) apply to shared logic `main` still carries.
- **Verified settlement.** Driven end to end on a validator across
  YES/NO/INVALID, with every claim path exercised and per-venue solvency
  asserted. `main` has never had this run.
- **Economic staging.** Incubate in an instance token, graduate to USDC, with
  the book gated in the program rather than the UI. `main` cannot express this
  at all.
- **Half the Rust**, one deploy, one audit artifact.

### Which is more scalable

**`develop`, decisively — but along one axis, and it is worth being precise
about which.**

Neither branch parallelizes *within* a market: every trade write-locks the
book, so a single market is capped by Solana's ~12M CU per-account budget no
matter how many validators are idle. That ceiling is identical on both.

What differs is how much work fits under it. `develop` does ~20× more fills per
CU and ~60× more per transaction, so the same ceiling clears far more volume.
For the question "can one hot market absorb a burst", `develop` wins by roughly
the ratio in §5.

Both scale the same way *across* markets — different markets are different
accounts and run concurrently on both branches.

The honest counterweight: `develop` trades a soft limit for a hard one.
`main`'s per-level accounts grow until rent runs out, which is unbounded and
slow. `develop`'s 4,096 blocks is a real ceiling shared between live orders and
seated traders (~4,096 holders or ~2,048 makers), and raising it costs CU on
the insert walk rather than being free. For the depth public Polymarket books
show, that is comfortable. For a market an order of magnitude busier than
anything either branch has served, `main`'s model degrades gradually where
`develop`'s stops.

### The recommendation

`develop`, with the caveat that its advantage is *unaudited*. The correct next
step is not more features; it is review of `packages/programs-core` and
`packages/sdk-solana`, with §6 and §4a read first — the fee-distribution
constraints and the venue-separation invariant are where a reviewer's time pays
best, because both failure modes are silent.
