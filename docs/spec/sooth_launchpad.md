# sooth_launchpad — Factory + Fee Router + LP Token (Solana)

> Status: **partial (devnet)** — protocol bootstrap, LP token paths, and
> AMM fee accumulator land; `create_market` + `distribute_fees` bodies
> are `todo!()` stubs awaiting CPI plumbing.
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

| Surface                                                | Status                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `initialize_protocol`                                  | shipped                                                        |
| `initialize_fee_pool` (global)                         | shipped — will be retired in favor of per-market pools per D16 |
| `create_market` (4-leg CPI bundle)                     | **stub** — body is `todo!()`; Accounts struct shape committed  |
| `distribute_fees` (4-way split)                        | **stub** — body is `todo!()`                                   |
| `seed_lp` (creator deposit → LP)                       | shipped (Wave 5C)                                              |
| `mint_lp_for_buy` (per-buy LP-on-buy mint)             | shipped — CPI'd by `sooth_amm::trade_positions`                |
| `redeem_lp` (post-settle LP burn → yield)              | shipped                                                        |
| Per-market `MarketFeePool` (D16)                       | **planned** — lands with `sooth_book` port W2                  |
| Trial-period clock + `isTrialExpiredWithoutGraduation` | shipped                                                        |

## 3. Account / state model

### 3.1 `ProtocolConfig` (singleton)

```rust
// packages/programs-core/programs/sooth_launchpad/src/state/protocol_config.rs
pub struct ProtocolConfig {
    pub authority: Pubkey,           // admin
    pub default_trial_period_secs: i64,
    pub invalidation_buffer_secs: i64,
    // fee split bps: bBase / lpYield / adjudicator / treasury (sum = 10000)
    pub b_base_share_bps: u16,
    pub lp_yield_share_bps: u16,
    pub adjudicator_share_bps: u16,
    pub protocol_share_bps: u16,
    pub graduation_bps: u16,         // graduation threshold
}
```

**Seeds:** `[b"protocol_config"]`. Bootstrapped at protocol init via
`initialize_protocol`. EVM analogue: `LaunchpadEngine` constructor +
`setDefaultTrialPeriod` + `setInvalidationBuffer` + `FeeRouter`
constructor — all collapsed.

### 3.2 `LpPosition` (one per (market, user))

```rust
// packages/programs-core/programs/sooth_launchpad/src/state/lp_position.rs
pub struct LpPosition {
    pub market: Pubkey,
    pub user: Pubkey,
    pub lp_tokens_held: u64,         // mirrors LP ATA balance for fast reads
    // ...
}
```

**Seeds:** `[b"lp_position", market.market_id.as_ref(), user.as_ref()]`.

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

| Ix                    | Args                                                                | Status                                                     | EVM equivalent                 |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `create_market(args)` | `CreateMarketArgs` (question text, creator, deadline, seed deposit) | **stub** — Accounts struct shape committed; body `todo!()` | `LaunchpadEngine.createMarket` |

When implemented, `create_market` will CPI into:

1. `sooth_market::initialize_market`
2. `sooth_market::initialize_outcome_mints`
3. `sooth_market::initialize_market_vaults`
4. `sooth_amm::initialize_amm_state`
5. `sooth_launchpad::seed_lp` (in-program; no CPI)

The four-leg fragmentation is forced by the SBF 4 KB stack frame; one
super-ix bundling all `try_accounts` codegen overflows.

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

| Ix                | Args | Status   | EVM equivalent                  |
| ----------------- | ---- | -------- | ------------------------------- |
| `distribute_fees` | —    | **stub** | `FeeRouter._distributePostGrad` |

When implemented, drains the fee accumulator (currently
`AmmState.fee_b_base_wad`; moving to per-market `MarketFeePool` token
balance per D16) and splits across:

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

Graduation is the canonical `BONDING → LIVE` transition. On Solana it
fires when:

```text
AmmState.fees_accrued_wad >= protocol_config.graduation_bps * baseline / 10000
```

baseline is the creator's seed deposit. The check happens inside
`distribute_fees` (or, planned, inside `fee_router_hook` if fee
distribution becomes a CPI from `sooth_amm::trade_positions`). On
graduation:

- `AmmState.is_graduated = true`
- (planned) `sooth_book::MarketBook` becomes initializable
- LP-on-buy minting stops (per EVM behavior)

Currently the graduation hook is partial — the AMM accumulator increments
but `distribute_fees` is a `todo!()` stub. Implementation lands alongside
the `sooth_book` port (per W5 in `evm-direct-port.md` §11).

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

| Canon rule                                              | Solana status                    |
| ------------------------------------------------------- | -------------------------------- |
| 4-way split (bBase / LP yield / adjudicator / treasury) | planned (`distribute_fees` stub) |
| Pull-based adjudicator / treasury claims                | planned                          |
| LP yield through floor (no separate claim)              | planned                          |
| Pre-grad fee = LP-on-buy mint                           | shipped (`mint_lp_for_buy`)      |

## 8. Capability claim

Per canon `law/capability-matrix.md`:

| Lane                       | Level claim                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Lifecycle                  | `L0` (market creation works once `create_market` lands); `L1` blocked on `distribute_fees` activating graduation |
| Settlement / LP redemption | `S3` (LP floor calc works in `redeem_lp`)                                                                        |
| Fee policy                 | partial — pre-grad LP-on-buy works; post-grad 4-way split is stub                                                |

Self-attested aggregate post-stub-resolution: **`L1 + S3`**.

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
