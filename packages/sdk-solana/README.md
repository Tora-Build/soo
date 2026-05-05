# @sooth/sdk-solana

> Solana adapter for `@sooth/sdk` — workspace member of the `sooth-solana` monorepo.
> Published to npm as `@sooth/sdk-solana`. Loaded dynamically by `@sooth/sdk` (in `sooth-alpha`) when the active node is a Solana node.
> Status: spec only, no implementation yet.

## What this is

`@sooth/sdk-solana` is the Solana-side adapter implementation of the chain-agnostic `ChainAdapter` interface defined in `@sooth/sdk`. Together they let app code (frontends, bots, aggregators) write one integration that runs unchanged against EVM or Solana Sooth deployments.

The single-line guarantee:

> **Code written against `@sooth/sdk` runs unchanged on EVM and Solana Sooth deployments. The chain is a runtime property of the active node, not a compile-time choice.**

External developers (frontend builders, bot operators, market aggregators, portfolio trackers) write their integration once. The SDK's internal `evm/` and `solana/` adapter implementations route to the right backend based on the active node's `chainKind` field from the registry. Adapter code is invisible to integrators.

## Two-document structure

This product's spec is split by audience:

| Doc                                                              | Audience                                               | Question it answers                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| [`docs/integrator-contract.md`](./docs/integrator-contract.md)   | **External developers** building on `@sooth/sdk`       | "What can I rely on staying the same across EVM and Solana?" |
| [`docs/implementation-guide.md`](./docs/implementation-guide.md) | **Sooth SDK contributors** building the chain adapters | "How do we implement that contract underneath?"              |

The integrator contract is **canonical** — it freezes the public API. The implementation guide explains _how_ the contract is honored under the hood. If they ever conflict, the integrator contract wins.

## Status

**Design spec only.** No code, no adapter implementations.

Implementation is gated by:

1. The `sooth-core-solana` design landing on a final orderbook strategy (custom build vs Monaco fork)
2. A 1-week LMSR + matcher CU spike succeeding (Solana programs are feasible at all)
3. Phase A refactor of existing `@sooth/sdk` to extract the `ChainAdapter` interface (no Solana code needed; pure cleanup)

See [`docs/implementation-guide.md §8`](./docs/implementation-guide.md) for the two-phase migration plan.

## Layout

```
packages/sdk-solana/                # workspace member of sooth-solana monorepo
├── README.md                       # this file
├── docs/
│   ├── integrator-contract.md      # third-party-facing frozen surface (CANONICAL)
│   └── implementation-guide.md     # SDK-author implementation guide
└── (future)
    ├── package.json                # name: "@sooth/sdk-solana"
    ├── tsconfig.json
    └── src/
        ├── adapter.ts              # implements ChainAdapter from @sooth/sdk
        ├── client.ts               # Anchor program client factory
        ├── orderbook.ts            # client-driven matcher integration
        ├── idls/                   # consumed from ../programs-core/target/idl/
        ├── matcher-wasm/           # built from ../programs-core/crates/sooth-book-matcher/
        └── tx-builder/             # ALT mgmt, retry-on-race
```

Note: the chain-agnostic `core/` code (`ChainAdapter` interface, types, hooks, math, errors taxonomy) lives in **`@sooth/sdk`** (in `sooth-alpha/packages/sdk`), not in this package. `@sooth/sdk-solana` only ships the Solana adapter implementation; integrators install both packages, and `@sooth/sdk` dynamically imports the adapter when the active node is Solana. See [`docs/implementation-guide.md §7`](./docs/implementation-guide.md) for the full proposed layout.

## Companions

- [`../programs-core/`](../programs-core/) — Solana programs whose IDLs this SDK consumes
- [`../../docs/research/orderbook-survey.md`](../../docs/research/orderbook-survey.md) — orderbook research that informed the integrator contract's escrow-atomicity invariant
- [`../../docs/decision-log.md`](../../docs/decision-log.md) — resolved decisions, including which contract symbols are frozen

## Reading order

**For external integrators:**

1. [`docs/integrator-contract.md §1-3`](./docs/integrator-contract.md) — single-line guarantee, three categories of difference, complete symbol inventory
2. [`docs/integrator-contract.md §4`](./docs/integrator-contract.md) — 8-point checklist for verifying SDK-compat in your code
3. [`docs/integrator-contract.md §8`](./docs/integrator-contract.md) — three reference snippets (byte-identical across chains)
4. [`docs/integrator-contract.md §5-6`](./docs/integrator-contract.md) — honest constraints (what's NOT abstracted) and borderline behaviors

**For SDK contributors:**

1. [`docs/integrator-contract.md`](./docs/integrator-contract.md) — read in full first; this is the spec you implement against
2. [`docs/implementation-guide.md §1-2`](./docs/implementation-guide.md) — the `ChainAdapter` interface
3. [`docs/implementation-guide.md §3`](./docs/implementation-guide.md) — module-by-module inventory of what's reusable vs what needs Solana siblings
4. [`docs/implementation-guide.md §7-8`](./docs/implementation-guide.md) — proposed package layout and migration plan
5. [`docs/implementation-guide.md §10`](./docs/implementation-guide.md) — risk register
