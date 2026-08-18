# Dual-token venues: the AMM in an instance token, the book in USDC

One program deployment, two currencies. The AMM — the incubation venue — trades
in the deployment's own instance token; the order book — the mature venue —
trades in USDC. A market opens on the AMM, and the book opens only once the
market graduates.

Source of truth is `packages/programs-core/programs/sooth-core/src/constants.rs`
and the per-venue instructions listed in §4.

---

## 1. The constraint that shapes everything

**An SPL token account holds exactly one mint.**

In Solidity one contract holds many ERC20s and separating them is a discipline
you can get wrong. Here the runtime forbids mixing, so the separation is
enforced rather than maintained — but every account that names a vault, a fee
pool or a yield pool becomes two accounts.

```
vault_amm      holds AMM_TOKEN_MINT     (AMM only)
vault_book     holds BOOK_TOKEN_MINT    (book only)

fee_pool_amm   seeds [b"fee_pool_amm",  market_id]
fee_pool_book  seeds [b"fee_pool_book", market_id]

lp_yield_amm   seeds [b"lp_yield_amm",  market_id]
lp_yield_book  seeds [b"lp_yield_book", market_id]
```

Both vaults sit under the existing `vault_authority` PDA — a signer-only PDA
can own one ATA per mint, so no new authority and no new seeds were needed
there. The fee and yield pools are seeded token accounts rather than ATAs, so
each carries its venue in its own seed.

`market.vault` was **renamed** to `vault_book` rather than left alone with
`vault_amm` added beside it, so the compiler had to be satisfied at all 17 use
sites: a wrong-vault reference is the one mistake here that compiles and fails
silently — the wrong vault still exists, still deserializes, still has a
balance, it just holds the other currency.

---

## 2. Token identity

Two compile-time constants:

```rust
// constants.rs
#[cfg(feature = "mainnet")]
pub const AMM_TOKEN_MINT: Pubkey =
    compile_error!("set AMM_TOKEN_MINT for mainnet before building with --features mainnet");
#[cfg(not(feature = "mainnet"))]
pub const AMM_TOKEN_MINT: Pubkey = AMM_TOKEN_MINT_DEVNET;

#[cfg(feature = "mainnet")]
pub const BOOK_TOKEN_MINT: Pubkey = USDC_MINT_MAINNET;
#[cfg(not(feature = "mainnet"))]
pub const BOOK_TOKEN_MINT: Pubkey = USDC_MINT_DEVNET;
```

Both are baked into the program binary. That is the strongest form of "set once
at deployment": not storage, not governance-writable — changing either means
recompiling and redeploying, and every market on a deployment shares the pair.

**The names are roles, never tickers.** Which token fills the AMM role is a
per-deployment decision and not the program's business. On devnet a mock SPL
mint (the mock USDC, `ByF1KoXg…`) stands in for the instance token,
exactly as the project's mock USDC (`ByF1KoXg…`) stands in for Circle's;
mainnet builds take real USDC for the book and `compile_error!` until an AMM
token is chosen, so a placeholder cannot ship by accident.

**Accepted deliberately: one program deployment per instance.** Two instances
with different instance tokens are two program IDs and two audits of the same
source. Putting both mints in `ProtocolConfig` would let one deployment serve
every instance, but it turns token identity into governance-mutable state,
which is a materially weaker guarantee than the one asked for.

Every venue path pins its mint with an `address =` / `mint ==` constraint, so a
mismatch is a hard transaction failure rather than a UI inconsistency.

---

## 3. No outcome tokens

There are no per-market YES/NO SPL mints. Positions are internal accounting: an
AMM `Position` account, and a book `SeatNode` inside the book arena.

They were removed because no trading path touched them — `trade_positions`,
`sell_positions`, `book_place` and the redeem paths carried zero references to
`yes_mint`/`no_mint`. They were a standalone third system with a fixed-rate
entry (1 USDC → 1 YES + 1 NO), a fixed-rate exit, and a settlement exit, with
nothing converting a token into an AMM `Position` or a book seat in either
direction. Their only real value would have been as a transferable, composable
form of a position, and no such integration was planned.

Under two tokens they would also have posed a question with no good answer: an
outcome token has to be denominated in one currency, and would become a third
silo drawing on that vault.

**The rule that would have applied had they been kept**, recorded because it is
the kind of thing that gets built later by someone who does not know: a bridge
between an outcome token and a *book seat* is safe (both USDC); a bridge to an
*AMM position* is a hole. The latter converts a 1-USDC claim into a
1-instance-token claim at a fixed 1:1, so the moment the instance token trades
above USDC, anyone mints sets and drains the AMM vault. Same currency, safe;
crossing currencies, never.

---

## 4. Venue assignment

**Book — `BOOK_TOKEN_MINT`:** `book_place`, `book_ops` (cancel, withdraw),
`redeem_book_seat`, `distribute_fees_book`.

**AMM — `AMM_TOKEN_MINT`:** `trade_positions`, `sell_positions`, `seed_lp`,
`redeem_amm_position`, `reclaim_subsidy`, `claim_unlocked` (sell-lock
proceeds), `claim_refund` (dismissed-market refund), `distribute_fees_amm`. The
sell-lock escrow follows the AMM's token.

**Both — one account per token:** `create_market` creates three vaults across
the two mints; `init_market_fee_pool` creates both fee pools in one instruction,
so a market cannot end up with half its fee plumbing; `redeem_lp` burns once and
pays out of both `lp_yield_amm` and `lp_yield_book` pro-rata.

This assignment is verified by `venue-separation.test.ts` rather than by review:
it parses each instruction's source and fails if one names both venues'
symbols. Reviewing ~30 constraint lines once proves nothing about the next
edit, and the failure mode of getting one wrong is silent.

---

## 5. Behaviour that follows from the split

### 5.1 The book is gated on graduation

`book_place` requires `market.book_enabled`, which `trade_positions` sets once
when graduation fires. Gating was a UI convention before; now the program
refuses.

The flag is mirrored onto `Market` rather than read from `AmmState`, which is
where `is_graduated` lives, because `book_place` already loads `market` and
does not load `amm_state`. Adding `amm_state` to `BookPlace` would cost one
account and 32 bytes on *every* order — the book's headline property is that a
fill costs zero extra accounts, and spending that on a boolean is the wrong
trade.

`book_init` stays ungated: an empty book account created early is harmless and
costs its creator their own rent. `book_cancel` and `book_withdraw` stay
ungated because an exit must always be available.

A market's incubation happens on the AMM — that is what graduation measures and
what the creator's subsidy pays for — so a book trading alongside it would split
liquidity out of the venue being incubated.

### 5.2 Graduation threshold

Graduation fires when accrued fees reach the creator's deposit:

```
threshold = deposit × graduation_bps / 10_000
```

where the deposit is `b·ln(2)`, the LMSR's maximum loss and therefore exactly
the capital the creator put at risk. `graduation_bps` lives in
`ProtocolConfig`; at 10,000 bps (and when zero, which is read as 10,000 rather
than "graduate immediately") the rule is "earn back 100% of capital at risk".
Because it is a multiple of the deposit rather than a price-dependent quantity,
it does not diverge at `p ≠ 0.5`.

### 5.3 Two fee rates

`ProtocolConfig` carries `amm_fee_bps` and `book_fee_bps`, both bounded by
`MAX_FEE_BPS`. The venues cannot share a rate: they are the incubation engine
and the mature venue, in different currencies. Live config is **5% AMM / 1%
book**.

Two properties of the quote layer are load-bearing at a 5% rate and were
invisible at a shared low one, so they are pinned by `quote-direction.test.ts`
against the program's own formulas rather than against recorded constants:
`readQuote` charges the fee on the **magnitude** in both directions, because
`sell_positions` charges a sell the same bps a buy pays; and
`amm-bridge.ts::getPositionQuote` passes the **signed** delta, because
`abs(delta)` prices a sell as the cost of buying more — a different point on the
curve, off by the price impact. Either mistake is absorbed by the UI's ±5%
slippage buffer until the fee grows enough to consume it, at which point sells
fail with `SlippageExceeded` on a market that has not moved.

### 5.4 Two fee pools, two cranks

`distribute_fees_amm` and `distribute_fees_book` are separate permissionless
cranks, each draining its own pool in its own token against the four-way split
(`b_base`, `lp_yield`, `adjudicator`, `protocol`).

`b_base_share_bps` — the share that grows the AMM's `b` — is meaningless for
the book pool: growing an instance-token `b` with book USDC is exactly the
cross-currency leak §3 warns about, so `distribute_fees_book` carries no
`b_base` slice at all.

All four destinations are pinned by address or authority, which is
load-bearing: the crank is permissionless by design, so a destination
constrained only by `token::mint` is a destination the *caller* chooses.
`protocol_treasury_vault` is bound by `token::authority` rather than `address`,
because one treasury pubkey can *own* two token accounts but cannot *be* two
accounts — a constraint demanding both `address = config.treasury` and
`token::mint = venue_mint` is satisfiable by at most one venue.

### 5.5 `reclaim_subsidy` is AMM-only

`reclaim_subsidy` pays the creator `vault − obligations`, bounded by
`posted − reclaimed`. After the split the two venues are in different
currencies and different vaults, so it reasons about one:

- **AMM vault:** obligations are AMM `q` above seed. The creator is paid in the
  instance token, because the deposit was in the instance token. This is the
  real subsidy reclaim.
- **Book vault:** the creator posted nothing, and the book is fully
  collateralised by construction, so there is nothing to reclaim.

The two guards matter: pay only `vault − obligations`, and never more than what
was posted less what has already been reclaimed, so an accounting error can at
worst return the creator's own capital early rather than reach trading profits.

---

## 6. Why each venue stays solvent

Separate vaults do not create a hole, because each venue is independently
collateralised:

- **AMM:** LMSR bounded loss, covered by the creator's `b·ln(2)` deposit.
- **Book:** every fill's bid and ask legs sum to exactly 1.00, so every share
  owed is fully backed.

They never shared funds even when they shared a vault — no instruction moves
value from one ledger to the other. Splitting the account makes an existing
property visible rather than changing it.

**The invariant:** each vault's balance ≥ that venue's own obligations, checked
independently. No instruction may read one vault to satisfy the other.

---

## 7. What it costs

- **Two balances to fund.** A wallet holding only USDC cannot trade any market
  before graduation. Every client, fixture and script has to know which venue it
  is touching, and getting it wrong fails on balance rather than on anything that
  names the cause. `deployments.json` names both tokens and each surface's faucet
  dispenses one card per venue.
- **Cross-venue mixing is a silent failure**, which is why the venue-separation
  test asserts from the Rust source rather than from review.
- **No cross-venue arbitrage is designed for.** The venues are deliberately
  different games, and price divergence between them is acceptable and
  unbounded.

Out of scope here: instance-token tokenomics, any cross-venue bridge, LMSR
mathematics, the pre-graduation fee-as-LP-equity mechanism, and mainnet
deployment.
