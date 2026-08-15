# Launchpad — protocol config, market creation, LP and fees

> Subsystem: `state/protocol_config.rs`, `state/lp_position.rs`, and
> `instructions/{initialize_protocol, pause, unpause, create_market,
> init_market_fee_pool, seed_lp, redeem_lp, distribute_fees,
> distribute_fees_book}.rs`.
> Canon law: [`law/lifecycle.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/lifecycle.md),
> [`law/fee-policy.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/fee-policy.md).

---

## 1. What this covers

The protocol singleton, the instruction that creates a market, the LP token a
market issues against its bonding phase, and the two fee cranks — one per venue.

## 2. Accounts

### 2.1 `ProtocolConfig` — singleton

**Seeds:** `[b"protocol_config"]`. Created once per deployment by
`initialize_protocol`. The fields that matter here, with the full list and the
`initialize_protocol` validations in
[`sooth_market.md`](./sooth_market.md) §2:

| Field                              | Meaning                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `authority`                        | may pause/unpause and drive setters                                        |
| `treasury`                         | the **owner** of the token accounts receiving the protocol slice — one per venue, not a single account |
| `amm_fee_bps`                      | taker fee on the AMM, the incubation venue                                 |
| `book_fee_bps`                     | taker fee on the order book, the mature venue                              |
| `graduation_bps`                   | graduation threshold as a fraction of the creator's deposit; `0` reads as `10_000` |
| `veto_period_secs`                 | window between attestation and settlement (`0 < x <= 30 days`)             |
| split bps (`b_base`, LP, adjudicator) | how a drained fee pool divides; the protocol takes the remainder        |
| `paused`                           | global kill switch                                                         |

The two fee rates are separate because the venues are different products at
different stages and, being denominated in different tokens, cannot share a
rate at all.

### 2.2 `LpPosition` and the LP mint

One LP mint per market, PDA-derived at `[b"lp", market_id]` with
`[b"lp_mint_authority", market_id]` as its authority, 6 decimals.
`LpPosition` records the creator's seed deposit and how much of it has been
reclaimed.

### 2.3 Fee pools and yield vaults — per market

Every market has its own pools, all under the `[b"fee_pool_authority"]` PDA:

| Account                        | Holds                | Fed by                    |
| ------------------------------ | -------------------- | ------------------------- |
| `fee_pool_amm`                 | AMM venue token      | AMM buys and sells        |
| `fee_pool_book`                | book venue token     | book fills                |
| `lp_yield_amm`, `lp_yield_book` | one per venue token | the LP slice of each crank |

There is no global fee pool and no global LP yield vault: a market's fees stay
with that market, and the two venues never mix currencies.

## 3. `create_market`

One instruction opens the market, its AMM state, and its three vaults, and
records the adjudicator pubkey the market will bind to. The question text is
passed in with its sha256 hash, verified on-chain, and emitted in
`MarketCreated`; the `Market` account keeps only `question_hash`, and the
default `market_id` is the first 16 bytes of that hash. See
[`sqf.md`](./sqf.md) for the text format and
[`sooth_market.md`](./sooth_market.md) for the account it writes.

## 4. LP lifecycle

### 4.1 `seed_lp(lp_amount, seed_deposit_wad)`

Creator-only. Requires `seed_deposit_wad >= b·ln(2)` and transfers it from the
creator into `vault_amm`. That number is the LMSR's maximum possible loss, so
the deposit is exactly the liquidity the market maker can give away; without it
the vault cannot pay winners. The instruction creates the LP mint on first call
and mints `lp_amount` to the creator.

### 4.2 LP on buys

Before graduation every AMM buy mints the buyer LP equal to the fee they paid,
in base units — the bonding-phase reward that converts a fee into a claim on the
market's future yield. Minting stops at graduation. The graduating trade still
earns LP; see [`sooth_amm.md`](./sooth_amm.md) §4.1.

### 4.3 `redeem_lp(lp_amount)`

Burns LP and pays a pro-rata share of both `lp_yield_amm` and `lp_yield_book`.
It unlocks when the market's story ends — graduated, settled, or dismissed —
not on graduation alone: a market that settles without graduating would
otherwise strand its LP yield in a vault nothing can open, which in turn blocks
`close_market`, since unclaimed yield is a claim the close refuses to destroy.

### 4.4 `reclaim_subsidy`

Returns the creator's *unspent* subsidy after settlement, bounded both by the
AMM vault's residual over outstanding obligations and by what the creator
actually posted less what they have already reclaimed. Repeatedly callable,
because obligations shrink as traders redeem. Detailed in
[`sooth_market.md`](./sooth_market.md).

## 5. Fee distribution

Two instructions, one per venue, rather than one with a venue argument: the
pool's seed and mint are then fixed by the account struct, so neither can be
handed the other venue's pool. Every destination is pinned by constraint — the
`b_base` leg by address, the adjudicator and treasury legs by token authority —
because the cranker is any signer, and a destination bound only by mint would
let the caller route most of the pool into accounts they control.

The first legs floor and the protocol takes the remainder, so the parts sum to
the whole and no dust is ever stranded. When `lp_mint.supply == 0` the LP slice
folds into the protocol share as well: yield paid after the last LP token was
burned would be unclaimable, and unclaimed yield blocks `close_market`.

- **`distribute_fees_amm`** splits four ways: the `b_base` share returns to
  `vault_amm`, then LP, adjudicator, and the protocol remainder. The `b_base`
  slice deepens the vault; it does not raise `AmmState.b`.
- **`distribute_fees_book`** splits three ways — LP, adjudicator, protocol.
  There is no `b_base` slice: that share exists to grow LMSR liquidity, which is
  denominated in the AMM's token, so feeding it book-denominated fees would be
  exactly the cross-currency mixing the venue split exists to prevent.
  `compute_book_fee_split` folds the missing slice into the protocol remainder,
  so the parts still sum to the whole and no dust is stranded.

Both cranks are permissionless and emit `MarketFeesDistributed`.

## 6. Constraints

- **Rates and splits live on `ProtocolConfig`.** Nothing reads a hard-coded fee.
- **Fee pools are per market and per venue.** A pool never holds the other
  venue's mint; every account struct pins the mint it expects.
- **`seed_lp` must move real money.** A deposit that is recorded but not
  transferred leaves the AMM insolvent at settlement.
- **The heap frame is mandatory**, as on every `sooth_core` instruction — see
  [`README.md`](./README.md).

## 7. Cross-references

- Decision log: D19 (`seed_lp` funds the subsidy), D21 (two venues, two tokens)
- Design note: [`docs/design/dual-token-venues.md`](../design/dual-token-venues.md)
- Sibling specs: [`sooth_market.md`](./sooth_market.md),
  [`sooth_amm.md`](./sooth_amm.md), [`sooth_book.md`](./sooth_book.md)
