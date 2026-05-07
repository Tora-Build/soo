# Handover — sooth-solana

> Briefing for a new contributor (human or AI) picking up this repo.
> Read this first; it gives you the why, the state, and the next concrete actions.
> Last updated: 2026-05-07.

## What this repo is

`sooth-solana` is the Solana-side of the Sooth Protocol — a prediction market protocol whose EVM implementation lives at [`Tora-Build/sooth-alpha`](https://github.com/Tora-Build/sooth-alpha) (private). This repo houses three layers:

- **`packages/programs-core/`** — Anchor programs (Rust). Mirrors `sooth-alpha/packages/contracts-core/` (Solidity).
- **`packages/sdk-solana/`** — `@sooth/sdk-solana` TypeScript adapter. Implements the vendored `ChainAdapter` interface; consumed directly by the demo (no umbrella SDK dependency under the current Solana-only scoping).
- **`apps/demo/`** — Solana-only fork of `sooth-alpha/apps/demo`. Upstream's React tree runs unchanged via a `chain-shim` layer that translates EVM hook signatures (wagmi/viem) into Solana adapter calls. Validates D1 by construction.

## Status: 4/5 production programs implemented + demo dapp browser-runnable

| Layer                                            | State                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sooth_amm`                                      | LMSR math + buy + sell + claim_unlocked + fee accrual end-to-end. `trade_positions` (buy), `sell_positions`, `claim_unlocked`, `initialize_amm_state`. Fee router consumed via `ProtocolConfig`.              |
| `sooth_market`                                   | Market PDA + lifecycle + custody + mint/merge_complete_set + adjudicator-allowlist + `lock_for_resolution` + `settle` (both gated on `sooth_adjudicator` parent-ix CPI introspection). `redeem` is `todo!()`. |
| `sooth_launchpad`                                | `initialize_protocol` + `initialize_fee_pool` + `create_market` (composes 4 init CPIs) + `distribute_fees` + `seed_lp` real. LP-mint pre-graduation hook on trade_positions is the next followup.             |
| `sooth_adjudicator`                              | Manual variant: `register_adjudicator` + `request_lock` + `attest_outcome`. `dispute` is `todo!()`. ZkTLS variant placeholder.                                                                                |
| `sooth_book`                                     | Spec only. Gated on P1 (Monaco fork vs custom build) — research complete (`docs/research/monaco-investigation-week-01.md`), founder approval pending.                                                         |
| `@sooth/sdk-solana`                              | Buy + sell + claim flows wired (`buildTrade`, `buildSell`, `buildClaim`, `submit` with bounded retry/resend, snapshot/quote/position reads). Vendored `ChainAdapter` types per implementation-guide §2.       |
| `apps/demo`                                      | 162 ts/tsx files faithful fork. `chain-shim` routes upstream hooks through the adapter for AMM + Portfolio + Markets list; orderbook/launchpad/operator pages stub gracefully.                                |
| `sooth-account-offsets` + `sooth-protocol-types` | Shared workspace crates. The first guards Position/LockEntry layout drift via compile-time `SPACE` asserts; the second centralizes program IDs + USDC mint + cross-program ix discriminators.                 |

**Test scoreboard:** 135 cargo tests across the four programs (33 + 52 + 28 + 15 + 7 in shared crates) including 9 LiteSVM CPI integration tests and a runtime test that the create_market 4-way composition lands all 6 PDAs. 29/29 SDK tests including the bankrun smoke + sell-flow + claim-flow + create-market + submit-failure suites. 6/6 demo tests including the React-level happy-path through upstream's AMM page.

**Codex review:** 2-pass complete. 2 critical, 6 high, 3 medium, 2 low findings — all closed (commits `68b663b` and `abfcf15..b029129`). Runtime gap on the C2 introspection check now closed via the LiteSVM CPI suite (commit `b029129`).

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
│       ├── tests/                           # bankrun smoke + sell/claim/create flows
│       └── docs/
│           ├── integrator-contract.md       # CANONICAL — third-party API frozen surface
│           └── implementation-guide.md      # ChainAdapter + Phase A migration plan
└── target/                                  # cargo + .so build outputs (gitignored)
```

## Resolved decisions (`docs/decision-log.md`)

1. **D1 — SDK compatibility means third-party integrator surface, not just our apps.** Canonical contract: `packages/sdk-solana/docs/integrator-contract.md`.
2. **D2 — Escrow atomicity is a hard SDK invariant.** Disqualifies Phoenix and OpenBook v2.
3. **D3 — Sooth Solana ships as a single monorepo (this repo), separate from `sooth-alpha`.**
4. **D4 — LMSR fits within Solana's CU budget; ship Variant A (Taylor exact).** Spike at `_spikes/lmsr-cu/` measured 55k CU peak vs 300k target. Production `trade_positions` ~68k CU.
5. **D5 — Atomic escrow is structurally load-bearing in production.** Telegram-app's only sell path on the orderbook routes through escrow=true; resolved without needing Postgres analytics.

## Pending decisions

| ID     | Decision                                                                                      | Type                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Custom-built `sooth_book` vs Monaco fork                                                      | Founder approval. Engineering recommendation: **fork** (2 hard sites, ~3-4 months). See `docs/research/monaco-investigation-week-01.md`. |
| **P3** | Indexer namespace strategy: widen `chainId` (text) or namespace Solana to integers (900/901)? | Founder.                                                                                                                                 |
| **P5** | Acceptance threshold for race-induced retries on Solana                                       | Operational target (suggest <5%); needs devnet to validate.                                                                              |
| **P6** | Privy Solana SDK eval                                                                         | Wallet UX; current demo uses `@solana/wallet-adapter-react`.                                                                             |
| **P7** | Pricing model: who pays priority fees?                                                        | Founder.                                                                                                                                 |
| **P8** | CLI port to Solana                                                                            | Low priority; deferable.                                                                                                                 |

## Status snapshot (canonical sources, in order of recency)

1. **`git log --oneline main`** — every wave + fix is documented here. Most recent commits cover Wave 6 (sooth-protocol-types, seed_lp, LiteSVM CPI tests).
2. **`docs/decision-log.md`** — D1-D5 resolved entries, append-only.
3. **`packages/programs-core/README.md`** — per-program status table + toolchain notes.
4. **`packages/sdk-solana/README.md`** — adapter status (note: top header still says "spec only" but body documents the wired paths; followup to refresh).
5. **`apps/demo/README.md`** — dev workflow + what's wired vs stub.
6. **`packages/programs-core/docs/architecture.md`** — re-synced with implementation reality (commit `482795a`).

## Building the demo locally

```bash
# Prereqs: solana-cli, Phantom or Solflare browser extension
pnpm install
pnpm --filter @sooth/demo dev:localnet
```

`dev:localnet` boots `solana-test-validator` (preloaded with USDC at the canonical address), deploys all 4 .so binaries, runs `initialize_protocol → initialize_fee_pool → initialize_adjudicator_allowlist → addAdjudicator → createMarket → registerAdjudicator`, writes `apps/demo/.localnet/user-keypair.json` (1000 USDC + 10 SOL pre-funded) + `.env.local`, and serves vite on http://localhost:5175.

In Phantom/Solflare:

1. Settings → Manage Networks → Add Custom RPC: `http://127.0.0.1:8899`
2. Settings → Add/Connect Wallet → Import Private Key → paste the byte array from `apps/demo/.localnet/user-keypair.json`

The wired pages (`/markets`, `/m/:marketAddress`, `/portfolio`) drive the real `SolanaChainAdapter`. Other pages render with sentinel data or stub gracefully.

**Test gotcha:** `apps/demo` consumes `@sooth/sdk-solana` via its `dist/` bundle, not `src/`. After IDL changes, run `pnpm -F @sooth/sdk-solana build` before `pnpm -F @sooth/demo test` so the demo picks them up.

## Architectural foundation (read these in order)

1. **`README.md`** — suite navigation
2. **`docs/research/porting-evaluation.md`** — code-first analysis of the EVM stack
3. **`docs/research/orderbook-survey.md`** — survey of 10 production Solana orderbooks
4. **`docs/monaco-fork-analysis.md`** — deep dive on Monaco as a fork base
5. **`docs/research/monaco-investigation-week-01.md`** — P1 investigation output
6. **`packages/programs-core/docs/architecture.md`** — 5-program design (current with implementation)
7. **`packages/sdk-solana/docs/integrator-contract.md`** — frozen public API surface
8. **`packages/sdk-solana/docs/implementation-guide.md`** — `ChainAdapter` interface, package layout
9. **`docs/decision-log.md`** — running record
10. **`docs/glossary.md`** — terminology

## Sooth context that lives in `sooth-alpha`

- **EVM contracts source**: `sooth-alpha/packages/contracts-core/src/` (`LaunchpadEngine.sol`, `AMMEngine.sol`, `SoothBook.sol`, `OrderEngine.sol`, `TruthMarket.sol`, `FeeRouter.sol`, `AdjudicatorRegistry.sol`, `libraries/LMSRMath.sol`, `libraries/TickBitmap.sol`).
- **Existing TypeScript SDK**: `sooth-alpha/packages/sdk/src/` (the umbrella `@sooth/sdk` — Phase A extraction has not happened; the Solana adapter vendors the interface per `implementation-guide.md §2`).
- **Indexer schema** (Postgres tables to mirror): `sooth-alpha/packages/indexer/ponder.schema.ts`.
- **Project rules**: `sooth-alpha/.claude/rules/knowledge.md` and `lessons.md`.

If you don't have access to `sooth-alpha`, the relevant facts are summarized in `docs/research/porting-evaluation.md` and `packages/programs-core/docs/architecture.md`.

## What to do next (concrete)

The dapp works locally. The most-impactful remaining items:

1. **Founder decision on P1.** All evidence is in `docs/research/monaco-investigation-week-01.md`. Once approved (or rejected), `sooth_book` becomes scaffold-able.
2. **Devnet keypair generation + deploy.** Replace placeholder program IDs (`SoothAMM1...`, `SoothMkt1...`, `SoothLP1...`, `SoothAdj1...`) with real keypairs; deploy to devnet; update `apps/demo/src/lib/config.ts` defaults so `dev` (not just `dev:localnet`) targets devnet.
3. **LP minting on pre-graduation buys.** Architecture §4.2: `if !is_graduated: CPI mint_to(lp_mint → user_lp_ata, lp_amount)`. The `lp_mint_authority` PDA scheme is established by `sooth_launchpad::seed_lp` (commit `2bc0857`) — `sooth_amm::trade_positions` needs to consume it.
4. **`redeem` body on sooth_market.** Spec lives in the module comment (1:1 winner payout, 50:50 INVALID per `TruthMarket.getRedemptionValue`). Gated on `sooth_adjudicator` having attested an outcome (already real for the Manual variant).
5. **`sooth_adjudicator::dispute`** body. Currently `todo!()`. Architecture §4.4.
6. **TS typecheck refresh on `packages/sdk-solana/README.md`** — top header still says "spec only" while the body documents wired paths. Cosmetic but easy.

## What's NOT in scope for this repo

- The EVM stack (lives in `sooth-alpha`)
- Apps consuming the EVM SDK (`sooth-alpha/apps/{telegram,market,world}`); only the demo is forked here as the SDK-compatibility test harness.
- HyperEVM precompile adjudicator and Lens post-action (chain-locked to EVM)
- The multi-actor CLI test harness — stays EVM-only per P8

## Authority and access

- **License**: Apache-2.0 (matches Monaco if forking)
- **Visibility**: private at the time of writing
- **Repo URL**: https://github.com/Tora-Build/sooth-solana
- **Maintainer org**: Tora-Build
- **Created**: 2026-05-05 by extraction from `sooth-alpha/solana/`

## Glossary one-liner reminders

- **WAD** = 1e18 fixed-point precision used for internal math
- **OUTCOME** = `{ NO: 0, YES: 1, INVALID: 2 }` protocol-wide
- **tick** = integer 1..999 in SoothBook's 1000-tick price grid; tick T means "buyer pays T/1000"
- **escrow** (orderbook flag) = use opposite-side shares as collateral instead of base token; atomic round-trip
- **surplus** = collateral generated when `yesTick + noTick > 1000`; paid out as complete-set mint
- **PDA** = Program Derived Address (Solana's stateful-account model)
- **CU** = Compute Unit (Solana's gas equivalent; ~200k default per ix, max 1.4M)
- **ALT** = Address Lookup Table (compresses TX account-list footprint in v0 transactions)
- **ATA** = Associated Token Account

Full definitions in `docs/glossary.md`.

## Questions to escalate

Founder decisions: P1 (sooth_book direction — research complete), P3 (indexer namespace), P6 (Privy), P7 (priority fee model). Engineers can drive P5 (retry threshold; needs devnet first) and P8 (CLI port).

---

_Welcome. Start with `git log --oneline main | head -30`, then `docs/decision-log.md`, then whichever architectural doc maps to your role. The dapp works locally via `pnpm --filter @sooth/demo dev:localnet`._
