# Architecture — `sooth_core`

> The cross-cutting design of the Solana program: what the accounts are, how a
> market moves through its life, and which constraints shape the code. Per-file
> detail lives in the source; this is the map you read first.
>
> Source: `packages/programs-core/programs/sooth-core/src/`.

---

## 1. One program

Sooth on Solana is a single Anchor program, `sooth_core`, deployed to devnet at
`EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw`.

Market lifecycle, the LMSR AMM, the order book, LP and fee flows, and
adjudication are Rust modules inside it, calling each other as ordinary
functions:

```
programs/sooth-core/src/
├── lib.rs             # declare_id!, the 256 KB bump allocator, 30 ix handlers
├── constants.rs       # venue mints, veto bounds, account byte offsets
├── error.rs           # SoothCoreError — ABI-stable, append-only discriminants
├── events.rs          # 28 #[event] types
├── bitmap.rs
├── instructions/      # one file per instruction handler
├── state/             # Anchor accounts: Market, AmmState, Position, LockEntry,
│                      #   LpPosition, ProtocolConfig, AdjudicatorEntry, …
├── book/              # account.rs, arena.rs, matcher.rs, settlement.rs
└── math/              # lmsr.rs, wad.rs, book.rs
```

There is no cross-program CPI, no instruction-introspection gate, no shared
workspace crate holding program IDs or account offsets, and one IDL
(`sooth_core.json`, re-exported by the SDK as `soothCoreIdl`). A function that
should not be callable on its own is simply a private Rust function rather than
a public instruction defended by a parent-instruction check. See decision D22 in
[`docs/decision-log.md`](../../../docs/decision-log.md).

The one place the program still invokes itself is `emit_cpi!`, which writes
durable fill records as inner instructions. Solana permits direct self
recursion, so this needs no second program.

### Instruction surface

Thirty handlers, grouped by what they touch:

| Group | Instructions |
| ----- | ------------ |
| Protocol | `initialize_protocol`, `pause`, `unpause` |
| Creation | `create_market`, `init_market_fee_pool`, `seed_lp` |
| AMM | `trade_positions`, `sell_positions`, `claim_unlocked` |
| Book | `book_init`, `book_grow`, `book_place`, `book_cancel`, `book_withdraw` |
| Fees / LP | `distribute_fees_amm`, `distribute_fees_book`, `redeem_lp` |
| Adjudication | `register_adjudicator`, `request_lock`, `lock_for_resolution`, `attest_outcome`, `dispute`, `settle` |
| End of life | `redeem_amm_position`, `redeem_book_seat`, `claim_refund`, `dismiss_market`, `reclaim_subsidy`, `sweep_residual`, `close_market` |

---

## 2. The dual-venue lifecycle

A market is two venues in sequence, and the program — not the UI — decides which
one is open.

```
create_market ──▶ seed_lp ──▶  AMM bonding (LMSR, instance token)
                                       │
                        fees reach b·ln(2)
                                       ▼
                               MarketGraduated
                                       │
                                       ▼
                              order book (USDC)
                                       │
                             request_lock / lock_for_resolution
                                       ▼
                    attest_outcome ─ veto window ─ dispute?
                                       ▼
                                    settle
                                       ▼
        redeem_amm_position · redeem_book_seat · book_withdraw ·
        redeem_lp · reclaim_subsidy ─▶ sweep_residual ─▶ close_market
```

`MarketLifecycle` is a four-state machine — `Initializing`, `Open`, `Locked`,
`Settled` — and `can_transition_to` permits only `Initializing → Open`,
`Open → Locked`, `Locked → Settled`. Graduation is *not* a lifecycle state; it
is the `AmmState.is_graduated` flag mirrored onto `Market.book_enabled`, so a
graduated market is still `Open` and both venues trade.

### Two tokens, one deployment

The AMM prices in the deployment's instance token; the book prices in USDC. Both
mints are compile-time constants in `constants.rs`:

| Role | Devnet | Mainnet (`--features mainnet`) |
| ---- | ------ | ------------------------------ |
| `AMM_TOKEN_MINT` | `CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu` (mock "EAST") | must be set before the crate compiles |
| `BOOK_TOKEN_MINT` | `ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX` (mock USDC) | real Circle USDC |

Compile-time is the strongest form of "set once at deployment": not storage, not
governance-writable. The consequence, accepted deliberately, is **one program
deployment per instance** — two instances with different AMM tokens are two
program IDs. Both mints are pinned by `address =` account constraints throughout,
so a mismatch is a hard transaction failure rather than a UI inconsistency.
Rationale in [`docs/design/dual-token-venues.md`](../../../docs/design/dual-token-venues.md)
and decision D21.

---

## 3. Accounts

### Singleton

| Account | Seeds | Holds |
| ------- | ----- | ----- |
| `ProtocolConfig` | `[b"protocol_config"]` | authority, treasury, `amm_fee_bps` / `book_fee_bps`, `graduation_bps`, the four-way fee split, `default_trial_period`, `veto_period_secs`, `paused` |
| fee-pool authority | `[b"fee_pool_authority"]` | signer for both venue fee pools |
| LP-yield authority | `[b"lp_yield_authority"]` | signer for both venue LP-yield vaults |

`paused` gates exactly four instructions — `trade_positions`, `sell_positions`,
`book_place`, `seed_lp`. Every exit path stays open while paused, deliberately.

### Per market

`market_id` is a caller-supplied `[u8; 16]` that seeds every per-market PDA. The
SDK defaults it to the first 16 bytes of `sha256(question)`.

| Account | Seeds | Holds |
| ------- | ----- | ----- |
| `Market` | `[b"market", market_id]` | creator, adjudicator, `question_hash`, both vaults, lock vault, `start_time`, `deadline`, lifecycle, `winning_outcome`, `book_enabled` |
| `AmmState` | `[b"amm", market_id]` | `q_yes`, `q_no`, `b`, `seed_q_yes`, `seed_q_no`, `fee_b_base_wad`, `trial_end_at`, `is_graduated`, `is_dismissed` |
| `Book` | `[b"book", market_id]` | the entire order book — see §5 |
| vault authority | `[b"vault", market_id]` | signs both venue vaults |
| lock authority | `[b"lock", market_id]` | signs the sell-cooldown vault |
| fee pools | `[b"fee_pool_amm", market_id]`, `[b"fee_pool_book", market_id]` | per-venue fee accrual |
| LP yield | `[b"lp_yield_amm", market_id]`, `[b"lp_yield_book", market_id]` | per-venue LP yield |
| `LpPosition` | `[b"lp_position", market_id, creator]` | `seed_deposit_wad`, `graduated_at`, `reclaimed_base` |
| LP mint | `[b"lp", market_id]`, authority `[b"lp_mint_authority", market_id]` | LP shares as an SPL mint |
| `AdjudicatorEntry` | `[b"adjudicator", market]` | authority, dispute authority, attested outcome + timestamp, disputed flag |

### Per user

| Account | Seeds | Holds |
| ------- | ----- | ----- |
| `Position` | `[b"pos", market_id, user]` | `yes_shares`, `no_shares` (i128 WAD), `locked_cost_usdc`, `lock_nonce` |
| `LockEntry` | `[b"lock_entry", position, nonce_le]` | one sell's proceeds and its `unlock_at` |

A book trader has no PDA at all. Their seat is a block inside the market's single
`Book` account.

### What is not here

No `BookSide` or per-tick accounts, no `MarketBook`, no `OrderbookPosition`, no
SPL outcome-token mints, and no complete-set mint/merge. A position is a number
in an account, not a transferable token.

---

## 4. The AMM

`trade_positions` (buy) and `sell_positions` (sell) move an LMSR cursor. Cost is
the closed form `C(q + Δ) − C(q)` evaluated in exact WAD fixed point —
`math/lmsr.rs` implements `exp` by range reduction against `ln 2` plus a Taylor
series, and `ln` by bit-length reduction plus an `atanh` series. No lookup
tables, no crank split (decision D4). Measured peak is ~55k CU for the math
inside a ~75–80k CU trade.

Rounding is asymmetric on purpose: inflows round up (`wad_to_usdc_ceil`),
outflows round down (`wad_to_usdc_floor`), so the vault's token balance is a
strict lower bound on its WAD-denominated liability and round-trip trades cannot
drain it a base unit at a time.

**Sell cooldown.** `sell_positions` moves proceeds into the lock vault and opens
a `LockEntry` seeded by the position's monotonic `lock_nonce`; `claim_unlocked`
drains it after `unlock_at`, closes the account, and refunds the rent to the
user. Buys never pay for a lock account, which is why buy and sell are separate
instructions: Anchor evaluates `init` constraints before the handler runs, so a
unified instruction would charge every buyer rent for an escrow they never use.

**Subsidy.** LMSR is a *subsidised* maker — it deliberately collects less from
traders than it owes winners, bounded by `b·ln(2)`. `seed_lp` requires the
creator to post at least that much (`InsufficientSeedDeposit` otherwise) and
transfers it into the AMM vault. Without it the vault cannot pay winners. Market
creation is permissionless but not free: roughly 693 units at `b = 1000`, 34.7 at
`b = 50` (decision D19).

**Graduation.** Every trade — buy or sell — accrues its `fee_wad` into
`AmmState.fee_b_base_wad` and compares it against `b·ln(2) · graduation_bps /
10_000` (`graduation_bps == 0` reads as 10 000, i.e. the full threshold).
Crossing it sets `is_graduated`, emits `MarketGraduated`, and flips
`Market.book_enabled` to true. Both directions count because both pay the same
fee into the same pool. On the buy path the graduation flag is read before the
check, so the trade that graduates the market still earns LP; sells never mint
LP, so that subtlety does not arise there.

**Trial and dismissal.** `dismiss_market` lets the creator wind down a market
that never graduated, after `trial_end_at`; `claim_refund` returns each trader's
`Position.locked_cost_usdc`.

---

## 5. The order book

One dynamically grown, zero-copy account per market, holding both sides on a
single YES-price axis. Decision D23; the study behind it is
[`docs/design/orderbook-redesign.md`](../../../docs/design/orderbook-redesign.md).

### Layout

```
Book  (PDA [b"book", market_id], raw account, bytemuck-cast in place)
├── discriminator  "KooB\0\1\0\0"          8 B
├── BookHeader                           128 B
│     market, next_seq, free_head, bids_head, asks_head,
│     seats_head, block_count, order_count, bump, _reserved
└── blocks[]                              64 B each, one free list
      OrderNode { amount, trader, seq, next, prev, price_tick, side, flags }
      SeatNode  { credit, trader, net, next, kind }
```

Orders and seats share one arena, so a market with many orders and few traders
and a market with the reverse both fit without preallocating for the worst case
of each. `MAX_ORDERS = 4096` is a ceiling on **blocks**, not on orders: a trader
holding a position costs one block (their seat), a resting maker costs two.

`book_init` creates the account; `book_grow` is permissionless and extends it one
`realloc` step per call, bounded by Solana's 10 240-byte-per-instruction growth
cap and by `MAX_ORDERS`.

### Price axis

Ticks are `1..=999` on a single YES axis; a NO order at price `p` is stored as a
YES order at `1 − p`. Crossing is an ordinary limit compare, fills execute at the
**maker's** tick, and the crossing surplus reaches the taker as price
improvement. Bids sort descending, asks ascending, ties by ascending `seq` —
strict price-time priority, maintained on insert over intrusive doubly-linked
lists. The block layout is deliberately tree-compatible, so swapping the index
for O(log n) later would not touch the arena or the wire format.

### Seats

A fill credits `SeatNode.credit` inside the arena instead of transferring to a
maker's ATA. `SeatNode.net` carries the signed position (positive is long YES).
That is what removes the last per-fill account from the fill path:

| | per fill |
| --- | --- |
| extra accounts | **0** |
| extra transaction bytes | **0** |
| CU | **~821** marginal over a ~23k fixed base |

Transaction size and writable-account count are flat whether a taker crosses one
order or twenty, because `book_place` nets the taker's collateral into at most
one transfer each way plus one fee transfer *however many orders it crosses*.
Token cost is per transaction, not per fill. No address lookup tables are
involved.

**Self-trade prevention**: an order that would cross its owner's resting order
cancels that resting order, refunds the escrow to the owner's seat credit, and
keeps walking — a self-order does not shield strangers queued behind it.

### Escrow, cancel, withdraw

A resting order escrows its own leg at its own limit; the escrow is recomputed
from the node rather than stored, and `leg_costs` splits a fill so the two legs
sum to exactly the traded amount (the maker leg floors, the taker leg absorbs
the remainder).

`book_cancel` checks ownership, refunds the escrow to the owner's **seat
credit**, unlinks the node, and emits `BookOrderCancelled`. `book_withdraw` moves
credit to a real token account in a single transfer and frees the seat if it is
left empty. Neither is gated on pause or on lifecycle — they are the exit paths,
and cancel is the only way to recover escrow after settlement. Rent behaviour is
covered in
[`../../sdk-solana/docs/orderbook-cancel-ux.md`](../../sdk-solana/docs/orderbook-cancel-ux.md).

### Gating and fees

`book_place` requires the protocol unpaused, the market `Open`, and
`Market.book_enabled` — a pre-graduation book returns `NotGraduated`. The fee
rate comes from `ProtocolConfig.book_fee_bps`, never from the caller, and is
charged on risk rather than notional:

```
taker_fee = amount · min(tick, 1000 − tick) · book_fee_bps / (1000 · 10_000)
```

which leaves it invariant under the YES↔NO swap.

---

## 6. Fees and LP

Fees accrue per market per venue into plain SPL token accounts owned by the
`fee_pool_authority` PDA. `distribute_fees_amm` and `distribute_fees_book` are
separate permissionless cranks that split a pool four ways per
`ProtocolConfig` — `b_base_share_bps`, `lp_yield_share_bps`,
`adjudicator_share_bps`, `protocol_share_bps`, summing to 10 000. The AMM crank
routes the `b_base` share back into the market vault; the book crank has no
`b_base` destination and folds that share into the remainder.

LP yield lands in the per-market `lp_yield_amm` / `lp_yield_book` vaults. There
is no global yield vault: yield belongs to the market that earned it.
`redeem_lp` burns LP for a pro-rata claim against them.

Every account on both cranks is pinned to that venue's mint, so the two venues
cannot be crossed; the adjudicator's destination is pinned to
`market.adjudicator` and the protocol's to `config.treasury`.

---

## 7. Adjudication and settlement

`register_adjudicator` records the resolving authority and a separate
`dispute_authority` on a per-market `AdjudicatorEntry`.

Attestation and settlement are deliberately two transactions (decision D18):

1. `request_lock` / `lock_for_resolution` moves the market `Open → Locked`.
2. `attest_outcome` records the outcome on `AdjudicatorEntry` and leaves the
   market `Locked`.
3. For `ProtocolConfig.veto_period_secs` the `dispute_authority` may `dispute`
   and override the attested value. The window is bounded
   `0 < x <= 30 days`; zero is rejected rather than read as "no window", because
   an omitted `i64` encodes as `0`. Deployments wanting no delay pass `1`.
4. `settle` is **permissionless** and takes no `winning_outcome` argument — it
   reads the attested value once the window has closed.

Splitting them is what makes the veto real: a `dispute` handler that requires
both an attestation and a not-yet-settled market is unreachable if attestation
settles in the same transaction.

Only the manual adjudicator exists. zkTLS attestation is not implemented — see
the open items in [`docs/status.md`](../../../docs/status.md).

---

## 8. End of life

After `settle`:

- `redeem_amm_position` pays out `Position` shares — full value on the winning
  side, half on `INVALID`.
- `redeem_book_seat` pays `credit + payout`, where payout is `|net|` if the
  sign matches the winner, `|net| / 2` on `INVALID`, else zero. It zeroes both
  fields and frees the seat if nothing is left. Resting orders are deliberately
  untouched; a maker cancels them to recover escrow.
- `book_withdraw` and `claim_unlocked` remain open.
- `reclaim_subsidy` returns the creator's unspent subsidy. It is repeatedly
  callable because obligations shrink as traders redeem, and bounded both by the
  vault residual and by what the creator actually posted.
- `sweep_residual` moves the remaining LMSR surplus to the treasury.
- `close_market` reclaims the rent and leaves an `MKTCLOSD` tombstone in place
  of the `Market` account, requiring five token accounts empty and no live
  orders or funded seats first.

The tombstone exists because `market_id` is caller-chosen: a fully closed PDA
could be re-initialized into a live-looking market that stale `Position`
accounts still point at. A readable "this market is over" fact on chain is
cheaper than defending every reader against that (decision D25).

---

## 9. Numeric domain

| Quantity | Representation |
| -------- | -------------- |
| shares, LMSR cursor, costs | `i128` / `u128` at WAD (1e18) |
| token amounts | `u64` base units; both venue mints are 6-decimal, `WAD_TO_USDC_SCALAR = 1e12` |
| book order `amount` | `u64` base units; `ONE_SHARE = 1_000_000` |
| ticks | `u16`, `1..=999`, `NUM_TICKS = 1000` |
| timestamps | `i64` Unix seconds (`Clock::unix_timestamp`) |
| hashes | `[u8; 32]`, SHA-256 (`solana_program::hash::hash`) |
| errors | `#[error_code] SoothCoreError`, 72 variants, append-only discriminants |

---

## 10. Runtime constraints

**Every transaction must prepend
`ComputeBudgetInstruction::request_heap_frame(256 * 1024)`.** The program
installs a custom 256 KB bump allocator (`SOOTH_CORE_HEAP_LEN`, behind the
default `custom-heap` feature) and the runtime only maps that region when the
transaction asks for it. Without the frame the first allocation lands outside
mapped memory and the instruction aborts with "Access violation in heap
section". This applies to every instruction, not just multi-fill buys. The SDK
adapter adds it on every path it builds, and
`packages/sdk-solana/tests/heap-frame-contract.test.ts` pins the contract from
both directions.

The frame exists because the default 32 KB heap capped matching at three fills —
a four-fill buy OOM'd at ~226k CU. The zero-copy book removed the borsh
`Vec<Order>` pressure that caused it; the only remaining book allocation is the
matcher's `filled_orders` vector.

Two further ceilings worth knowing:

- **`MAX_PERMITTED_DATA_INCREASE = 10_240`** bytes per instruction bounds how far
  `book_grow` can extend the arena in one call.
- **`MAX_WRITABLE_ACCOUNT_UNITS`** is 24M CU per account per block. One hot
  market is one hot account, so a single market has a throughput ceiling —
  markets shard naturally across accounts. Phoenix and Manifest live with the
  same constraint.

---

## 11. Events and off-chain reads

Twenty-eight `#[event]` types. The book emits `BookOrderPlaced`, `BookFilled`,
and `BookOrderCancelled` through `emit_cpi!`, which lands them as inner
instructions — durable transaction data rather than best-effort logs, and
decodable by `decodeBookEventsFromInner` in the SDK. `BOOK_EVENT_VERSION = 1`
is checked on decode, so a version bump fails loudly instead of mis-parsing.

The question text is not persisted on chain. `create_market` takes it as an
argument, rejects anything empty or over `MAX_QUESTION_LEN = 300`, requires
`sha256(question) == args.question_hash`, stores only the hash on `Market`, and
re-emits the text in `MarketCreated`. The SDK's `readMarketQuestion` recovers it
from transaction history, which is what lets cards, portfolios, and page titles
render with no indexer at all (decision D24).

There is no Solana indexer. Frontends read accounts and decode events directly —
adequate at demo scale, and the boundary past which it stops being adequate has
not been drawn.

---

## 12. Testing

- **In-crate**: 120 `#[test]` functions across ten files, concentrated in
  `book/matcher.rs`, `book/settlement.rs`, `book/arena.rs`, and `math/`.
  `cargo test -p sooth_core`.
- **On-chain behaviour**: driven from TypeScript against LiteSVM in
  `packages/sdk-solana/tests/`, which loads `target/deploy/sooth_core.so`
  directly. `pnpm -F @sooth/sdk-solana test`.
- **End to end**: the Playwright suite in `apps/demo/e2e/onchain/` against a
  local validator or Surfpool.

Build with `anchor build` from the repo root; `Anchor.toml` lists
`packages/programs-core/programs/sooth-core` as the single workspace member and
pins the same program ID for devnet and localnet.

---

## 13. Deliberate omissions

Not implemented, and not oversights:

- **Off-chain signed orders** (the EVM "Path B"), retroactive `T*` settlement,
  and `invalidate()` parity — decision D14.
- **Complete sets.** No outcome-token mints, no mint/merge. Positions are
  numbers in accounts.
- **Three-outcome / MAYBE markets.** Markets are binary plus `INVALID`.
- **A guardian allowlist.** The veto is held by a single `dispute_authority`.
- **zkTLS adjudication.**

`error.rs` still carries a handful of variants from the per-tick book —
`BookSideFull`, `MissingCrossingBookSide`, `MakerAccountMismatch`,
`WrongBundleArity` and friends. They are unreachable in the live code and kept
only because the discriminants are ABI-stable and append-only.

---

## Related reading

- [`docs/design/orderbook-redesign.md`](../../../docs/design/orderbook-redesign.md) — the study behind the single-account book
- [`docs/design/dual-token-venues.md`](../../../docs/design/dual-token-venues.md) — why the venues hold different tokens
- [`docs/decision-log.md`](../../../docs/decision-log.md) — what is settled and what is open
- [`../../sdk-solana/docs/integrator-contract.md`](../../sdk-solana/docs/integrator-contract.md) — the client surface over all of this
- [`docs/glossary.md`](../../../docs/glossary.md) — WAD, OUTCOME, tick, CU, PDA, ATA
