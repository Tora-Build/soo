# sooth_launchpad — Factory + Fee Router + LP Token (Solana)

> Status: **shipped (devnet)** — protocol bootstrap, market factory, LP token
> paths, and fee distribution land. Per-market `MarketFeePool` (D16) is the
> only major surface still planned.
>
> **Verification note (2026-05-11)**: The `lib.rs` doc comments on
> `create_market` and `distribute_fees` say "STUB — body is `todo!()`".
> Those comments are stale. The actual handler bodies are real:
> `create_market` is a 4-leg CPI bundle to `sooth_market` + `sooth_amm`,
> and `distribute_fees` implements the 4-way bps split with
> remainder-to-protocol. See §4.2 + §4.4.
> Canon law: [`law/lifecycle.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/lifecycle.md) (graduation + trial),
> [`law/fee-policy.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/fee-policy.md),
> [`law/atomicity.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/atomicity.md).
> EVM source mirrored: `sooth-alpha/packages/contracts-core/src/LaunchpadEngine.sol` + `FeeRouter.sol` + `LaunchpadLPToken.sol`.
> Architecture context: [`packages/programs-core/docs/architecture.md`](../../packages/programs-core/docs/architecture.md) §4.1, §8, §9.

---

## 1. What this program does

`sooth_launchpad` is the market factory + fee router + LP token authority.
It owns the `ProtocolConfig` singleton, the global `fee_pool_vault` (being
migrated to per-market pools per `evm-direct-port.md` §3.5 / D16), the
per-market `LpMint` and `LpYieldVault` PDAs, and the trial-period clock.

It is the EVM `LaunchpadEngine` + `FeeRouter` + `LaunchpadLPToken`
collapsed into one Solana program (per architecture §1: `FeeRouter` has no
upgrade story or external callers, so CPI overhead is unnecessary).

Devnet program id: `HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3` (D6).

## 2. Status

| Surface                                                | Status                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize_protocol`                                  | shipped                                                                                                                                |
| `initialize_fee_pool` (global)                         | shipped — will be retired in favor of per-market pools per D16                                                                         |
| `create_market` (4-leg CPI bundle)                     | shipped — CPIs sooth_market::{initialize_market, initialize_outcome_mints, initialize_market_vaults} + sooth_amm::initialize_amm_state |
| `distribute_fees` (4-way bps split)                    | shipped — floor-div + remainder-to-protocol; bps from `ProtocolConfig`                                                                 |
| `seed_lp` (creator deposit → LP)                       | shipped (Wave 5C)                                                                                                                      |
| `mint_lp_for_buy` (per-buy LP-on-buy mint)             | shipped — CPI'd by `sooth_amm::trade_positions`                                                                                        |
| `redeem_lp` (post-settle LP burn → yield)              | shipped                                                                                                                                |
| Per-market `MarketFeePool` (D16)                       | **planned** — lands with `sooth_book` port W2                                                                                          |
| Trial-period clock + `isTrialExpiredWithoutGraduation` | shipped                                                                                                                                |

## 3. Account / state model

### 3.1 `ProtocolConfig` (singleton)

```rust
// packages/programs-core/programs/sooth_launchpad/src/state/protocol_config.rs
pub struct ProtocolConfig {
    pub authority: Pubkey,             // admin / config rotator (multisig in production)
    pub treasury:  Pubkey,             // protocol-share USDC ATA destination
    pub fee_bps:   u16,                // total per-trade fee in bps; bounded ≤ 10_000
    // 4-way split bps — must sum to 10_000 (architecture §8)
    pub b_base_share_bps:      u16,
    pub lp_yield_share_bps:    u16,
    pub adjudicator_share_bps: u16,
    pub protocol_share_bps:    u16,
    pub default_trial_period:  i64,    // seconds; concrete trial_end_at computed per-market
    pub bump: u8,
}
```

**Seeds:** `[b"protocol_config"]`. Bootstrapped at protocol init via
`initialize_protocol`. EVM analogue: `LaunchpadEngine` constructor +
`setDefaultTrialPeriod` + `FeeRouter` constructor — all collapsed.

**Note on graduation:** there is no `graduation_bps` field. The
graduation threshold is `b · ln(2)` (the LMSR doubling-of-liquidity
point), computed at trade time from `AmmState.b` — not configurable
through `ProtocolConfig`. See §6.

**Note on invalidation buffer:** EVM's `invalidationBuffer` is not
mirrored as a config field today. The `invalidate()` parity gap is
tracked in [`sooth_book.md`](./sooth_book.md) §15.

### 3.2 `LpPosition` (one per (market, user))

```rust
// packages/programs-core/programs/sooth_launchpad/src/state/lp_position.rs
pub struct LpPosition {
    pub market:   Pubkey,
    pub creator:  Pubkey,             // creator's deposit (seed LP); only one LpPosition per market today
    pub lp_mint:  Pubkey,             // per-market LP SPL mint
    pub seed_deposit_wad: u128,       // WAD; baseline for redeem floor calc
    pub graduated_at: i64,            // unix seconds; 0 until graduation flips on AmmState
    pub bump: u8,
}
```

**Seeds:** `[b"lp_position", market.market_id.as_ref(), creator.as_ref()]`.
Per-creator (not per arbitrary holder) — only the seed depositor gets an
`LpPosition`. LP token transfer is via the SPL mint; subsequent holders
are tracked by the LP ATA balance, not by additional `LpPosition` PDAs.

### 3.3 `LpMint` + LP ATA (per market)

LP tokens are SPL Mints owned by `sooth_launchpad` (mint authority =
`lp_mint_authority` PDA). Created lazily by `seed_lp` and supplemented
on every pre-graduation buy via `mint_lp_for_buy`.

**Seeds:** `[b"lp_mint", market.market_id.as_ref()]`.

### 3.4 Global `fee_pool_vault` (being retired)

The current `initialize_fee_pool` creates a singleton USDC ATA at
`[b"fee_pool_authority"]`. Per **D16** this is moving to per-market
`MarketFeePool` accounts. The global pool will be drained once via
`distribute_fees_legacy` on the deploy day after the migration ships;
afterward the global pool is permanently empty. See
[`sooth_book.md`](./sooth_book.md) §3.5 for the per-market pool design.

## 4. Instruction surface

### 4.1 Protocol bootstrap

| Ix                          | Args                                                                  | Notes                                                                                    |
| --------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `initialize_protocol(args)` | `InitializeProtocolArgs` (fee bps, trial period, invalidation buffer) | One-shot; rent paid by signer                                                            |
| `initialize_fee_pool`       | —                                                                     | One-shot global fee pool init. Will be retired per D16; replaced by lazy `MarketFeePool` |

### 4.2 Market creation

| Ix                    | Args                                                                             | Status                          | EVM equivalent                 |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------- | ------------------------------ |
| `create_market(args)` | `CreateMarketArgs` (market_id, question_hash, start_time, deadline, adjudicator) | shipped — full 4-leg CPI bundle | `LaunchpadEngine.createMarket` |

`create_market` CPIs into the four init legs in order:

1. `sooth_market::initialize_market`
2. `sooth_market::initialize_outcome_mints`
3. `sooth_market::initialize_market_vaults`
4. `sooth_amm::initialize_amm_state`

`seed_lp` is **NOT** bundled into `create_market`. It is a separate
caller-driven ix (see §4.3) — keeps `try_accounts` codegen under the
SBF 4 KB stack ceiling, same constraint that fragmented
`sooth_market::initialize_market` into three legs.

`CreateMarketArgs` actual shape (per
`instructions/create_market.rs:180-210`): `market_id: [u8; 16]`,
`question_hash: [u8; 32]`, `start_time: i64`, `deadline: i64`,
`adjudicator: Pubkey`. Question text is NOT passed — the caller hashes
it off-chain and submits only the hash (see [`sqf.md`](./sqf.md) §4).

### 4.3 LP token lifecycle

| Ix                             | Args                                           | Caller                               | EVM equivalent                            |
| ------------------------------ | ---------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| `seed_lp(args)`                | `SeedLpArgs` (initial deposit + LP allocation) | creator                              | `LaunchpadEngine._mintLPTokens` (private) |
| `mint_lp_for_buy(amount: u64)` | LP base units                                  | `sooth_amm::trade_positions` via CPI | `AMMEngine.mintLPTokens`                  |
| `redeem_lp(lp_amount: u64)`    | LP base units                                  | LP holder (post-settle)              | `LaunchpadLPToken.redeem` (post-settle)   |

`seed_lp` is hoisted out of `create_market` to keep `try_accounts` under
the SBF 4 KB ceiling; same constraint that fragmented
`sooth_market::initialize_market` into three legs.

`mint_lp_for_buy` is parent-ix-gated: only callable from
`sooth_amm::trade_positions`. The user signs the top-level AMM ix; the
launchpad CPI is signed by `sooth_amm`'s PDA. Mirrors the
`sooth_market::transfer_to_lock` PDA-signing pattern.

`redeem_lp` gated on `lifecycle == Settled`. Computes pro-rata share of
the post-settle USDC yield vault based on the pre-burn LP mint supply.

### 4.4 Fee distribution

| Ix                | Args | Status                                                       | EVM equivalent                  |
| ----------------- | ---- | ------------------------------------------------------------ | ------------------------------- |
| `distribute_fees` | —    | shipped — 4-way bps split, floor-div + remainder-to-protocol | `FeeRouter._distributePostGrad` |

Drains the global `fee_pool_vault` token-balance and splits across:

- `bBase` (LP yield + b-growth)
- `LP yield pool`
- `Adjudicator share`
- `Protocol treasury`

Split bps live in `ProtocolConfig`. EVM defaults: 50 / 30 / 10 / 10
(see canon `law/fee-policy.md`).

## 5. Trial period clock

`AmmState.trial_end_time` holds the trial deadline. The AMM uses
`launchpadEngine.isTrialExpiredWithoutGraduation(market)` semantics via
direct read of `AmmState.is_graduated` and `AmmState.trial_end_time`.

Once expired without graduation:

- AMM `trade_positions` and `sell_positions` revert
- `dismiss_market` flips the AMM into a dismissed state
- Adjudicator path or permissionless path (planned) settles as `INVALID`
- Users call `claim_refund` on `sooth_market` to recover their seed
  collateral

## 6. Graduation

Graduation is the canonical `BONDING → LIVE` transition. The threshold is
the LMSR doubling-of-liquidity point — when accumulated bBase fees equal
`b · ln(2)`, the AMM has earned back its initial liquidity provisioning.

```text
threshold_wad = wad_mul(AmmState.b, LN2_WAD)
if AmmState.fee_b_base_wad >= threshold_wad { AmmState.is_graduated = true }
```

Source: `sooth_amm/src/instructions/trade_positions.rs:498-503`. The
check fires **inline in `trade_positions`** on every pre-graduation buy
(not in `distribute_fees`); graduation is one-shot and atomic with the
triggering trade per canon `law/lifecycle.md`. On graduation:

- `AmmState.is_graduated = true`
- (planned) `sooth_book::MarketBook` becomes initializable
- LP-on-buy minting stops (per EVM behavior)
- `MarketGraduated` event emitted with `fees_accumulated_wad` and `threshold_wad`

`distribute_fees` is a separate post-graduation crank that drains the
fee pool into the 4-way bps split. The migration from the global
`fee_pool_vault` to per-market `MarketFeePool` accounts (D16) lands
alongside the `sooth_book` port per W5 in `evm-direct-port.md` §11.

## 7. Canon mapping

Per canon `law/lifecycle.md` graduation rule:

> Graduation must be deterministic, atomic with the triggering trade,
> one-shot, and trial-bounded.

Solana implementation status against each:

| Canon requirement                             | Solana status                                       |
| --------------------------------------------- | --------------------------------------------------- |
| Deterministic                                 | met (fee accumulator + threshold read)              |
| Atomic with triggering trade                  | met (single tx)                                     |
| One-shot                                      | met (`is_graduated` flag)                           |
| Trial-bounded (rejects post-trial graduation) | met (`isTrialExpiredWithoutGraduation` revert path) |

Per canon `law/fee-policy.md`:

| Canon rule                                              | Solana status                                           |
| ------------------------------------------------------- | ------------------------------------------------------- |
| 4-way split (bBase / LP yield / adjudicator / treasury) | shipped (`distribute_fees`)                             |
| Pull-based adjudicator / treasury claims                | shipped (drained from per-market fee pool destinations) |
| LP yield through floor (no separate claim)              | shipped (via `redeem_lp`)                               |
| Pre-grad fee = LP-on-buy mint                           | shipped (`mint_lp_for_buy`)                             |

## 8. Capability claim

Per canon `law/capability-matrix.md`:

| Lane                       | Level claim                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Lifecycle (graduation)     | `L1` — `create_market` shipped, graduation hook fires inside `distribute_fees` when accumulator crosses threshold |
| Settlement / LP redemption | `S3` — LP floor calc works in `redeem_lp` (post-settle gated)                                                     |
| Fee policy                 | shipped — pre-grad LP-on-buy + post-grad 4-way split both land; D16 per-market pool migration pending             |

Self-attested aggregate: **`L1 + S3`** (verified via handler bodies on
2026-05-11). `L2` (trial expiry) depends on
`sooth_amm::dismiss_market` (shipped) plus the adjudicator
`INVALID`-settle path (shipped via `sooth_adjudicator::attest_outcome`);
when the conformance harness exercises this end-to-end the lane can
promote to `L2`. `L5` (permissionless `invalidate()` fallback) remains a
gap per `evm-direct-port.md` §15.

## 9. Forbidden shortcuts

- Do **not** mutate `Market.adjudicator` from `sooth_launchpad`. The
  binding is set in `sooth_market::initialize_market` and is immutable
  per the audit story.
- Do **not** call `mint_lp_for_buy` outside the `sooth_amm::trade_positions`
  parent-ix. The auth gate is the security boundary.
- Do **not** drain `fee_pool_vault` outside the bps split. The
  4-way split is canon-mandated; bypassing it would silently underpay
  one of bBase / LP yield / adjudicator / treasury.
- Do **not** allow `seed_lp` to run after `is_graduated == true`. Creator
  deposits are pre-graduation only.

## 10. Out of scope

- Permissionless `invalidate()` after trial expiry — gap exists today;
  per `evm-direct-port.md` §15 the fix should land alongside the
  `sooth_book` audit window.
- `MarketRegistry` aggregate (canon work-queue item for cross-host
  uniformity).
- Cross-program adjudicator fee claim helper — currently the adjudicator
  pulls from its own accrual via separate ix. Future cleanup may unify.

## 11. Cross-references

- Architecture: `packages/programs-core/docs/architecture.md` §4.1, §8, §9
- Decision-log: D6 (devnet ids), D16 (per-market fee pools)
- Sibling specs: [`sooth_amm.md`](./sooth_amm.md), [`sooth_market.md`](./sooth_market.md),
  [`sooth_adjudicator.md`](./sooth_adjudicator.md), [`sooth_book.md`](./sooth_book.md)
