# programs-core

> Anchor programs for Sooth Protocol on Solana — workspace member of the `sooth-solana` monorepo.
> Analogous to `packages/contracts-core` in the EVM monorepo (`sooth-alpha`).
> Status: spec only, no implementation yet.

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

**Design spec only.** No Rust code, no Anchor programs, no deployments. Implementation is gated by:

1. 1-week LMSR + matcher CU spike (validate `sooth_amm::trade_positions` runs within Solana's CU budget)
2. Founder-level decision on orderbook strategy (custom build, Monaco fork, or Phoenix integration — see [`../../docs/decision-log.md`](../../docs/decision-log.md))
3. Founder-level decision on whether escrow atomicity is load-bearing (gates orderbook strategy)

## Layout

```
packages/programs-core/        # workspace member of sooth-solana monorepo
├── README.md                  # this file
├── docs/
│   └── architecture.md        # complete program design (5 programs, account model, call chains, CU budgets)
└── (future)
    ├── Anchor.toml
    ├── Cargo.toml             # member of root Cargo workspace
    ├── programs/
    │   ├── sooth_launchpad/
    │   ├── sooth_amm/
    │   ├── sooth_market/
    │   ├── sooth_book/
    │   └── sooth_adjudicator/
    ├── crates/
    │   └── sooth-book-matcher/  # shared Rust matcher (BPF + wasm targets)
    ├── tests/
    └── target/idl/            # IDLs consumed by ../sdk-solana
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
