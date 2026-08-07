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
which could take or strand real money. They are listed in §5 because they are
the part an auditor should read first.

The trade-off: `develop` is younger. `main` has had more eyes and more
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
MAX_ORDERS = 256, BLOCK_SIZE = 64 bytes, zero-copy via bytemuck
```

A linked-list arena inside a single zero-copy account: orders and seats are
fixed-size blocks, sorted by price then time. A taker passes one account and the
program walks the list. Matching happens on chain, so what fills is decided by
the book's actual state at execution, not by the client's guess a second ago.

The account grows on demand. Solana caps growth at 10,240 bytes per
instruction, so `book_init` issues several — that is what `buildBookInitIxs`
is for.

Two consequences worth naming:

- **256 orders per market, not per tick.** A different limit, more useful in
  practice, and reached rather than hit sideways.
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

## 5. Correctness fixes

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

## 6. New: `packages/sooth-data`

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

## 7. Deployment

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

## 8. Known gaps

Stated plainly, because a comparison document that only lists improvements is
not useful for deciding anything.

- **The demo's chain-shim.** `apps/demo/src/lib/chain-shim/` is 3,810 lines
  translating Ethereum-shaped calls (`useReadContract`, `0x…` addresses) into
  Solana. It is a porting artifact and a genuine source of bugs — hex-vs-base58
  market keys, case-folded pubkeys, WAD-vs-base-unit confusion all came from
  it. It is confined to the demo: nothing in `programs-core` or `sdk-solana`
  imports it.
- **Younger code.** Fewer calendar-weeks of review than `main`.
- **No mainnet deployment**, and no audit yet.
- **The indexer polls.** Fine for devnet and a handful of markets; a busy
  market wants Geyser/Yellowstone or a provider webhook. The swap is contained
  — the RPC surface is a two-method interface for this reason.

### Suggested audit scope

`packages/programs-core` and `packages/sdk-solana`. Exclude `apps/demo` and
`packages/sooth-data`: a bug there costs a wrong chart, not funds.

---

## 9. Running it

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
