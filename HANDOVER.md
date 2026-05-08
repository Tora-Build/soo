# Handover — sooth-solana

> Briefing for a new contributor (human or AI) picking up this repo.
> Read this first; it's an index of the focused docs.

## What this repo is

`sooth-solana` is the Solana-side of the Sooth Protocol — a prediction market protocol whose EVM implementation lives at [`Tora-Build/sooth-alpha`](https://github.com/Tora-Build/sooth-alpha) (private).

**Status (2026-05-08)**: protocol layer feature-complete for the AMM lifecycle (buy → sell → claim → graduate → settle/dismiss → redeem/refund/LP-redeem). 175 cargo tests across the four programs, 49 SDK vitest specs, 19/19 Playwright e2e specs green on a fresh Surfpool boot. Only `sooth_book` (the on-chain orderbook) remains, gated on P1.

This repo houses three layers:

- **`packages/programs-core/`** — Anchor programs (Rust). Mirrors `sooth-alpha/packages/contracts-core/` (Solidity).
- **`packages/sdk-solana/`** — `@sooth/sdk-solana` TypeScript adapter. Implements the vendored `ChainAdapter` interface; consumed directly by the demo (no umbrella SDK dependency under the current Solana-only scoping).
- **`apps/demo/`** — Solana-only fork of `sooth-alpha/apps/demo`. Upstream's React tree runs unchanged via a `chain-shim` layer that translates EVM hook signatures (wagmi/viem) into Solana adapter calls. Validates D1 by construction.

## Where to look

| Topic                                     | Doc                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Program / SDK / demo / devnet state       | [`docs/status.md`](docs/status.md)                                                                     |
| Build the demo locally (Phantom UX)       | [`docs/build.md`](docs/build.md)                                                                       |
| What's left + pending decisions           | [`docs/roadmap.md`](docs/roadmap.md)                                                                   |
| Resolved + pending decisions, append-only | [`docs/decision-log.md`](docs/decision-log.md)                                                         |
| Terminology (WAD, OUTCOME, tick, …)       | [`docs/glossary.md`](docs/glossary.md)                                                                 |
| 5-program design, synced with reality     | [`packages/programs-core/docs/architecture.md`](packages/programs-core/docs/architecture.md)           |
| Frozen public API surface (CANONICAL)     | [`packages/sdk-solana/docs/integrator-contract.md`](packages/sdk-solana/docs/integrator-contract.md)   |
| `ChainAdapter` interface, layout          | [`packages/sdk-solana/docs/implementation-guide.md`](packages/sdk-solana/docs/implementation-guide.md) |

## Reading order for new contributors

1. `README.md` — suite navigation
2. [`docs/status.md`](docs/status.md) — what's wired, test scoreboard, devnet IDs
3. [`docs/build.md`](docs/build.md) — get the dapp running locally
4. [`docs/research/porting-evaluation.md`](docs/research/porting-evaluation.md) — code-first analysis of the EVM stack
5. [`docs/research/orderbook-survey.md`](docs/research/orderbook-survey.md) — survey of 10 production Solana orderbooks
6. [`docs/monaco-fork-analysis.md`](docs/monaco-fork-analysis.md) — deep dive on Monaco as a fork base
7. [`docs/research/monaco-investigation-week-01.md`](docs/research/monaco-investigation-week-01.md) — P1 investigation output
8. [`packages/programs-core/docs/architecture.md`](packages/programs-core/docs/architecture.md) — 5-program design
9. [`packages/sdk-solana/docs/integrator-contract.md`](packages/sdk-solana/docs/integrator-contract.md) — frozen public API
10. [`packages/sdk-solana/docs/implementation-guide.md`](packages/sdk-solana/docs/implementation-guide.md) — `ChainAdapter` interface, package layout
11. [`docs/decision-log.md`](docs/decision-log.md) — running record
12. [`docs/glossary.md`](docs/glossary.md) — terminology
13. [`docs/roadmap.md`](docs/roadmap.md) — what to do next

## Repo layout

```
sooth-solana/
├── README.md                                # suite index
├── HANDOVER.md                              # this file
├── CLAUDE.md                                # session preamble
├── LICENSE                                  # Apache-2.0
├── package.json + pnpm-workspace.yaml       # JS workspace (apps/*, packages/*)
├── Cargo.toml                               # Rust workspace (4 programs + 2 shared crates)
├── _spikes/lmsr-cu/                         # LMSR CU-budget spike (D4 source data)
├── apps/
│   └── demo/                                # Solana-only forked demo + dev:localnet flow
├── docs/
│   ├── status.md                            # program / SDK / demo / devnet state
│   ├── build.md                             # local build + wallet rules
│   ├── roadmap.md                           # active items + pending decisions
│   ├── decision-log.md                      # 5 resolved + remaining pending
│   ├── glossary.md                          # WAD, OUTCOME, tick, CU, PDA, ATA
│   ├── monaco-fork-analysis.md              # Monaco eval + 60-cap finding
│   └── research/
│       ├── porting-evaluation.md
│       ├── orderbook-survey.md
│       └── monaco-investigation-week-01.md  # P1 research output (recommend fork)
├── packages/
│   ├── programs-core/
│   │   ├── README.md                        # per-program status + toolchain
│   │   ├── docs/architecture.md             # 5-program design (synced with reality)
│   │   ├── crates/
│   │   │   ├── sooth-account-offsets/       # compile-time layout drift guards
│   │   │   └── sooth-protocol-types/        # cross-program IDs + discriminators
│   │   └── programs/
│   │       ├── sooth_amm/
│   │       ├── sooth_market/
│   │       ├── sooth_launchpad/
│   │       └── sooth_adjudicator/
│   └── sdk-solana/
│       ├── README.md
│       ├── src/                             # adapter, pdas, math/lmsr, anchor IDLs, types
│       ├── tests/                           # litesvm-backed; 49 specs across 15 files
│       └── docs/
│           ├── integrator-contract.md       # CANONICAL — third-party API frozen surface
│           └── implementation-guide.md      # ChainAdapter + Phase A migration plan
└── target/                                  # cargo + .so build outputs (gitignored)
```

## Sooth context that lives in `sooth-alpha`

- **EVM contracts source**: `sooth-alpha/packages/contracts-core/src/` (`LaunchpadEngine.sol`, `AMMEngine.sol`, `SoothBook.sol`, `OrderEngine.sol`, `TruthMarket.sol`, `FeeRouter.sol`, `AdjudicatorRegistry.sol`, `libraries/LMSRMath.sol`, `libraries/TickBitmap.sol`).
- **Existing TypeScript SDK**: `sooth-alpha/packages/sdk/src/` (the umbrella `@sooth/sdk` — Phase A extraction has not happened; the Solana adapter vendors the interface per `implementation-guide.md §2`).
- **Indexer schema** (Postgres tables to mirror): `sooth-alpha/packages/indexer/ponder.schema.ts`.
- **Project rules**: `sooth-alpha/.claude/rules/knowledge.md` and `lessons.md`.

If you don't have access to `sooth-alpha`, the relevant facts are summarized in `docs/research/porting-evaluation.md` and `packages/programs-core/docs/architecture.md`.

## Authority and access

- **License**: Apache-2.0 (matches Monaco if forking).
- **Visibility**: private at the time of writing.
- **Repo URL**: https://github.com/Tora-Build/sooth-solana
- **Maintainer org**: Tora-Build.
- **Created**: 2026-05-05 by extraction from `sooth-alpha/solana/`.

---

_Welcome. Start with `git log --oneline main | head -30`, then `docs/status.md`, then whichever architectural doc maps to your role. The dapp works locally via `pnpm --filter @sooth/demo dev:localnet`._
