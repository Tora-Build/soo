# Sooth on Solana

> Solana implementation of the [Sooth Protocol](https://github.com/Tora-Build/sooth-alpha)
> — prediction markets that bond on an LMSR AMM in the deployment's instance
> token, graduate into an on-chain order book in USDC, and settle through a
> manual adjudicator with a veto window.

Companion to `Tora-Build/sooth-alpha` (the EVM home). Deployed to Solana devnet.

| Layer                                                                     | What it ships                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`packages/programs-core/programs/sooth-core/`](./packages/programs-core/) | `sooth_core` — one Anchor program: market lifecycle, LMSR AMM, CLOB, LP/fee flows, adjudication. No cross-program CPIs. |
| [`packages/sdk-solana/`](./packages/sdk-solana/)                          | `@sooth/sdk-solana` — instruction builders, account readers, PDA helpers, client-side LMSR quote math.                  |
| [`apps/demo/`](./apps/demo/)                                              | Forked demo: classic pages, the Eastboard shell at `/options`, Arena at `/play`. Talks to the program via a chain-shim. |

## Where to start

| You are…                     | Read first                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| **A new contributor**        | [`HANDOVER.md`](./HANDOVER.md) — how the protocol works and where the code lives                       |
| **Just want it running**     | [`docs/build.md`](./docs/build.md)                                                                     |
| **Checking what exists**     | [`docs/status.md`](./docs/status.md) — shipped surface, deployment, open items                         |
| **Picking up the next task** | [`docs/roadmap.md`](./docs/roadmap.md)                                                                 |
| **An SDK integrator**        | [`packages/sdk-solana/docs/integrator-contract.md`](./packages/sdk-solana/docs/integrator-contract.md) |
| **Founder / decision-maker** | [`docs/decision-log.md`](./docs/decision-log.md)                                                       |

## Quick build

```bash
pnpm install
anchor build                             # Anchor 0.30.1, vendored anchor-syn patch
pnpm --filter @sooth/demo dev:localnet   # solana-test-validator path
# or
pnpm --filter @sooth/demo dev:surfpool   # Surfpool path (sub-second startup, time-travel cheatcode)
```

The seed script writes `.env.local` and a pre-funded test keypair, deploys
`sooth_core`, bootstraps the protocol singletons, and serves vite on
http://localhost:5175. `pnpm dev` without a flag targets devnet. Wallet setup is
in [`docs/build.md`](./docs/build.md).

Every transaction must prepend
`ComputeBudgetInstruction::request_heap_frame(256 * 1024)` — the program runs a
custom 256 KB bump allocator. The SDK adapter does this on all paths.

## Reading order

1. [`HANDOVER.md`](./HANDOVER.md) — the dual-venue lifecycle end to end
2. [`docs/design/dual-token-venues.md`](./docs/design/dual-token-venues.md) — why the AMM and the book hold different tokens
3. [`docs/design/orderbook-redesign.md`](./docs/design/orderbook-redesign.md) — the single-account, single-axis book
4. [`docs/spec/`](./docs/spec/) — per-subsystem specs
5. [`packages/sdk-solana/docs/integrator-contract.md`](./packages/sdk-solana/docs/integrator-contract.md) — public API surface
6. [`docs/decision-log.md`](./docs/decision-log.md) — resolved and open decisions
7. [`docs/glossary.md`](./docs/glossary.md) — terminology

## Layout

```
sooth-solana/
├── README.md / HANDOVER.md / CLAUDE.md / CHANGELOG.md
├── Anchor.toml / Cargo.toml / package.json / pnpm-workspace.yaml
├── apps/
│   └── demo/                      # forked demo + Eastboard + Arena
├── docs/
│   ├── status.md                  # current snapshot
│   ├── build.md                   # local build + wallet rules
│   ├── roadmap.md
│   ├── decision-log.md
│   ├── glossary.md
│   ├── develop-vs-main.md
│   ├── design/                    # orderbook redesign, dual-token venues
│   └── spec/                      # per-subsystem specs
├── packages/
│   ├── programs-core/             # Anchor program `sooth_core`
│   └── sdk-solana/                # @sooth/sdk-solana
└── vendor/anchor-syn-0.30.1-fork  # rustc-compat patch for IDL generation
```

## License

Apache-2.0.
