# Sooth on Solana

> Solana implementation of the [Sooth Protocol](https://github.com/Tora-Build/sooth-alpha) — prediction markets with LMSR AMM, complete-set mint/merge/redeem, lifecycle adjudication, and a launchpad gating new market creation.
>
> **Status: 4/5 production programs FULLY implemented + SDK adapter wired end-to-end + demo dapp running against real Phantom on localnet.** See [`docs/status.md`](./docs/status.md) for the full state table.

This repo is the Solana-side companion to `Tora-Build/sooth-alpha` (EVM home). It houses three layers under one workspace:

| Layer                                                  | Mirrors (EVM)              | What it ships                                                                                                               |
| ------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`packages/programs-core/`](./packages/programs-core/) | `packages/contracts-core/` | Anchor programs (Rust): `sooth_amm`, `sooth_market`, `sooth_launchpad`, `sooth_adjudicator`, plus shared workspace crates   |
| [`packages/sdk-solana/`](./packages/sdk-solana/)       | `packages/sdk/`            | `@sooth/sdk-solana` — TypeScript ChainAdapter implementation: read state, build tx, simulate, sign + submit                 |
| [`apps/demo/`](./apps/demo/)                           | `apps/demo/`               | Solana-only fork. Upstream React tree runs unchanged via a `chain-shim` that translates wagmi/viem hooks into adapter calls |

## Where to start

| You are…                       | Read first                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **A new contributor**          | [`HANDOVER.md`](./HANDOVER.md) — thin index pointing at the focused docs                                                   |
| **Just want it running**       | [`docs/build.md`](./docs/build.md) — `pnpm --filter @sooth/demo dev:localnet`                                              |
| **Checking what's wired**      | [`docs/status.md`](./docs/status.md) — program / SDK / demo state, test scoreboard, devnet IDs                             |
| **Picking up the next task**   | [`docs/roadmap.md`](./docs/roadmap.md) — active items, pending decisions, escalation routing                               |
| **An external SDK integrator** | [`packages/sdk-solana/docs/integrator-contract.md`](./packages/sdk-solana/docs/integrator-contract.md) — frozen public API |
| **Founder / decision-maker**   | [`docs/decision-log.md`](./docs/decision-log.md) — resolved + pending decisions                                            |

## Quick build

```bash
pnpm install
pnpm --filter @sooth/demo dev:localnet   # solana-test-validator path
# or
pnpm --filter @sooth/demo dev:surfpool   # surfpool path (sub-second startup, time-travel cheatcode)
```

The seed script writes `.env.local` and a pre-funded test keypair, deploys the .so binaries, and serves vite on http://localhost:5175. Connect Phantom in localnet mode and trade. Full Phantom setup + wallet-adapter wiring rules are in [`docs/build.md`](./docs/build.md).

## Architectural reading order

For an end-to-end walkthrough in dependency order:

1. [`docs/research/porting-evaluation.md`](./docs/research/porting-evaluation.md) — code-first evaluation of the EVM stack and what porting actually means
2. [`docs/research/orderbook-survey.md`](./docs/research/orderbook-survey.md) — survey of production Solana orderbooks (Monaco, Phoenix, OpenBook, Drift, Manifest, etc.)
3. [`docs/monaco-fork-analysis.md`](./docs/monaco-fork-analysis.md) — deep dive on Monaco as a candidate fork base, including the 60-cap finding
4. [`docs/research/monaco-investigation-week-01.md`](./docs/research/monaco-investigation-week-01.md) — first-hand source reading; inputs to P1
5. [`packages/programs-core/docs/architecture.md`](./packages/programs-core/docs/architecture.md) — 5-program design (synced with implementation reality)
6. [`packages/sdk-solana/docs/integrator-contract.md`](./packages/sdk-solana/docs/integrator-contract.md) — third-party-facing frozen API surface
7. [`packages/sdk-solana/docs/implementation-guide.md`](./packages/sdk-solana/docs/implementation-guide.md) — SDK-author implementation guide (chain adapter, package layout, migration plan)
8. [`docs/decision-log.md`](./docs/decision-log.md) — running record of resolved decisions and gates
9. [`docs/glossary.md`](./docs/glossary.md) — terms used across both tracks

## Layout

```
sooth-solana/
├── README.md                      # this file
├── HANDOVER.md                    # contributor index
├── CLAUDE.md                      # session preamble for AI contributors
├── apps/
│   └── demo/                      # Solana-only forked demo
├── docs/
│   ├── status.md                  # current state table + test scoreboard + devnet IDs
│   ├── build.md                   # local build + Phantom UX + wallet-adapter rules
│   ├── roadmap.md                 # active items + pending decisions
│   ├── decision-log.md            # resolved + pending decisions, append-only
│   ├── glossary.md                # WAD, OUTCOME, tick, CU, PDA, ATA
│   ├── monaco-fork-analysis.md    # Monaco eval + 60-cap finding
│   └── research/                  # external surveys
└── packages/
    ├── programs-core/             # Anchor programs (Rust) + shared workspace crates
    └── sdk-solana/                # @sooth/sdk-solana TypeScript adapter
```

## License

Apache-2.0 (matches Monaco if forking).
