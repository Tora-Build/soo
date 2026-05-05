# Sooth on Solana — Spec Suite

> Status: design specs only. No code committed.
> Layout: monorepo for now; each top-level product is a candidate for extraction into its own repo later.
> Updated: 2026-05-05.

This directory holds the design specification for bringing Sooth Protocol to Solana. It is organized as a **two-product spec suite** that mirrors the EVM stack:

| Product                                                | Mirrors (EVM)              | What it covers                                                                                             |
| ------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`packages/programs-core/`](./packages/programs-core/) | `packages/contracts-core/` | Solana programs (Anchor), account model, instructions, orderbook design, CU budgets, adjudicator framework |
| [`packages/sdk-solana/`](./packages/sdk-solana/)       | `packages/sdk/`            | Cross-chain SDK contract, chain adapter interface, package layout, migration plan, integrator-facing API   |

Plus shared, cross-cutting materials:

| Directory          | Purpose                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| [`docs/`](./docs/) | Decision log, glossary, and external research (orderbook survey, Monaco analysis) used by both tracks |

---

## Where to start

**If you're an external developer** building on Sooth Solana → read [`packages/sdk-solana/docs/integrator-contract.md`](./packages/sdk-solana/docs/integrator-contract.md). It freezes the public API surface across EVM and Solana so your code runs unchanged on both.

**If you're a Sooth contributor** picking up Solana work → read [`README` for each product](#product-readmes) below, then the architecture spec for whichever side you're working on.

**If you're a founder / decision-maker** evaluating direction → read [`docs/decision-log.md`](./docs/decision-log.md) for resolved questions and [`docs/research/`](./docs/research/) for the external survey that informed them.

---

## Product READMEs

- [`packages/programs-core/README.md`](./packages/programs-core/README.md)
- [`packages/sdk-solana/README.md`](./packages/sdk-solana/README.md)
- [`docs/`](./docs/)

---

## Reading order

For a complete walkthrough (all artifacts, in dependency order):

1. [`docs/research/porting-evaluation.md`](./docs/research/porting-evaluation.md) — code-first evaluation of Sooth's current EVM stack and what porting actually means
2. [`docs/research/orderbook-survey.md`](./docs/research/orderbook-survey.md) — survey of production Solana orderbooks (Monaco, Phoenix, OpenBook, Drift, Manifest, etc.)
3. [`docs/monaco-fork-analysis.md`](./docs/monaco-fork-analysis.md) — deep dive on Monaco Protocol as a candidate fork base, including the 60-cap finding
4. [`packages/programs-core/docs/architecture.md`](./packages/programs-core/docs/architecture.md) — Solana program design (5 programs, account model, call chains, CU budgets)
5. [`packages/sdk-solana/docs/integrator-contract.md`](./packages/sdk-solana/docs/integrator-contract.md) — third-party-facing frozen API surface
6. [`packages/sdk-solana/docs/implementation-guide.md`](./packages/sdk-solana/docs/implementation-guide.md) — SDK-author implementation guide (chain adapter, package layout, migration plan)
7. [`docs/decision-log.md`](./docs/decision-log.md) — running record of resolved decisions and gates
8. [`docs/glossary.md`](./docs/glossary.md) — terms used across both tracks

---

## Status

All artifacts are **design specs**. Nothing has been built. The current decision gates blocking implementation are recorded in [`docs/decision-log.md`](./docs/decision-log.md).

Implementation is gated by a 1-week LMSR + matcher CU spike (see `programs-core/docs/architecture.md §13`), plus three founder-level decisions tracked in the decision log.

---

## Why this layout

This directory is the **init structure for a future `Tora-Build/sooth-solana` monorepo**. When extracted, it becomes a standalone repo with two workspace packages — Solana programs (Rust/Anchor) and the Solana SDK adapter (TypeScript) — sharing one decision log, one glossary, one CI pipeline, and one release process.

```
sooth-solana/                    # future repo root
├── README.md
├── docs/                        # cross-cutting (decision log, glossary, research)
└── packages/
    ├── programs-core/           # Anchor programs (Rust)
    │   ├── README.md
    │   ├── docs/                # design specs (current state)
    │   └── (future: programs/, Cargo.toml, Anchor.toml, tests/)
    └── sdk-solana/              # @sooth/sdk-solana TypeScript adapter
        ├── README.md
        ├── docs/                # design specs (current state)
        └── (future: src/, package.json, tsconfig.json)
```

This shape mirrors `sooth-alpha`'s monorepo (multiple related packages under `packages/`) so contributors who know the EVM stack don't have to learn a different topology to work on Solana.

The link to `sooth-alpha` is **only the published npm package** (`@sooth/sdk-solana`), loaded by the umbrella `@sooth/sdk` via dynamic import when the active node is Solana. No git submodules, no shared workspace. EVM-only consumers don't pay any Solana bundle cost.
