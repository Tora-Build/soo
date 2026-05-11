# sooth_amm — LMSR AMM Program (Solana)

> Status: **shipped (devnet)**; under maintenance.
> Canon law: [`law/amm-lmsr.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/amm-lmsr.md),
> [`law/numeric-domain.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/numeric-domain.md),
> [`law/atomicity.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/atomicity.md).
> EVM source mirrored: `sooth-alpha/packages/contracts-core/src/AMMEngine.sol`.
> Architecture context: [`packages/programs-core/docs/architecture.md`](../../packages/programs-core/docs/architecture.md) §4.2, §4.3, §5.

---

## 1. What this program does

`sooth_amm` is the Logarithmic Market Scoring Rule (LMSR) automated market
maker. It owns one `AmmState` per market and one `Position` per (market, user).
It handles all pre-graduation trading and remains available post-graduation
as a secondary venue alongside `sooth_book`.

Devnet program id: `67zS8M81LATLxEgegm5jyYgwFYNTfbF3FnYqxjbZKp7k` (per
`docs/decision-log.md` D6).

## 2. Status

| Surface                                   | Status                                                                |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `initialize_amm_state`                    | shipped                                                               |
| `trade_positions` (buy)                   | shipped                                                               |
| `sell_positions` (sell with lock-on-sell) | shipped                                                               |
| `claim_unlocked`                          | shipped                                                               |
| `close_dismissed_position`                | shipped (parent-ix-gated)                                             |
| `dismiss_market`                          | shipped                                                               |
| LMSR math (exact Taylor exp/ln, WAD)      | shipped — measured 32k–55k CU per trade (D4)                          |
| Three-outcome (`MAYBE`)                   | not implemented — binary YES/NO only                                  |
| LP token mint-on-buy hook                 | shipped — via `sooth_launchpad::mint_lp_for_buy` CPI                  |
| Trial-period guard                        | shipped — via `sooth_launchpad::isTrialExpiredWithoutGraduation` read |

## 3. Account / state model

### 3.1 `AmmState` (one per market)

```rust
// packages/programs-core/programs/sooth_amm/src/state/amm_state.rs
pub struct AmmState {
    pub market: Pubkey,             // bound to sooth_market::Market PDA
    pub q_yes: i128,                // YES inventory, WAD (signed; LMSR allows negative)
    pub q_no:  i128,                // NO inventory,  WAD (signed)
    pub b:     i128,                // LMSR liquidity parameter, WAD
    pub seed_q_yes: i128,           // unclaimable LMSR seed (for floor calc)
    pub seed_q_no:  i128,
    pub fee_b_base_wad: u128,       // graduation tracker / accumulator
    pub trial_end_at: i64,          // unix seconds
    pub is_graduated: bool,
    pub is_dismissed: bool,
    pub bump: u8,
}
```

**Seeds:** `[b"amm", market.market_id.as_ref()]`.
**Owner:** `sooth_amm`.

### 3.2 `Position` (one per (market, user) — AMM-only)

```rust
pub struct Position {
    pub user:   Pubkey,
    pub market: Pubkey,
    pub yes_shares: i128,           // WAD; always >= 0 (signed type for math symmetry with AmmState)
    pub no_shares:  i128,           // WAD; always >= 0
    pub locked_cost_usdc: u64,      // sum-invariant: market_vault == sum(Position.locked_cost_usdc)
    pub lock_nonce: u64,            // monotonic per-position counter; LockEntry seed component
    pub bump: u8,
}
```

**Seeds:** `[b"pos", market.market_id.as_ref(), user.as_ref()]`.

The `locked_cost_usdc` field anchors the AMM's solvency invariant
(every open Position carries a corresponding share of the market USDC
vault). `lock_nonce` makes per-sell `LockEntry` PDA addresses unique.

Per canon's two-venue independence rule, this is the **AMM-only** position
ledger. Orderbook positions live in `sooth_market::OrderbookPosition` (see
[`sooth_book.md`](./sooth_book.md) §3.4 — separated per decision-log D15).

### 3.3 `LockEntry` (one per sell)

```rust
pub struct LockEntry {
    pub user:        Pubkey,
    pub market:      Pubkey,
    pub amount_usdc: u64,              // proceeds in base units (USDC = 6 decimals)
    pub unlock_at:   i64,              // unix seconds; lock_duration = 24h (LOCK_DURATION_SECS)
    pub nonce:       u64,              // copied from Position.lock_nonce at creation; seed component
    pub bump:        u8,
}
```

**Seeds:** `[b"lock", market.market_id.as_ref(), user.as_ref(), nonce.to_le_bytes()]`
(nonce is sourced from `Position.lock_nonce` at the time of the sell).
**Lifecycle:** created on `sell_positions`, drained and closed on
`claim_unlocked` after `unlock_at`. Rent refunded to user on close.

## 4. Instruction surface

| Ix                         | Args                                                          | EVM equivalent                         | Notes                                                                       |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `initialize_amm_state`     | `InitializeAmmStateArgs`                                      | `AMMEngine.initialize`                 | Called by `sooth_launchpad::create_market` via CPI                          |
| `trade_positions`          | `outcome: u8`, `delta_shares: i128`, `max_cost_wad: u128`     | `AMMEngine.tradePositions` (buy path)  | `delta_shares > 0`; reverts on slippage                                     |
| `sell_positions`           | `outcome: u8`, `delta_shares: i128`, `min_proceeds_wad: u128` | `AMMEngine.tradePositions` (sell path) | Separate ix for cleaner lock-on-sell logic; `delta_shares < 0`              |
| `claim_unlocked`           | (none — uses `LockEntry` PDA)                                 | `AMMEngine.claimUnlocked`              | Closes `LockEntry`; refunds rent                                            |
| `close_dismissed_position` | (parent-ix-gated)                                             | `AMMEngine.closeDismissedPosition`     | Called after `sooth_market::claim_refund`; requires parent-ix introspection |
| `dismiss_market`           | (none)                                                        | `AMMEngine.dismissMarket`              | Trial-expiry path; sets `AmmState` to dismissed-frozen state                |

## 5. LMSR math (`math/lmsr.rs`, `math/wad.rs`)

The cost function:

```text
C(q_yes, q_no, b) = b · ln(exp(q_yes / b) + exp(q_no / b))
```

Cost of buying `Δ` shares of outcome `i`:

```text
cost = C(q + Δ) - C(q)
```

Implemented with:

- **`wad.rs`** — fixed-point u256 multiplication/division, ceil/floor rounding.
- **`lmsr.rs`** — shifted Taylor-series `exp_wad` and `ln_wad` against the
  log-sum-exp trick to keep arguments bounded.

D4 (decision-log) records the LMSR-fits-in-CU resolution: measured 32k–55k
CU per trade across 8 representative cases (the imbalanced-10× case is the
hot path at 55,467 CU). Production envelope ≈ 75–80k CU including 2× SPL
token CPI + fee-router CPI. Default 200k per-ix CU limit applies; callers
do NOT need to attach `ComputeBudgetInstruction::set_compute_unit_limit`.

### Numeric domain mapping

| Canon (atoms)            | Solana (WAD)                             | Conversion                                                                |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------- |
| `position_atoms`         | u128 WAD                                 | `1e18 = 1` share                                                          |
| `collateral_atom` (USDC) | u64 base units                           | WAD → base via `wad / 1e12` (USDC has 6 decimals; `BASE_UNIT_WAD = 1e12`) |
| `liquidity`              | u128 WAD (`b`)                           | WAD                                                                       |
| Buy gross debit          | `wad_to_base_ceil(cost_wad)`             | trader pays the ceiling                                                   |
| Sell gross credit        | `wad_to_base_floor(proceeds_wad)`        | trader receives the floor                                                 |
| Fee floor                | `floor(gross * numerator / denominator)` | matches canon                                                             |
| Fee residue              | trader keeps                             | matches canon                                                             |
| Rounding residue         | market reserve keeps                     | matches canon                                                             |

## 6. Trade execution flow

### 6.1 `trade_positions` (buy)

```text
1. Validate: market live, trial not expired, !dismissed, !settled
2. Compute baseCost_wad via LMSR (math/lmsr.rs)
3. Apply slippage: revert if baseCost_wad > max_cost_wad
4. CPI to sooth_launchpad::fee_router → compute fee, accumulate, mint LP-on-buy
5. CPI SPL transfer: user USDC → market USDC vault (ceil rounded)
6. Update AmmState: q_yes / q_no += delta_shares
7. Update Position: yes_shares / no_shares += delta_shares
8. Emit PositionTraded event
```

### 6.2 `sell_positions` (sell with lock-on-sell)

```text
1. Validate: market live, position has shares, slippage check
2. Compute baseProceeds_wad via LMSR (negative cost)
3. CPI to sooth_launchpad::fee_router → fee deducted from proceeds
4. Init LockEntry PDA: amount = floor(netProceeds_wad / 1e12), expiry = now + 24h
5. CPI SPL transfer: market USDC vault → LockEntry USDC ATA
6. Update AmmState: q_yes / q_no -= delta_shares
7. Update Position: yes_shares / no_shares -= delta_shares
8. Emit ProceedsLocked event
```

### 6.3 `claim_unlocked`

```text
1. Validate: LockEntry.expiry <= now
2. CPI SPL transfer: LockEntry USDC ATA → user USDC ATA (full balance)
3. Close LockEntry PDA, refund rent to user
4. Emit LockEntryRemoved event
```

## 7. Cross-program wiring

| Caller                           | Callee                                | Purpose                                           |
| -------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `sooth_launchpad::create_market` | `sooth_amm::initialize_amm_state`     | CPI at market creation                            |
| `sooth_amm::trade_positions`     | `sooth_launchpad::fee_router_*`       | Per-trade fee distribution + LP-on-buy mint       |
| `sooth_amm::sell_positions`      | `sooth_launchpad::fee_router_*`       | Per-sell fee distribution                         |
| `sooth_market::claim_refund`     | `sooth_amm::close_dismissed_position` | Parent-ix-gated cleanup after trial-expiry refund |
| `sooth_book::buy_*` (planned)    | `sooth_amm::is_graduated`             | Pre-orderbook gate read                           |

## 8. Lock-on-sell as deviation from canon

Canon `law/amm-lmsr.md` requires sell execution to credit trader
collateral **immediately**. Solana's `sell_positions` time-locks proceeds
for 24h via `LockEntry` PDAs.

This is an **`accepted-tradeoff` deviation**:

- **Actual behavior**: 24h lock on sell proceeds (mirrors EVM SoothBook
  behavior; D5 confirms the structural load-bearing property).
- **Canon expected**: Immediate credit.
- **Justification**: Lock-on-sell mitigates LMSR-pool drain attacks
  under adversarial sell pressure. EVM ships the same mitigation; canon
  has not yet codified it as a host option.
- **Remediation**: `track-for-future-canon-change`. Canon may want to
  formalize sell-side time-locks as a host-configurable option in a
  future law revision.

Deviation should be filed in `host-kb/solana/deviations.json` once that
file exists.

## 9. Capability claim

Per canon `law/capability-matrix.md` AMM ladder:

| Level | Description                                        | Solana status                                |
| ----- | -------------------------------------------------- | -------------------------------------------- |
| A0    | LMSR cost function                                 | met                                          |
| A1    | Buy + sell execute canonical receipts              | met                                          |
| A2    | Fee policy with residue ownership; slippage guards | met                                          |
| A3    | Trial `0001-solana-amm-slice` vectors pass exactly | **needs verification run**                   |
| A4    | Non-vector envelope gate                           | not yet (Solana has no formal envelope gate) |
| A5    | Three-outcome (`MAYBE`)                            | not met (binary only)                        |

Self-attested level: **`A2`** pending a trial-0001 verification run. After
that run, the matrix-row update lands in `law/capability-matrix.md` and a
decision-log entry.

## 10. Out of scope

- Three-outcome (`MAYBE`) markets — canon vectors include them but the
  Solana programs are binary-only. Promotion to `A5` requires a separate
  feature wave.
- Constant-product AMM fallback (per D4: dropped from mitigation tree).
- LMSR LUT precompute (per D4: dropped; production envelope is well under
  the 200k default CU limit).
- T\* retroactive settlement read (canon adjudicator J4); planned alongside
  `sooth_adjudicator` zkTLS path.

## 11. Cross-references

- Architecture: `packages/programs-core/docs/architecture.md` §4.2, §4.3, §5
- Spike: `_spikes/lmsr-cu/` (CU measurement reproducible via
  `cargo build-sbf && cargo test-sbf -- --nocapture`)
- Decision-log: D4 (LMSR CU resolved), D5 (escrow atomicity load-bearing),
  D6 (devnet program ids), D15 (position-model split — informs `Position`
  vs `OrderbookPosition` boundary)
- Sibling specs: [`sooth_market.md`](./sooth_market.md),
  [`sooth_launchpad.md`](./sooth_launchpad.md), [`sooth_book.md`](./sooth_book.md)
