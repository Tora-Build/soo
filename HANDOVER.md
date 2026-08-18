# Handover — sooth-solana

> Briefing for a new contributor (human or AI). Read this first; it indexes the
> focused docs.

## What this repo is

`sooth-solana` is the Solana implementation of the Sooth Protocol — prediction
markets whose EVM implementation lives at
[`Tora-Build/sooth-alpha`](https://github.com/Tora-Build/sooth-alpha) (private).

A market runs a **dual-venue lifecycle**:

1. **Bonding (AMM).** An LMSR AMM priced in the deployment's instance token
   (EAST on devnet). The creator posts `b·ln(2)` as the LMSR subsidy in
   `seed_lp`; fees repay it as the market trades.
2. **Graduation.** When accumulated fees reach `b·ln(2)`, the market graduates
   and the order book opens. The program enforces this — the venue is routed,
   never chosen by the UI.
3. **Order book (CLOB).** One account per market holding both sides on a single
   YES-price axis in ticks `1..=999` (a NO order at price `p` is stored as a YES
   order at `1 − p`), priced in USDC. Matching happens on-chain; no caller-side
   fill prediction.
4. **Settlement.** A per-market `AdjudicatorEntry` attests an outcome, a veto
   window opens for `dispute`, then a permissionless `settle` finalizes. Payouts
   run through `redeem_amm_position`, `redeem_book_seat`, `claim_unlocked`,
   `claim_refund`, `reclaim_subsidy`, `sweep_residual`, and `close_market`.

Market questions are self-describing: `create_market` verifies the question text
against its sha256 hash and emits it in `MarketCreated`, so a client recovers the
title from chain history with no indexer. The `Market` account keeps the hash.

## Layers

- **`packages/programs-core/programs/sooth-core/`** — one Anchor program,
  `sooth_core`. Market lifecycle, LMSR AMM, CLOB, LP/fee flows, and adjudication
  are Rust modules calling each other directly, not separate programs over CPI.
- **`packages/sdk-solana/`** — `@sooth/sdk-solana`. Instruction builders,
  account readers, PDA helpers, and client-side LMSR quote math.
- **`apps/demo/`** — forked demo app, and the only frontend. It carries both
  surfaces: the Eastboard shell at `/options`, wrapping the classic pages, and
  Arena at `/play`. Both reach the program through a chain-shim.

## Where to look

| Topic                                   | Doc                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Current state, deployment, open items   | [`docs/status.md`](docs/status.md)                                                                   |
| Build and run locally                   | [`docs/build.md`](docs/build.md)                                                                     |
| Resolved vs open decisions              | [`docs/decision-log.md`](docs/decision-log.md)                                                        |
| Terminology (WAD, OUTCOME, tick, …)     | [`docs/glossary.md`](docs/glossary.md)                                                               |
| Per-subsystem specs                     | [`docs/spec/`](docs/spec/)                                                                           |
| Order book design                       | [`docs/design/orderbook-redesign.md`](docs/design/orderbook-redesign.md)                             |
| Two-token venue split                   | [`docs/design/dual-token-venues.md`](docs/design/dual-token-venues.md)                               |
| How `develop` differs from `main`       | [`docs/develop-vs-main.md`](docs/develop-vs-main.md)                                                 |
| SDK public surface                      | [`packages/sdk-solana/docs/integrator-contract.md`](packages/sdk-solana/docs/integrator-contract.md) |

## Repo layout

```
sooth-solana/
├── README.md                     # suite index
├── HANDOVER.md                   # this file
├── CLAUDE.md                     # agent orientation
├── CHANGELOG.md
├── Anchor.toml                   # Anchor 0.30.1; sooth_core program id
├── Cargo.toml                    # Rust workspace (sooth-core) + anchor-syn patch
├── package.json / pnpm-workspace.yaml
├── apps/
│   └── demo/                     # forked demo + Eastboard + Arena + dev/seed scripts
├── docs/                         # specs, design docs, decision log, status, glossary
├── packages/
│   ├── programs-core/programs/sooth-core/
│   └── sdk-solana/
└── vendor/anchor-syn-0.30.1-fork # rustc-compat patch for IDL generation
```

## Running it

```bash
pnpm install
anchor build                            # produces target/deploy/sooth_core.so
pnpm --filter @sooth/demo dev:localnet  # validator + seed + vite on :5175
```

`pnpm dev` without a flag targets devnet. See [`docs/build.md`](docs/build.md)
for wallet setup, the Surfpool path, and the seeding flow.

Every transaction must prepend
`ComputeBudgetInstruction::request_heap_frame(256 * 1024)`; the program runs a
custom 256 KB bump allocator and aborts without it. The SDK adapter does this
automatically.

## Authority and access

- **License**: Apache-2.0.
- **Repo**: https://github.com/Tora-Build/sooth-solana (private), org Tora-Build.
