# sooth_adjudicator — Resolver / Attest / Dispute (Solana)

> Status: **partial (devnet)** — manual variant shipped; zkTLS and other
> production variants deferred.
> Canon law: [`law/adjudicator.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/adjudicator.md).
> EVM source mirrored: `sooth-alpha/packages/contracts-core/src/IAdjudicator.sol` + `AdjudicatorBase.sol` + `AdjudicatorRegistry.sol` + `adjudicators/ManualAdjudicator.sol`.
> Architecture context: [`packages/programs-core/docs/architecture.md`](../../packages/programs-core/docs/architecture.md) §7.

---

## 1. What this program does

`sooth_adjudicator` owns the outcome-resolution path for a market:
register an adjudicator variant for a market, lock the market for
resolution, attest the resolved outcome, and optionally dispute (override)
that outcome before settle. It is the only role that can drive a market
from `Open → Locked → Settled` via the normal path; the trial-expiry path
runs separately through `sooth_amm::dismiss_market` + `sooth_market::claim_refund`.

Per architecture §7 + decision-log D7/D5, v1 ships the `Manual` variant
(trusted authority signs); `ZkTLS` and other production variants are
deferred until Solana zkTLS tooling matures.

Devnet program id: `4fifRPBFebS12impdMvQGKZ9WZ96GgUunrw6iEx3KKV8` (D6).

## 2. Status

| Surface                                                                      | Status                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `register_adjudicator`                                                       | shipped                                          |
| `request_lock` (Open → Locked CPI)                                           | shipped                                          |
| `attest_outcome` (manual variant)                                            | shipped                                          |
| `dispute` (override before settle)                                           | shipped — no time window in v1                   |
| `AdjudicatorKind::Manual`                                                    | shipped                                          |
| `AdjudicatorKind::ZkTLS`                                                     | not implemented — variant tag reserved           |
| `AdjudicatorKind::Other(_)`                                                  | reserved for future variants                     |
| T\* retroactive settlement (`post_settlement_root`)                          | not implemented                                  |
| Guardian protocol (veto window)                                              | not implemented in v1; `dispute` is the analogue |
| Six-phase machine (IDLE / ACTIVE / RESOLVED / ATTESTED / SETTLED / DISPUTED) | partial — Solana collapses RESOLVED + ATTESTED   |

## 3. Account / state model

### 3.1 `AdjudicatorKind`

```rust
// packages/programs-core/programs/sooth_adjudicator/src/state/adjudicator.rs:46
pub enum AdjudicatorKind {
    Manual,
    ZkTLS,
    Other(u8),
}
```

Tag bytes: Manual=0, ZkTLS=1, Other(n)=2. Canon `law/adjudicator.md` type
id namespace is canon-owned. Solana's `Manual` maps to canon `"manual"`;
`ZkTLS` maps to canon `"zk-oracle"`. The `Other(u8)` variant is a Solana-
specific extension point — extending it for production requires a canon
edit to register a new type id.

### 3.2 `Adjudicator` PDA (one per market)

```rust
// packages/programs-core/programs/sooth_adjudicator/src/state/adjudicator.rs:77
pub struct Adjudicator {
    pub market: Pubkey,           // bound at register; immutable
    pub authority: Pubkey,        // signer for attest / dispute (Manual variant)
    pub kind: AdjudicatorKind,
    pub locked_at: i64,           // unix seconds; 0 if not yet locked
    pub attested_outcome: u8,     // 0=NO, 1=YES, 2=INVALID
    pub bump: u8,
    // ... type-specific fields per kind
}
```

**Seeds:** `[b"adjudicator", market.market_id.as_ref()]`.

## 4. Instruction surface

| Ix                     | Args                                         | EVM equivalent                                                        | Notes                                                                                |
| ---------------------- | -------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `register_adjudicator` | `authority: Pubkey`, `kind: AdjudicatorKind` | `AdjudicatorRegistry.register` + per-type `configureMarket` collapsed | v1 accepts `market.creator` as registrar; production would gate on protocol multisig |
| `request_lock`         | (none)                                       | `TruthMarket.resolve` (initial half)                                  | CPIs `sooth_market::lock_for_resolution` (parent-ix gated)                           |
| `attest_outcome`       | `winning_outcome: u8`                        | `TruthMarket.attest` + `TruthMarket.settle` (collapsed)               | Manual variant only; signed by `adjudicator.authority`                               |
| `dispute`              | `new_outcome: u8`                            | `AdjudicatorBase.dispute` + re-resolve                                | Overrides attested outcome before settle; no time window in v1                       |

### 4.1 `register_adjudicator`

Creates the per-market `Adjudicator` PDA. Binds the variant tag, the
authority pubkey, and the market. Canon-spec: must be called during
market creation; `sooth_launchpad::create_market` will CPI here once that
stub lands. Currently called as a separate client-side ix.

### 4.2 `request_lock`

Adjudicator authority signs to begin resolution. The body CPIs into
`sooth_market::lock_for_resolution`. The destination ix's parent-ix
introspection requires the calling program to be `sooth_adjudicator`;
any other caller is rejected with `InvalidParentInstruction`.

Mutates: `Adjudicator.locked_at = now()`.

### 4.3 `attest_outcome`

Manual variant: `authority` signs to attest the outcome. Mutates the
`Adjudicator` state then CPIs into `sooth_market::settle` which drives
`Locked → Settled`. Atomic — both the adjudicator state change and the
market lifecycle change land in one tx.

Per architecture §4.4, this is the **EVM `attest` + `settle` collapse**.
Canon defines two phases (`RESOLVED → ATTESTED → SETTLED`); Solana
collapses RESOLVED + ATTESTED into a single tx with no veto window. See §6
(deviation) below.

### 4.4 `dispute`

The `dispute_authority` (currently the same as `authority` in v1)
overrides the attested outcome — sets to `INVALID`, or to a different
valid value. Like `attest_outcome`, it CPIs into `sooth_market::settle`
to drive `Locked → Settled` with the new outcome.

**v1 does NOT enforce a time window.** Canon's veto window (open while
the market is `ATTESTED`, closed at `now() + veto_period`) is not yet
enforced. `dispute` is callable any time the market is `Locked` (i.e.
before settle has run). After settle, the standard
`MARKET_ALREADY_SETTLED` defense-in-depth guard rejects the call.

`sooth_market::settle`'s parent-ix introspection accepts both
`attest_outcome` AND `dispute` as legitimate parents (whitelist of two
discriminators). Any other parent ix is rejected.

## 5. Cross-program wiring

| Caller                                     | Callee                                    | Mechanism                                                                |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------ |
| `sooth_adjudicator::request_lock`          | `sooth_market::lock_for_resolution`       | CPI; parent-ix introspection on destination                              |
| `sooth_adjudicator::attest_outcome`        | `sooth_market::settle`                    | CPI; parent-ix introspection (whitelist: `attest_outcome` discriminator) |
| `sooth_adjudicator::dispute`               | `sooth_market::settle`                    | CPI; parent-ix introspection (whitelist: `dispute` discriminator)        |
| `sooth_launchpad::create_market` (planned) | `sooth_adjudicator::register_adjudicator` | CPI; current code calls it client-side                                   |

## 6. Canon mapping

Canon `law/adjudicator.md` defines a six-phase adjudicator machine and a
veto/dispute window. Solana's v1 is a deliberate simplification.

| Canon phase | Solana equivalent                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `IDLE`      | not yet registered (no `Adjudicator` PDA exists)                                                                |
| `ACTIVE`    | registered, not yet locked (`locked_at == 0`)                                                                   |
| `RESOLVED`  | (collapsed with `ATTESTED`)                                                                                     |
| `ATTESTED`  | `Adjudicator.attested_outcome != 0` AND market still `Locked` (very short window — typically same tx as settle) |
| `SETTLED`   | `Market.lifecycle == Settled`                                                                                   |
| `DISPUTED`  | (none — `dispute` re-overrides and settles in the same tx)                                                      |

| Canon lifecycle call   | Solana ix                                                      |
| ---------------------- | -------------------------------------------------------------- |
| `configure_market`     | `register_adjudicator`                                         |
| `resolve`              | (collapsed into `attest_outcome` — no separate `resolve` step) |
| `attest`               | (collapsed)                                                    |
| `settle`               | implicit in `attest_outcome` (CPI to `sooth_market::settle`)   |
| `dispute`              | `dispute` (no veto window in v1)                               |
| `post_settlement_root` | not implemented                                                |

This is a **`partial-conformance` deviation**. Severity rationale: the
collapsed machine works for `Manual` adjudicators (the only variant
shipped) where there is no off-host attestation step. It will NOT work
for `zk-oracle` or `uma` variants that need a separate verifiable
attestation phase. Self-attested level: **`J1`** (Manual variant only).

Deviation should be filed in `host-kb/solana/deviations.json` once that
file exists. Remediation plan: when `ZkTLS` lands, the phase split
(separate `resolve` and `attest` ix with veto window) becomes mandatory.
That work splits `attest_outcome` and adds an explicit time-gated
veto window matching canon `veto_ends_at`.

## 7. Capability claim

Per canon `law/capability-matrix.md` adjudicator ladder:

| Level | Description                                                            | Solana status                                                      |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| J0    | `IAdjudicator` interface implemented for at least one type id          | met                                                                |
| J1    | configure → resolve → settle works for `manual`                        | met (collapsed but functional)                                     |
| J2    | Attestation step works (zk-rule callback / zk-oracle proof / uma bond) | not met                                                            |
| J3    | Guardian protocol (dispute returns market to LIVE within veto window)  | partial — `dispute` exists but settles directly, no return to LIVE |
| J4    | T\* retroactive settlement + `post_settlement_root`                    | not met                                                            |
| J5    | Multiple variants bound across markets in one instance                 | partial — type-id field exists but only Manual ships               |

Self-attested level: **`J1`** (Manual variant only). Canon's `J3` (return
to LIVE on dispute) is structurally different from Solana's `dispute`
(re-settle with a different outcome); these are different design
choices, not a level-ladder mismatch — flag as deviation.

## 8. Forbidden shortcuts

- Do **not** allow `attest_outcome` or `dispute` to be called by anyone
  except `Adjudicator.authority`. The signature check is the security
  boundary.
- Do **not** mutate `Adjudicator.market` after `register_adjudicator`.
  The market binding is immutable per the audit story.
- Do **not** bypass the parent-ix introspection check on
  `sooth_market::lock_for_resolution` / `settle`. The introspection is
  what enforces "only this adjudicator program can drive lifecycle."
- Do **not** add new `AdjudicatorKind` variants without a canon edit
  registering the corresponding type id. The type-id namespace is
  canon-owned.

## 9. Out of scope

- ZkTLS variant — deferred per D7; Primus has no first-class Solana
  support yet.
- Other production variants (`uma`, `agent`, `id-committee`,
  `optimistic`) — none implemented; each requires a canon type-id mapping
  - a new ix surface.
- Guardian protocol with formal veto window — v1 `dispute` is the
  simplification.
- T\* retroactive settlement (`post_settlement_root`) — canon J4;
  deferred alongside the Solana T\* path.
- Multi-source attestation aggregation (multi-sig) — handled at the
  authority level today (single signer); committee variants are deferred.

## 10. Cross-references

- Architecture: `packages/programs-core/docs/architecture.md` §7
- Decision-log: D5 (escrow atomicity), D6 (devnet ids), D7 (Monaco fork —
  superseded by D13)
- Canon: [`law/adjudicator.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/adjudicator.md)
- Sibling specs: [`sooth_market.md`](./sooth_market.md), [`sooth_launchpad.md`](./sooth_launchpad.md),
  [`sooth_amm.md`](./sooth_amm.md), [`sooth_book.md`](./sooth_book.md)
