# Market — lifecycle, custody, settlement, end of life

> Subsystem: `state/market.rs`, `state/lifecycle.rs`, `state/protocol_config.rs`,
> and the lifecycle instructions (`initialize_protocol`, `pause`/`unpause`,
> `lock_for_resolution`, `settle`, `redeem_amm_position`, `dismiss_market`,
> `claim_refund`, `sweep_residual`, `close_market`).
> Canon law: [`law/lifecycle.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/lifecycle.md),
> [`law/settlement-redemption.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/settlement-redemption.md).

---

## 1. What this covers

The `Market` account is the spine every other subsystem hangs off: it owns the
lifecycle state, the three vault addresses, the outcome, and the flag that opens
the order book. This spec covers that account, the protocol-level config above
it, and the paths that end a market's life — settlement and redemption, the
trial-expiry refund path, and the terminal close.

## 2. `ProtocolConfig`

**Seeds:** `[b"protocol_config"]`. Singleton, `SPACE = 165`. The full field list
is below; how the fee-split fields are consumed is in
[`sooth_launchpad.md`](./sooth_launchpad.md) §5.

| Field                         | Type     | Meaning                                                     |
| ----------------------------- | -------- | ------------------------------------------------------------ |
| `authority`                   | `Pubkey` | may pause, unpause, and register adjudicators when gated      |
| `treasury`                    | `Pubkey` | the **owner** of treasury token accounts, not an account itself |
| `amm_fee_bps`                 | `u16`    | AMM taker fee                                                 |
| `book_fee_bps`                | `u16`    | book taker fee                                                |
| `graduation_bps`              | `u16`    | graduation threshold as a fraction of the `b·ln(2)` deposit; **`0` reads as `10_000`** |
| `b_base_share_bps`            | `u16`    | fee split — LMSR liquidity                                    |
| `lp_yield_share_bps`          | `u16`    | fee split — LP yield                                          |
| `adjudicator_share_bps`       | `u16`    | fee split — adjudicator                                       |
| `protocol_share_bps`          | `u16`    | fee split — treasury (descriptive; the code pays the remainder) |
| `default_trial_period`        | `i64`    | seconds; input to each market's trial window                  |
| `paused`                      | `bool`   | trading circuit breaker                                       |
| `permissionless_adjudicators` | `bool`   | true → the market creator may register; false → only `authority` |
| `veto_period_secs`            | `i64`    | guardian veto window                                          |

`initialize_protocol` is one-shot and validates: both fee rates `<= MAX_FEE_BPS`
(`10_000`), `treasury != default`, `default_trial_period > 0`,
`0 < veto_period_secs <= MAX_VETO_PERIOD_SECS` (30 days), and the four share bps
summing to exactly `10_000` (`FeeSplitMismatch`). `graduation_bps` has no
argument and no setter, so it stays `0` and is read as full repayment — zero must
mean 10 000 rather than "graduate immediately", because a config account laid out
without the field deserializes to zero.

### 2.1 Pause scope

`pause`/`unpause` require `config.authority` and are idempotent, emitting
`ProtocolPausedEvent`. `require_not_paused` is a **trading** halt, not a freeze:

| Paused                                                           | Never paused                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `trade_positions`, `sell_positions`, `book_place`, `seed_lp`, `create_market` | every exit — `redeem_amm_position`, `redeem_book_seat`, `book_cancel`, `book_withdraw`, `claim_unlocked`, `claim_refund`, `redeem_lp`, `reclaim_subsidy` — plus the whole resolution path and the fee cranks |

A pause that trapped funds would be a worse failure than whatever it was invoked
to contain.

## 3. `Market`

**Seeds:** `[b"market", market_id]`.

| Field                  | Type              | Meaning                                                     |
| ---------------------- | ----------------- | ------------------------------------------------------------ |
| `market_id`            | `[u8; 16]`        | caller-supplied; the SDK derives it from `sha256(question)[..16]` |
| `creator`              | `Pubkey`          | pays rent, gets it back on close; gates `seed_lp`, `dismiss_market`, `close_market` |
| `adjudicator`          | `Pubkey`          | designated resolver identity; pins the adjudicator fee destination |
| `question_hash`        | `[u8; 32]`        | sha256 of the question text (see [`sqf.md`](./sqf.md))        |
| `vault_book`           | `Pubkey`          | book collateral vault, `BOOK_TOKEN_MINT`                      |
| `vault_amm`            | `Pubkey`          | AMM collateral vault, `AMM_TOKEN_MINT`                        |
| `lock_vault`           | `Pubkey`          | sell-cooldown escrow, `AMM_TOKEN_MINT`                        |
| `start_time`           | `i64`             | trading opens                                                 |
| `deadline`             | `i64`             | trading closes                                                |
| `lifecycle`            | `MarketLifecycle` | see below                                                     |
| `winning_outcome`      | `u8`              | written by `settle`; meaningful only when `Settled`           |
| `bump`, `vault_authority_bump`, `lock_authority_bump` | `u8` | PDA bumps                                     |
| `book_enabled`         | `bool`            | mirror of `AmmState.is_graduated`; opens the book             |

Outcome encoding is protocol-wide: `OUTCOME_NO = 0`, `OUTCOME_YES = 1`,
`OUTCOME_INVALID = 2`.

The three vaults are named per venue because picking the wrong one is the single
mistake here that could fail quietly rather than loudly; an SPL token account
holds exactly one mint, so they cannot be merged.

Both venue mints are **compile-time constants** (`AMM_TOKEN_MINT`,
`BOOK_TOKEN_MINT`) pinned by `address =` constraints throughout the program. A
mismatch is a hard transaction failure, never a UI inconsistency. One deployment
serves one instance token; two instance tokens are two program IDs.

### 3.1 Lifecycle

```rust
pub enum MarketLifecycle { Initializing, Open, Locked, Settled }
```

`can_transition_to` permits exactly `Initializing → Open`, `Open → Locked`,
`Locked → Settled`. Nothing else is legal, and `Settled` is terminal.

There is no `Dismissed` lifecycle state: trial expiry is
`AmmState.is_dismissed`, a separate axis, because a dismissed market still has to
support refunds and eventual close.

### 3.2 The account graph

| Account              | Seeds                                            | Kind                     |
| -------------------- | ------------------------------------------------ | ------------------------ |
| `Market`             | `[b"market", market_id]`                         | data                     |
| `AmmState`           | `[b"amm", market_id]`                            | data                     |
| `Position`           | `[b"pos", market_id, user]`                      | data                     |
| `LockEntry`          | `[b"lock_entry", position, nonce_le]`            | data                     |
| `LpPosition`         | `[b"lp_position", market_id, creator]`           | data                     |
| `AdjudicatorEntry`   | `[b"adjudicator", market]`                       | data (market **pubkey**) |
| `Book`               | `[b"book", market_id]`                           | raw zero-copy            |
| `vault_authority`    | `[b"vault", market_id]`                          | signer-only PDA          |
| `lock_authority`     | `[b"lock", market_id]`                           | signer-only PDA          |
| `vault_book`         | ATA of `vault_authority` for `BOOK_TOKEN_MINT`   | token                    |
| `vault_amm`          | ATA of `vault_authority` for `AMM_TOKEN_MINT`    | token                    |
| `lock_vault`         | ATA of `lock_authority` for `AMM_TOKEN_MINT`     | token                    |
| `fee_pool_authority` | `[b"fee_pool_authority"]`                        | signer-only PDA, global  |
| `fee_pool_amm`       | `[b"fee_pool_amm", market_id]`                   | token, AMM mint          |
| `fee_pool_book`      | `[b"fee_pool_book", market_id]`                  | token, book mint         |
| `lp_yield_authority` | `[b"lp_yield_authority"]`                        | signer-only PDA, global  |
| `lp_yield_amm`       | `[b"lp_yield_amm", market_id]`                   | token, AMM mint          |
| `lp_yield_book`      | `[b"lp_yield_book", market_id]`                  | token, book mint         |
| `lp_mint`            | `[b"lp", market_id]`                             | SPL mint, 6 decimals     |
| `lp_mint_authority`  | `[b"lp_mint_authority", market_id]`              | signer-only PDA          |

Fee pools and yield vaults are **per market**, in both venue tokens. There is no
global fee pool.

## 4. Resolution

Both halves are covered in detail in
[`sooth_adjudicator.md`](./sooth_adjudicator.md); from the market's side:

| Instruction           | Signer                             | Effect                                            |
| --------------------- | ---------------------------------- | ------------------------------------------------- |
| `request_lock`        | `AdjudicatorEntry.authority`       | `Open → Locked`, but only once `now >= deadline`  |
| `lock_for_resolution` | `AdjudicatorEntry.authority`       | `Open → Locked`, emits `MarketLocked`             |
| `settle`              | anyone, after the veto window       | `Locked → Settled`, writes `winning_outcome`      |

`settle` takes no outcome argument: it reads the attested value off the
`AdjudicatorEntry`, which is what makes the veto window unroutable-around.

## 5. Redemption

`redeem_amm_position` requires `market.is_settled()` and pays the AMM position:

```rust
let payout_wad = match outcome {
    OUTCOME_YES     => yes_shares,
    OUTCOME_NO      => no_shares,
    OUTCOME_INVALID => (yes_shares + no_shares) / 2,
    _ => return err!(InvalidOutcome),
};
let usdc_payout = wad_to_base(payout_wad)?;  // floor
```

Both share legs are zeroed **before** the transfer, so a repeat call is a no-op;
then `amm.q_yes` and `amm.q_no` are decremented with checked math, so an
underflow is loud rather than silent. Payment is a PDA-signed transfer out of
`vault_amm`. Emits `Redeemed`.

The `Position` account is deliberately **not** closed: outstanding `LockEntry`
PDAs derive their seeds from `position.key()`, and closing the position would
strand them. The cost is roughly 0.00083 SOL of rent per position, left
uncollected.

Book positions redeem separately through `redeem_book_seat`
([`sooth_book.md`](./sooth_book.md) §5), from a different vault in a different
token. The `INVALID` half-payout rule is identical on both sides so the two
ledgers cannot drift.

## 6. Trial expiry

A market that never graduates can be wound down without an adjudicator:

- `dismiss_market` — creator signs, requires `now >= amm.trial_end_at`,
  `!is_graduated`, `!is_dismissed`. Sets `AmmState.is_dismissed`; the lifecycle
  is untouched.
- `claim_refund` — any user with a position, once the market is dismissed. The
  refund is `Position.locked_cost_usdc`, the cumulative cost paid in, decremented
  by any sells. It pays out of `vault_amm` under the vault authority and then
  closes the `Position` inline.

`claim_refund` reads the `Position` as an `UncheckedAccount` and validates it by
hand — re-deriving the PDA, checking program ownership and length, and reading
`user` and `market` at fixed byte offsets — because the refund amount is a single
field and the account is closed in the same instruction.

## 7. End of life

**`sweep_residual`** is permissionless, with the destination pinned to the
configured treasury. It requires `is_settled()` and an *exact* outstanding-claims
gate rather than a heuristic: `q_yes == seed_q_yes` for a YES outcome,
`q_no == seed_q_no` for NO, both for INVALID. It then reserves the creator's
unreclaimed subsidy before sweeping what is left of `vault_amm`. The book venue
needs no sweep — it is zero-sum between seats.

**`close_market(market_id)`** is signed by the creator, who receives every
reclaimed lamport. It requires `is_settled() || amm_state.is_dismissed`, all
three vaults and all four fee/yield accounts at zero balance, and — if the book
account exists — no live orders and no funded seats.

It does not delete the `Market` account. Instead the account is shrunk to 8 bytes
and stamped:

```rust
/// Written over the Market account's discriminator on close. Deliberately not
/// a hash of any account name, so no Anchor account type will ever match it.
pub const MARKET_TOMBSTONE: [u8; 8] = *b"MKTCLOSD";
```

Deleting it outright would be unsafe. Every per-market PDA derives from the
caller-supplied `market_id`, so a deleted `Market` could be re-created at the same
id, and stale `Position` accounts would deserialize against the fresh market — a
trader whose losing shares expired worthless could re-create the id, seed a thin
market, and sell those shares into somebody else's fresh collateral. With the
tombstone in place, `create_market` fails at init because the account exists, and
every `Account<Market>` load fails its discriminator check. The cost is roughly
0.001 SOL locked forever out of ~0.017 reclaimed.

The `AmmState` account and the seven token accounts are closed properly; the book
account's data is zeroed and its lamports drained after all CPIs, keeping the
lamport-sum invariant. The LP mint cannot be closed — classic SPL mints have no
close authority — so ~0.0015 SOL stays stranded there. Emits `MarketClosed`.

## 8. Constraints

- **`Settled` is terminal and the transition table is total.** Every lifecycle
  write goes through `can_transition_to`.
- **Never delete the `Market` account.** The tombstone is what makes market-id
  reuse impossible; see §7.
- **Never close a `Position` in `redeem_amm_position`.** `LockEntry` seeds depend
  on the position address.
- **Never let `Market.adjudicator` change after creation.** It is recorded at
  creation and pins the adjudicator's fee destination.
- **Never gate an exit path on `paused`.** See §2.1.
- **Never treat `INVALID` as an error.** It is a real outcome with a half-payout
  rule, and both venues implement it identically.

## 9. Cross-references

- Decision log: D18 (attest and settle are separate), D21 (two venues, two
  tokens), D25 (a market's life can end)
- Sibling specs: [`sooth_amm.md`](./sooth_amm.md),
  [`sooth_book.md`](./sooth_book.md),
  [`sooth_launchpad.md`](./sooth_launchpad.md),
  [`sooth_adjudicator.md`](./sooth_adjudicator.md), [`sqf.md`](./sqf.md)
