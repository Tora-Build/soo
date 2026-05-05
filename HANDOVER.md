# Handover — sooth-solana

> Briefing for a new contributor (human or AI) picking up this repo.
> Read this first; it gives you the why, the state, and the next concrete actions.
> Last updated: 2026-05-05.

## What this repo is

`sooth-solana` is the Solana-side of the Sooth Protocol — a prediction market protocol whose EVM implementation lives at [`Tora-Build/sooth-alpha`](https://github.com/Tora-Build/sooth-alpha) (private). This repo is the spec-and-implementation home for two products:

- **`packages/programs-core/`** — Anchor programs (Rust). Mirrors `sooth-alpha/packages/contracts-core/` (Solidity).
- **`packages/sdk-solana/`** — `@sooth/sdk-solana` TypeScript adapter, published to npm. Loaded dynamically by the umbrella `@sooth/sdk` (which lives in `sooth-alpha/packages/sdk/`) when the active node is a Solana node.

The link to `sooth-alpha` is **only** the published `@sooth/sdk-solana` npm package. No git submodules, no shared workspace, no source coupling. EVM-only consumers of `@sooth/sdk` don't pay any Solana bundle cost (tree-shaken via dynamic import).

## Status: spec only, no code

Every doc in this repo is a design spec. There is no Rust, no Anchor program, no TypeScript adapter implementation yet. Implementation is gated by three things — see `docs/decision-log.md` "Pending" section. The first two are technical spikes; the third is a founder decision.

```
sooth-solana/
├── README.md                                # suite index
├── LICENSE                                  # Apache-2.0
├── package.json + pnpm-workspace.yaml       # JS workspace bootstrap (empty)
├── Cargo.toml                               # Rust workspace bootstrap (empty)
├── docs/
│   ├── decision-log.md                      # 3 resolved + 8 open decisions
│   ├── glossary.md                          # ~50 terms (WAD, OUTCOME, tick, CU, PDA, etc.)
│   ├── monaco-fork-analysis.md              # Monaco eval + 60-cap finding
│   └── research/
│       ├── porting-evaluation.md            # code-first eval of EVM stack
│       └── orderbook-survey.md              # 10 production Solana CLOBs surveyed
└── packages/
    ├── programs-core/
    │   ├── README.md
    │   └── docs/architecture.md             # 5-program design, account model, CU budgets
    └── sdk-solana/
        ├── README.md
        └── docs/
            ├── integrator-contract.md       # CANONICAL — third-party API frozen surface
            └── implementation-guide.md      # SDK-author internal guide
```

## Resolved decisions (from `docs/decision-log.md`)

1. **D1 — SDK compatibility means third-party integrator surface, not just our apps.** External developers must write code that runs unchanged on EVM and Solana Sooth deployments. Canonical contract: `packages/sdk-solana/docs/integrator-contract.md`.
2. **D2 — Escrow atomicity is a hard SDK invariant.** `placeOrder({ escrow: true })` MUST produce an atomic outcome on every supported chain. This **disqualifies Phoenix and OpenBook v2** as Solana orderbook backends — neither can deliver atomic escrow. Only options that preserve atomicity remain viable.
3. **D3 — Sooth Solana ships as a single monorepo (this repo), separate from `sooth-alpha`.** No Solana code or specs in `sooth-alpha`. Cross-cutting changes between program and adapter stay atomic in this repo.

## Pending decisions blocking implementation

Read `docs/decision-log.md` for full detail. The five most important:

| ID     | Decision                                                                                      | Type                                                                                    |
| ------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **P1** | Custom-built `sooth_book` vs Monaco fork                                                      | Engineering + founder. See `docs/monaco-fork-analysis.md` for the evaluation framework. |
| **P2** | Does LMSR fit within Solana's CU budget?                                                      | Technical spike. See `packages/programs-core/docs/architecture.md §5` and §13.          |
| **P3** | Indexer namespace strategy: widen `chainId` (text) or namespace Solana to integers (900/901)? | Founder.                                                                                |
| **P4** | Is `escrow=true` actually used in production? Pull telegram analytics.                        | Analytics. Resolves D2's premise.                                                       |
| **P5** | Acceptance threshold for race-induced retries on Solana                                       | Operational target (suggest <5%).                                                       |

Plus P6 (Privy Solana eval), P7 (priority fee model), P8 (CLI port).

## The two spikes that unblock everything

Until at least P1 and P2 are resolved, no production code should be written. Both are 1-week prototypes:

### Spike 1 — LMSR CU budget

**Question**: Does `sooth_amm::trade_positions` run within Solana's CU budget?

**Target**: ≤300k CU per typical buy; ≤500k tail. If higher, mitigations are documented in architecture spec §5 (approximation tables, crank pattern, drop LMSR).

**Deliverable**: Rust prototype + benchmark on `solana-test-validator`. Report numbers; recommend mitigation if needed.

**Where to put output**: suggest `_spikes/lmsr-cu/` at repo root.

### Spike 2 — Monaco investigation week

**Question**: Can we fork Monaco Protocol (Apache-2.0) without restructuring its core matching engine?

**What to do**: Read `programs/monaco_protocol/src/` end-to-end. Count call sites that assume `liquidities.len() < 100`. Specifically look at the `MarketLiquidities` 30-cap (per side) Vec — Sooth needs 1000-tick price indexing.

**Decision criteria** (from `docs/monaco-fork-analysis.md §6`):

- <5 sites: fork wins. ~3 months engineering.
- 5–20 sites: fork still wins, marginally. Plan +1 month.
- > 20 sites: custom build is cleaner. Default to "build from Monaco/Manifest/Drift lessons."

**Deliverable**: a written investigation report. Suggest `docs/research/monaco-investigation-week-NN.md`.

## Architectural foundation (read these in order)

1. **`README.md`** — suite navigation
2. **`docs/research/porting-evaluation.md`** — code-first analysis of the EVM stack and what porting actually means
3. **`docs/research/orderbook-survey.md`** — survey of 10 production Solana orderbooks
4. **`docs/monaco-fork-analysis.md`** — deep dive on Monaco as a fork base, including the 60-cap finding
5. **`packages/programs-core/docs/architecture.md`** — 5-program Solana design (LaunchpadEngine → sooth_launchpad, AMMEngine → sooth_amm, OrderEngine+TruthMarket → sooth_market, SoothBook → sooth_book, AdjudicatorRegistry → sooth_adjudicator)
6. **`packages/sdk-solana/docs/integrator-contract.md`** — the frozen public API surface (~35 symbols) the SDK must honor across both chains
7. **`packages/sdk-solana/docs/implementation-guide.md`** — SDK-internal architecture, ChainAdapter interface, package layout, two-phase migration plan
8. **`docs/decision-log.md`** — running record
9. **`docs/glossary.md`** — terminology

## Sooth context you'll need (won't find in this repo)

This repo is intentionally Solana-only. For protocol-level context that lives in `sooth-alpha`:

- **EVM contracts source**: `sooth-alpha/packages/contracts-core/src/` (`LaunchpadEngine.sol`, `AMMEngine.sol`, `SoothBook.sol`, `OrderEngine.sol`, `TruthMarket.sol`, `FeeRouter.sol`, `AdjudicatorRegistry.sol`, `libraries/LMSRMath.sol`, `libraries/TickBitmap.sol`).
- **Existing TypeScript SDK**: `sooth-alpha/packages/sdk/src/`. The `@sooth/sdk` package this repo's adapter integrates into.
- **Indexer schema** (Postgres tables to mirror): `sooth-alpha/packages/indexer/ponder.schema.ts`.
- **Registry format**: `sooth-alpha/packages/registry/nodes.json` and `src/types.ts` — needs widening to support Solana clusters per P3.
- **Project rules**: `sooth-alpha/.claude/rules/knowledge.md` (canonical formulas, deployments) and `lessons.md` (read first; documents past mistakes).

If you don't have access to `sooth-alpha`, the relevant facts are summarized in `docs/research/porting-evaluation.md` and `packages/programs-core/docs/architecture.md`. Those are designed to be self-contained.

## What to do today (concrete)

If you're picking this up from scratch, the highest-leverage things you can do without waiting for spike results:

1. **Add `CLAUDE.md`** at this repo's root if working with Claude Code. Suggested content: 1-paragraph project description, link to this `HANDOVER.md`, the Apache-2.0 license note, the "specs only" status, and a pointer to `docs/decision-log.md`.
2. **Schedule the two spikes.** They can run in parallel (different skillsets — spike 1 is greenfield Rust, spike 2 is reading existing Rust). Identify owners.
3. **Pull P4 analytics.** Cheap; resolves D2's premise. If escrow turns out to be unused, the orderbook decision space opens up dramatically.
4. **Set up CI scaffolding.** GitHub Actions for `pnpm install` (no-op until packages have content), `cargo build` (no-op until programs exist). Make it pass green so future PRs have a baseline.
5. **Set up `CODEOWNERS`** if multiple contributors will work here.
6. **Decide on visibility.** Currently private. Flip to public when there's something worth showing — probably after first program compiles on devnet.

## Sequencing for actual implementation

When the spikes return green and the orderbook decision is made:

1. **Phase A** (in `sooth-alpha`, not this repo): refactor `@sooth/sdk` to extract the `ChainAdapter` interface. No Solana code. Ships as `@sooth/sdk@0.3.0`. See `packages/sdk-solana/docs/implementation-guide.md §8 Phase A`.
2. **Solana programs** (in this repo): start with `sooth_amm` since LMSR is the load-bearing CU question. Then `sooth_market` (custody + lifecycle). Then `sooth_book` (orderbook — depends on P1 outcome). Then `sooth_launchpad` (ties it together). Adjudicators last.
3. **Solana adapter** (in this repo, `packages/sdk-solana/src/`): once `@sooth/sdk@0.3.0` is published with `ChainAdapter`, implement against it.
4. **Umbrella wiring** (in `sooth-alpha`): `@sooth/sdk` declares `@sooth/sdk-solana` as optional peer dep, dynamically imports when needed. Ships as `@sooth/sdk@0.4.0`.
5. **Devnet release** (this repo): tag v0.1.0 when end-to-end works.

## What's NOT in scope for this repo

- The EVM stack (lives in `sooth-alpha`)
- The chain-agnostic `core/` SDK code (lives in `sooth-alpha/packages/sdk/`)
- Apps consuming the SDK (`sooth-alpha/apps/{demo,telegram,market,world}`)
- HyperEVM precompile adjudicator and Lens post-action (chain-locked to EVM by design)
- The multi-actor CLI test harness (`sooth-alpha/packages/sdk/src/cli/`) — stays EVM-only per P8

## Authority and access

- **License**: Apache-2.0 (matches Monaco if forking)
- **Visibility**: private at the time of writing
- **Repo URL**: https://github.com/Tora-Build/sooth-solana
- **Maintainer org**: Tora-Build
- **Created**: 2026-05-05 by extraction from `sooth-alpha/solana/` (which was deleted in the same operation)

## Glossary one-liner reminders

- **WAD** = 1e18 fixed-point precision used for internal math
- **OUTCOME** = `{ NO: 0, YES: 1, INVALID: 2 }` protocol-wide
- **tick** = integer 1..999 in SoothBook's 1000-tick price grid; tick T means "buyer pays T/1000"
- **escrow** (orderbook flag) = use opposite-side shares as collateral instead of base token; atomic round-trip
- **surplus** = collateral generated when `yesTick + noTick > 1000`; paid out as complete-set mint
- **PDA** = Program Derived Address (Solana's stateful-account model)
- **CU** = Compute Unit (Solana's gas equivalent; ~200k default per ix, max 1.4M)
- **ALT** = Address Lookup Table (compresses TX account-list footprint in v0 transactions)

Full definitions in `docs/glossary.md`.

## Questions to escalate

Anything in `docs/decision-log.md` "Pending" needs a real decision. Don't guess; ask. Founders have explicit input on P1, P3, P4, P6, P7. Engineers can resolve P2, P5, P8 with prototypes/spikes.

---

_Welcome. Start with `README.md`, then `docs/decision-log.md`, then whichever architectural doc maps to your role._
