# AMM — the LMSR bonding venue

> Subsystem: `math/lmsr.rs`, `math/wad.rs`, `state/amm_state.rs`,
> `state/position.rs`, `state/lock_entry.rs`, and
> `instructions/{trade_positions, sell_positions, claim_unlocked}.rs`.
> Canon law: [`law/amm-lmsr.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/amm-lmsr.md),
> [`law/numeric-domain.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/numeric-domain.md).

---

## 1. What this covers

A Logarithmic Market Scoring Rule market maker, one per market, priced in the
deployment's instance token (`AMM_TOKEN_MINT`). It is the **incubation venue**:
every market opens on the AMM, and the order book stays closed until accrued AMM
fees repay the creator's liquidity subsidy (§5).

The AMM is binary — YES and NO only.

## 2. Accounts

### 2.1 `AmmState` — one per market

**Seeds:** `[b"amm", market_id]`.

| Field            | Type     | Meaning                                                  |
| ---------------- | -------- | --------------------------------------------------------- |
| `market`         | `Pubkey` | backlink to the `Market` PDA                              |
| `q_yes`, `q_no`  | `i128`   | LMSR inventories, WAD; signed for math symmetry           |
| `b`              | `i128`   | liquidity parameter, WAD; positive, stored signed         |
| `seed_q_yes`, `seed_q_no` | `i128` | virtual floor used by `reclaim_subsidy` and `sweep_residual` |
| `fee_b_base_wad` | `u128`   | cumulative fee WAD; the graduation odometer               |
| `trial_end_at`   | `i64`    | trial window end                                          |
| `is_graduated`   | `bool`   | one-way                                                   |
| `is_dismissed`   | `bool`   | trial expired without graduating                          |

Created by `create_market` with `q_yes = q_no = 0`, `b = initial_b`, and
`trial_end_at = now + min(0.3 × (deadline − now), default_trial_period)`.

### 2.2 `Position` — one per (market, user)

**Seeds:** `[b"pos", market_id, user]`. `SPACE = 153`.

`yes_shares` / `no_shares` (`i128`, WAD), `locked_cost_usdc` (`u64`, the
cumulative cost paid in — the refund basis on dismissal), `lock_nonce` (`u64`,
monotonic, the seed component that makes each sell's `LockEntry` unique).

### 2.3 `LockEntry` — one per sell

**Seeds:** `[b"lock_entry", position, nonce_le_bytes]`. `SPACE = 129`.

`amount_usdc` (net proceeds after fee), `unlock_at`, `nonce`. Created by
`sell_positions`, drained and closed by `claim_unlocked` with rent refunded to
the user.

## 3. Math

```text
C(q_yes, q_no, b) = b · ln( exp(q_yes/b) + exp(q_no/b) )
cost of a trade   = C(q + Δ) − C(q)
```

`math/wad.rs` provides WAD fixed-point multiply/divide with checked overflow, the
constants `WAD = 1e18` and `LN2_WAD`, and the two directional converters
`wad_to_usdc_ceil` / `wad_to_usdc_floor` over `WAD_TO_USDC_SCALAR = 1e12`
(6-decimal tokens).

`math/lmsr.rs` implements `exp_wad` and `ln_wad` as range-reduced Taylor series
(12 and 14 terms, ~1e-18 relative error) and folds a **log-sum-exp shift** into
`lmsr_cost`: subtract `m = max(q_yes/b, q_no/b)` before `exp`, add it back
outside `ln`. Both `exp` arguments end up `<= 0`, which keeps arbitrarily
imbalanced markets numerically stable and makes the extreme tail *cheaper* than
the moderately imbalanced case — past `EXP_MAX_INPUT_WAD = 64·WAD` the smaller
side saturates to zero and skips the series entirely. Measured cost is 32k–55k CU
per trade, the 10× imbalanced case being the hot one at ~55k.

Rounding is directional and always in the protocol's favour: buys convert with
`wad_to_usdc_ceil`, sells with `wad_to_usdc_floor`.

## 4. Trading

### 4.1 `trade_positions(outcome, delta_shares, max_cost_wad)` — buy only

`delta_shares` must be positive; a negative value is rejected with
`SellNotImplemented` and routed to `sell_positions` instead, which keeps the
lock-on-sell logic out of the buy path.

Guards: not paused, `outcome ∈ {0, 1}`, `market.is_open()`,
`start_time <= now < deadline`, `!amm.is_dismissed`, `b > 0`.

1. `cost_wad = cost_delta(q_yes, q_no, b, d_yes, d_no)`, required positive.
2. `fee_wad = cost_wad * amm_fee_bps / 10_000`; reject if
   `cost_wad + fee_wad > max_cost_wad` (`SlippageExceeded`).
3. Two user-signed transfers: `cost_usdc` into `vault_amm`, `fee_usdc` into
   `fee_pool_amm`, both ceil-converted. `position.locked_cost_usdc += cost_usdc`.
4. `amm.fee_b_base_wad += fee_wad`, then the graduation check (§5).
5. Update `q_yes`/`q_no` and the position's share legs.
6. Pre-graduation only: mint `fee_usdc` LP tokens to the buyer (§6).
7. Emit `PositionTraded { market, user, outcome, delta_shares, cost_wad, ts }`.

The graduation flag is read into a local **before** step 4 and the LP mint gates
on that stale value. This is deliberate. Graduation fires when accumulated fees
have repaid the subsidy; the trade that crosses the threshold paid its fee while
the market was still pre-graduation, so it earns LP like every trade before it.
Gating on the post-trade flag would mean the trader who completes the repayment
pays a fee and receives nothing while the one immediately before them was paid —
an arbitrary cliff. Moving the graduation check above that read, or re-reading
the flag at the mint site, silently changes who gets paid.

### 4.2 `sell_positions(outcome, delta_shares, min_proceeds_wad, lock_nonce)`

`delta_shares` must be negative, and `lock_nonce` must equal the position's
current `lock_nonce` — the caller supplies it because it is a PDA seed
component, and a mismatch is rejected outright.

`proceeds_wad = |cost_delta(...)|`, `fee_wad = proceeds_wad * amm_fee_bps /
10_000`, `net = proceeds_wad − fee_wad`, checked against `min_proceeds_wad` when
that is non-zero. All conversions floor, and the handler asserts
`net_usdc + fee_usdc <= proceeds_usdc` so rounding can never overpay the vault
out.

Two PDA-signed transfers leave `vault_amm`: the fee to `fee_pool_amm`, the net to
`lock_vault`. A `LockEntry` records the amount and
`unlock_at = now + LOCK_DURATION_SECS` (24 hours), then `position.lock_nonce`
increments. Emits `PositionSold`.

Proceeds are time-locked rather than paid immediately: under adversarial sell
pressure, instant credit lets a seller drain a subsidised pool faster than the
market can reprice. The lock is the mitigation, and it is why the market carries
a third vault.

### 4.3 `claim_unlocked`

Requires `now >= lock_entry.unlock_at` (`LockNotElapsed`). Transfers
`amount_usdc` from `lock_vault` to the user under the lock authority and closes
the `LockEntry`, refunding its rent. Not pause-gated — it is an exit. Emits
`LockClaimed`.

## 5. Graduation

```rust
fn graduation_threshold_wad(b: i128, graduation_bps: u16) -> Result<u128> {
    let deposit_wad = wad_mul(b, LN2_WAD)?;            // = b·ln(2)
    let bps = if graduation_bps == 0 { 10_000 } else { graduation_bps as u128 };
    deposit_wad.checked_mul(bps)?.checked_div(10_000)
}
```

`b·ln(2)` is the LMSR's maximum possible loss, and therefore exactly what the
creator deposited through `seed_lp`. Graduation at 100% of it means "the venue
has earned back the capital that was put at risk on its behalf."
`graduation_bps` generalises that fraction without changing the default; zero
reads as 10 000 because an older config account deserializes its missing field to
zero, and reading that literally would graduate every market on its first trade.

The check runs inline in `trade_positions`, so graduation is atomic with the
trade that triggers it and one-way. When it fires:

- `AmmState.is_graduated = true`, `MarketGraduated` emitted with the accumulated
  and threshold values,
- `Market.book_enabled = true` — the single site that opens the order book,
- LP minting on buys stops.

## 6. LP on buys

Before graduation, every buy mints LP tokens to the buyer equal to the fee they
paid, in base units. This is the bonding-phase reward: the fee is not lost, it
converts into a claim on the market's future yield. Details of the LP mint,
`seed_lp`, and redemption are in
[`sooth_launchpad.md`](./sooth_launchpad.md).

## 7. Constraints

- **Buys ceil, sells floor.** Both directions round toward the vault. Flipping
  either direction opens a rounding drain.
- **Read `is_graduated` before the fee accrues.** §4.1 — the graduating trade
  still earns LP.
- **Graduation is one-way and written at one site.** `AmmState.is_graduated` and
  `Market.book_enabled` are set in the same block; splitting them would let the
  two facts drift.
- **`b` must stay positive.** Every cost computation divides by it.
- **`lock_nonce` is monotonic and caller-echoed.** Reusing a nonce collides with
  a live `LockEntry` PDA; skipping one strands nothing but confuses the SDK's
  enumeration.
- **The heap frame is mandatory**, as on every `sooth_core` instruction — see
  [`README.md`](./README.md).

## 8. Out of scope

- Three-outcome (`MAYBE`) markets. The AMM is binary.
- Selling through `trade_positions`. Sells have their own instruction because
  they escrow.

## 9. Cross-references

- Decision log: D4 (exact WAD LMSR math), D19 (`seed_lp` funds the subsidy;
  positions have redeem paths), D21 (two venues, two tokens)
- Design note: [`docs/design/dual-token-venues.md`](../design/dual-token-venues.md)
- Sibling specs: [`sooth_market.md`](./sooth_market.md),
  [`sooth_launchpad.md`](./sooth_launchpad.md), [`sooth_book.md`](./sooth_book.md)
