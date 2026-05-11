# sooth_market — Market Lifecycle + Custody (Solana)

> Status: **shipped (devnet)**; under maintenance.
> Canon law: [`law/lifecycle.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/lifecycle.md),
> [`law/settlement-redemption.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/settlement-redemption.md),
> [`law/atomicity.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/atomicity.md).
> EVM source mirrored: `sooth-alpha/packages/contracts-core/src/TruthMarket.sol` + parts of `OrderEngine.sol` (`_mint`, `_merge`, `settlePosition`).
> Architecture context: [`packages/programs-core/docs/architecture.md`](../../packages/programs-core/docs/architecture.md) §2.2, §4.1, §4.4, §4.5.

---

## 1. What this program does

`sooth_market` owns per-market lifecycle, custody (USDC vault + lock vault),
the YES / NO outcome SPL mints, complete-set mint/merge, settle, redeem,
and trial-period refund paths. It is the EVM `TruthMarket` + the custody
half of `OrderEngine` collapsed into one Solana program (per architecture
§1: Solana program upgrades are native, so the EVM split is unnecessary).

Devnet program id: `ByhA86BqTTrsZBDjSURWjRncojE6p7sxUqcWmHxfdd2n` (D6).

## 2. Status

| Surface                                                            | Status                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| Three-leg `initialize_*` flow                                      | shipped (split for SBF stack budget)                    |
| `mint_complete_set` + `merge_complete_set`                         | shipped                                                 |
| `mint_complete_set_to_program_owned` + `redeem_from_program_owned` | shipped (escrow CPI flows)                              |
| `lock_for_resolution`                                              | shipped — adjudicator-CPI gated                         |
| `settle`                                                           | shipped — adjudicator-CPI gated                         |
| `redeem` (post-settle)                                             | shipped — INVALID half-payout supported                 |
| `claim_refund` (trial-expiry)                                      | shipped                                                 |
| `transfer_to_lock` + `transfer_from_lock_vault`                    | shipped (CPI helpers for `sooth_amm`)                   |
| `AdjudicatorAllowlist` (allowlist mgmt)                            | shipped                                                 |
| `OrderbookPosition` (for orderbook fills)                          | **not yet** — landing in `sooth_book` port W2 (per D15) |

## 3. Account / state model

### 3.1 `MarketLifecycle` enum

```rust
// packages/programs-core/programs/sooth_market/src/state/lifecycle.rs:23
pub enum MarketLifecycle {
    Initializing,  // mints + vault created; transient
    Open,          // EVM LIVE — trading + mint/merge active
    Locked,        // EVM RESOLVING + ATTESTED (collapsed)
    Settled,       // EVM SETTLED — terminal
}
```

Permitted transitions (state machine):

```text
Initializing → Open → Locked → Settled
```

`Settled` is terminal. No `Bonding` / `Live` distinction; Solana uses
`Open` for the whole pre-settle range. See canon mapping in §8 below.

### 3.2 `Market` struct (one per market)

```rust
// packages/programs-core/programs/sooth_market/src/state/market.rs:49
pub struct Market {
    pub market_id: [u8; 16],         // keccak256(question || creator || nonce)[..16]
    pub creator: Pubkey,
    pub adjudicator: Pubkey,         // bound at creation; immutable
    pub question_hash: [u8; 32],     // see sqf.md §4
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,               // USDC ATA owned by vault_authority PDA
    pub lock_vault: Pubkey,          // USDC ATA owned by lock_authority PDA
    pub start_time: i64,
    pub deadline: i64,
    pub lifecycle: MarketLifecycle,
    pub winning_outcome: u8,         // 0=NO, 1=YES, 2=INVALID; valid only when Settled
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub lock_authority_bump: u8,
    pub yes_mint_bump: u8,
    pub no_mint_bump: u8,
}
```

**Seeds:** `[b"market", market_id.as_ref()]`.

### 3.3 `AdjudicatorAllowlist` (singleton)

```rust
// packages/programs-core/programs/sooth_market/src/state/adjudicator_allowlist.rs:61
pub struct AdjudicatorAllowlist {
    pub authority: Pubkey,            // admin
    pub adjudicators: Vec<Pubkey>,    // allowlisted adjudicator program ids
}
```

**Seeds:** `[b"adjudicator_allowlist"]`. Bootstrapped once at protocol
init; managed via `add_adjudicator` / `remove_adjudicator`.

## 4. Instruction surface

### 4.1 Market creation (three legs)

`initialize_market` was split into three ix because Anchor's `try_accounts`
codegen for all three together exceeds the SBF 4 KB stack frame. The legs
must be called in order in a single transaction.

| Ix                         | Purpose                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `initialize_market(args)`  | Creates `Market` PDA at `Initializing`; stores adjudicator binding, question hash, deadline |
| `initialize_outcome_mints` | Creates `yes_mint` + `no_mint` SPL mints (mint authority = `vault_authority` PDA)           |
| `initialize_market_vaults` | Creates `vault` + `lock_vault` ATAs; flips `Initializing → Open`                            |

Called by `sooth_launchpad::create_market` via CPI; the launchpad bundles
all three legs plus `sooth_amm::initialize_amm_state` in one client tx.

### 4.2 Complete-set mint / merge

| Ix                                                | Args       | EVM equivalent                                   |
| ------------------------------------------------- | ---------- | ------------------------------------------------ |
| `mint_complete_set(amount: u64)`                  | base units | `OrderEngine._mint` (`OrderEngine.sol:680-694`)  |
| `mint_complete_set_to_program_owned(amount: u64)` | base units | split-authority variant for CPI flows            |
| `merge_complete_set(amount: u64)`                 | base units | `OrderEngine._merge` (`OrderEngine.sol:696-712`) |

`mint`: pulls `amount` USDC from user → market vault; mints `amount` YES

- `amount` NO into user's outcome ATAs.

`merge`: burns `amount` YES + `amount` NO; transfers `amount` USDC from
market vault → user.

Both gated on `lifecycle == Open`.

### 4.3 Lifecycle transitions (adjudicator-CPI gated)

| Ix                            | Caller                                          | Transition                                   |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `lock_for_resolution`         | `sooth_adjudicator` via parent-ix introspection | `Open → Locked`                              |
| `settle(winning_outcome: u8)` | `sooth_adjudicator` via parent-ix introspection | `Locked → Settled`; writes `winning_outcome` |

Both ix run `verify_market_authority(parent_ix, market.adjudicator)`. A
non-adjudicator caller is rejected. The introspection helper lives in
`instructions/instruction_introspection.rs` (the same file used by the
`sooth_book` filler-only ix gate).

### 4.4 Redemption

| Ix                                                 | Args                            | EVM equivalent                                           | Notes                                                                                               |
| -------------------------------------------------- | ------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `redeem`                                           | (none — uses user ATA balances) | `OrderEngine.settlePosition` (`OrderEngine.sol:399-431`) | Branches on `winning_outcome`: 1.0 USDC per winning share, 0 per losing, 0.5 per share on `INVALID` |
| `redeem_from_program_owned(amount_yes, amount_no)` | base units each                 | split-destination variant                                | for CPI escrow flows                                                                                |

Gated on `lifecycle == Settled`.

### 4.5 Trial-expiry refund

| Ix             | Purpose                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `claim_refund` | Returns AMM trial-period collateral to user; then CPIs `sooth_amm::close_dismissed_position` to clean up the AMM Position |

`claim_refund` is the trial-expiry analog of redemption. Called after
`sooth_amm::dismiss_market` flips the AMM to `dismissed`. The body uses
parent-ix introspection to bind the `sooth_amm` cleanup CPI.

### 4.6 PDA-signed transfer helpers

| Ix                                 | Direction                | Caller                      |
| ---------------------------------- | ------------------------ | --------------------------- |
| `transfer_to_lock(amount)`         | `vault → lock_vault`     | `sooth_amm::sell_positions` |
| `transfer_from_lock_vault(amount)` | `lock_vault → recipient` | `sooth_amm::claim_unlocked` |

These exist because Solana PDA signing requires the signing PDA to be
owned by the correct program. The `vault_authority` and `lock_authority`
PDAs are owned by `sooth_market`; `sooth_amm` CPIs into these helpers to
move USDC under the correct authority. Both helpers are gated by
parent-ix introspection against the `sooth_amm` program id.

### 4.7 Allowlist management

| Ix                                        | Args                   | Caller                    |
| ----------------------------------------- | ---------------------- | ------------------------- |
| `initialize_adjudicator_allowlist`        | —                      | bootstrap (protocol init) |
| `add_adjudicator(adjudicator: Pubkey)`    | adjudicator program id | allowlist authority       |
| `remove_adjudicator(adjudicator: Pubkey)` | adjudicator program id | allowlist authority       |

Drives `sooth_launchpad::create_market`'s gate on which adjudicator a
new market may bind.

## 5. Cross-program wiring

| Caller                              | Callee                                                                                                                       | Mechanism                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `sooth_launchpad::create_market`    | `initialize_market` + `initialize_outcome_mints` + `initialize_market_vaults`                                                | CPI bundle                                                     |
| `sooth_adjudicator::attest_outcome` | `lock_for_resolution` + `settle`                                                                                             | parent-ix introspection                                        |
| `sooth_amm::sell_positions`         | `transfer_to_lock`                                                                                                           | parent-ix introspection                                        |
| `sooth_amm::claim_unlocked`         | `transfer_from_lock_vault`                                                                                                   | parent-ix introspection                                        |
| `sooth_market::claim_refund`        | `sooth_amm::close_dismissed_position`                                                                                        | parent-ix introspection (reverse)                              |
| `sooth_book` (planned)              | `fill_order`, `deposit_for_order`, `withdraw_for_order`, `credit_shares_for_order`, `debit_shares_for_order_before_deadline` | new filler-only ix per [`sooth_book.md`](./sooth_book.md) §4.2 |

## 6. Canon lifecycle mapping

Canon `law/lifecycle.md` defines six states:
`BONDING / LIVE / TRIAL_EXPIRED / RESOLVING / ATTESTED / SETTLED`. Solana
collapses these into four:

| Canon state     | Solana mapping                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BONDING`       | `Open` (with `sooth_launchpad::AmmState.is_graduated == false`)                                                                                                                    |
| `LIVE`          | `Open` (with `is_graduated == true`)                                                                                                                                               |
| `TRIAL_EXPIRED` | not an explicit state; surfaced via `sooth_amm::dismiss_market` flipping the AMM and `lifecycle` staying at `Open` until adjudicator settles as `INVALID` (or `claim_refund` path) |
| `RESOLVING`     | `Locked`                                                                                                                                                                           |
| `ATTESTED`      | `Locked` (collapsed with `RESOLVING` per architecture §4.4 — Solana adjudicator does not split these phases)                                                                       |
| `SETTLED`       | `Settled`                                                                                                                                                                          |

The collapse is a **deviation from canon**. Severity:
`partial-conformance`. Justification: Solana adjudicator pattern (D5)
attests + settles in one transaction; canon's two-phase split was added
in canon law/adjudicator.md after the Solana implementation shipped.

Deviation should be filed in `host-kb/solana/deviations.json` once that
file exists. Remediation: `track-for-future-canon-change` — canon may
allow hosts to collapse `RESOLVING + ATTESTED` when their adjudicator
does not need a veto window.

## 7. Settlement payout rules

Per canon `law/settlement-redemption.md`:

```text
winning_outcome = YES (1)   → payout = yes_position_atoms
winning_outcome = NO  (0)   → payout = no_position_atoms
winning_outcome = INVALID(2)→ payout = floor((yes + no) / 2)
```

Solana implementation matches per `instructions/redeem.rs` (branches on
`market.winning_outcome`). Rounding direction: floor for all three
branches per canon. Rounding residue stays in the market vault.

Three-outcome (`MAYBE`) payout is canon-defined but Solana programs are
binary-only; the third-payout case is structurally unreachable and
unimplemented. Self-attested settlement level: **`S4`** for binary
markets only; `S4` for three-outcome blocked by AMM binary-only design.

## 8. Capability claim

Per canon `law/capability-matrix.md`:

| Lane        | Level claim                                                                             |
| ----------- | --------------------------------------------------------------------------------------- |
| Lifecycle   | `L3` (resolve → attest → settle works) with deviation: `RESOLVING + ATTESTED` collapsed |
| Settlement  | `S4` for binary markets; INVALID half-payout works                                      |
| Adjudicator | gated on `sooth_adjudicator` (see [`sooth_adjudicator.md`](./sooth_adjudicator.md))     |

Self-attested aggregate post-verification: **`L3 / S4`**.

## 9. Forbidden shortcuts

- Do **not** bypass the three-leg initialization order. Each ix expects the
  prior leg to have flipped state.
- Do **not** allow non-adjudicator callers to `lock_for_resolution` or
  `settle`. The parent-ix introspection gate is the only auth path; relaxing
  it breaks the security model.
- Do **not** convert `winning_outcome = 2` (`INVALID`) into a generic
  error. Canon requires `INVALID` to flow through the same redeem path
  with the half-payout rule.
- Do **not** push payouts. `redeem` is pull-based per canon (caller
  redeems their own position).
- Do **not** allow `Market.adjudicator` to mutate after `initialize_market`.
  Immutability is load-bearing for the audit story.

## 10. Out of scope

- `OrderbookPosition` PDA — coming in W2 of the `sooth_book` port per D15.
- Three-outcome (`MAYBE`) support — blocked by `sooth_amm` binary-only design.
- `RESOLVING / ATTESTED` phase split — deviation; canon-side change needed.
- T\* retroactive settlement root storage — adjudicator J4; deferred.
- Permissionless `invalidate()` after `deadline + invalidation_buffer` — gap
  exists today per `lifecycle.rs:15-18`; per `evm-direct-port.md` §15 the
  fix is recommended to land in the same audit window as the `sooth_book`
  port.

## 11. Cross-references

- Architecture: `packages/programs-core/docs/architecture.md` §2.2, §4.1, §4.4, §4.5
- Decision-log: D5 (escrow atomicity), D6 (devnet ids), D15 (position-model split)
- Sibling specs: [`sooth_amm.md`](./sooth_amm.md), [`sooth_launchpad.md`](./sooth_launchpad.md),
  [`sooth_adjudicator.md`](./sooth_adjudicator.md), [`sooth_book.md`](./sooth_book.md), [`sqf.md`](./sqf.md)
