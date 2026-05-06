# programs-core

> Anchor programs for Sooth Protocol on Solana — workspace member of the `sooth-solana` monorepo.
> Analogous to `packages/contracts-core` in the EVM monorepo (`sooth-alpha`).
> Status: `sooth_amm` scaffolded; remaining four programs are spec only. See "Status" below.

## What this is

`programs-core` is the Solana counterpart to Sooth's EVM core contracts. Where the EVM stack ships 8 Solidity contracts (`LaunchpadEngine`, `AMMEngine`, `SoothBook`, `OrderEngine`, `TruthMarket`, `FeeRouter`, `AdjudicatorRegistry`, `BaseToken`), the Solana stack will ship 5 Anchor programs:

| Program             | EVM Equivalent                                      | Purpose                                                                                              |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sooth_launchpad`   | `LaunchpadEngine`                                   | Market factory, creator deposits, LP tokens, trial period, fee distribution (inlined from FeeRouter) |
| `sooth_amm`         | `AMMEngine`                                         | LMSR math, position storage, lock-on-sell                                                            |
| `sooth_market`      | `OrderEngine` + `TruthMarket`                       | Market lifecycle + custody + mint/merge/redeem                                                       |
| `sooth_book`        | `SoothBook`                                         | On-chain orderbook (custom build OR Monaco fork — see `spec/architecture.md §6`)                     |
| `sooth_adjudicator` | `AdjudicatorRegistry` + adjudicator implementations | Resolver framework + per-type adjudicator programs (Manual, ZkTLS, etc.)                             |

See [`docs/architecture.md`](./docs/architecture.md) for the full mapping.

## Status

**Implementation in progress.** First Anchor program (`sooth_amm`) scaffolded; the rest are still spec.

### Programs

| Program             | Status                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sooth_amm`         | **Scaffolded.** LMSR math wired in (D4 ported from `_spikes/lmsr-cu/`); state mutation real; CPIs / fee router / LP mint / lock-on-sell stubbed with `todo!()`. See `programs/sooth_amm/src/instructions/trade_positions.rs` for the TODO list. |
| `sooth_launchpad`   | Spec only. Will own fee router, LP mint, market factory.                                                                                                                                                                                        |
| `sooth_market`      | Spec only. Will own market PDA, vault, lifecycle, redemption.                                                                                                                                                                                   |
| `sooth_book`        | Spec only. Gated on P1 (Monaco fork vs custom build).                                                                                                                                                                                           |
| `sooth_adjudicator` | Spec only. Manual variant first; ZkTLS later.                                                                                                                                                                                                   |

### Toolchain

- **Anchor 0.30.1** (latest 0.30.x). The `init-if-needed` feature is enabled for the `Position` PDA pattern in `trade_positions`.
- **Solana CLI 3.0.13 / platform-tools v1.51** (matches the spike). `cargo build-sbf` ships cargo 1.84.0, which rejects `edition2024`-tainted transitive deps. The same pins as the spike apply — already encoded in the workspace `Cargo.lock`:
  ```bash
  cargo update -p constant_time_eq --precise 0.4.2  # (auto-pinned via blake3 1.5.5)
  cargo update -p blake3 --precise 1.5.5
  cargo update -p proc-macro-crate@3.5.0 --precise 3.2.0
  cargo update -p indexmap@2.14.0 --precise 2.6.0
  cargo update -p hashbrown@0.17.0 --precise 0.15.2
  cargo update -p unicode-segmentation --precise 1.12.0
  ```
  If a future `cargo update` reintroduces edition2024 errors, replay the equivalent set.

### Build commands

```bash
cargo check --workspace                                                          # green
cargo test -p sooth_amm                                                          # 24 unit tests, all green (15 inline + 9 integration)
cargo build-sbf --manifest-path packages/programs-core/programs/sooth_amm/Cargo.toml   # produces target/deploy/sooth_amm.so
```

`anchor build` is deferred until the Anchor.toml at `packages/programs-core/Anchor.toml` is exercised against a real keypair (currently uses a placeholder program ID — replace via `solana-keygen new -o target/deploy/sooth_amm-keypair.json` and update `declare_id!` + `Anchor.toml`).

## Layout

```
packages/programs-core/
├── README.md                  # this file
├── Anchor.toml                # workspace = ["programs/sooth_amm"], placeholder program ID
├── docs/
│   └── architecture.md        # complete program design (5 programs, account model, call chains, CU budgets)
└── programs/
    └── sooth_amm/             # SCAFFOLDED — LMSR math + trade_positions
        ├── Cargo.toml
        ├── src/
        │   ├── lib.rs
        │   ├── error.rs
        │   ├── events.rs
        │   ├── math/          # wad.rs + lmsr.rs (ported from _spikes/lmsr-cu)
        │   ├── state/         # market, amm_state, position, lock_entry
        │   └── instructions/  # trade_positions
        └── tests/
            └── lmsr_unit.rs   # host-side math tests

# Future workspace members (uncomment in root Cargo.toml as they land):
#   programs/sooth_launchpad
#   programs/sooth_market
#   programs/sooth_book
#   programs/sooth_adjudicator
#   crates/sooth-book-matcher
```

## Companions

- [`../sdk-solana/`](../sdk-solana/) — TypeScript SDK that consumes the IDLs from this product's `target/idl/`
- [`../../docs/research/`](../../docs/research/) — external research (orderbook survey, Monaco analysis) that informed the design
- [`../../docs/decision-log.md`](../../docs/decision-log.md) — running record of resolved decisions

## Reading order

1. [`docs/architecture.md §0`](./docs/architecture.md) — TL;DR and hardest unknowns
2. [`docs/architecture.md §1-4`](./docs/architecture.md) — program layout, account model, type mapping, call-chain translation
3. [`docs/architecture.md §5`](./docs/architecture.md) — AMM CU budget deep-dive (the load-bearing technical question)
4. [`docs/architecture.md §6`](./docs/architecture.md) — orderbook decision (build vs Monaco vs Phoenix), cross-references the orderbook research
5. [`docs/architecture.md §7-12`](./docs/architecture.md) — adjudicator, fees, trial period, frontend mapping, repo layout, open questions
6. [`docs/architecture.md §13`](./docs/architecture.md) — recommended next steps (the spike)
