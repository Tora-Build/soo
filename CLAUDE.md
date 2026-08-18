# CLAUDE.md — sooth-solana

Solana implementation of the Sooth Protocol — prediction markets with a dual-venue
lifecycle: LMSR AMM bonding in the deployment's instance token (EAST on devnet),
graduation, then an on-chain order book in USDC, settled by a manual adjudicator.
Companion repo to [`Tora-Build/sooth-alpha`](https://github.com/Tora-Build/sooth-alpha)
(the EVM home). Deployed to Solana devnet.

## What lives where

- `packages/programs-core/programs/sooth-core/` — the single Anchor program
  `sooth_core` (market lifecycle, LMSR AMM, order book, LP/fee flows,
  adjudication). Subsystems are plain Rust modules, not separate programs/CPIs.
  Program ID: `EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw` (devnet + localnet).
- `packages/sdk-solana/` — `@sooth/sdk-solana` TypeScript adapter
  (instruction builders, readers, PDA helpers, LMSR quote math).
- `apps/demo/` — the only frontend, holding both surfaces: the Eastboard shell
  at `/options` wrapping the classic pages, and Arena at `/play`. Talks to the
  program through a chain-shim layer.
- `docs/` — specs (`docs/spec/`), design docs (`docs/design/`), decision log,
  status snapshot, glossary, build guide.

## Build / test

```bash
pnpm install
anchor build                              # from repo root; Anchor 0.30.1, vendored anchor-syn patch
cargo test -p sooth_core                  # program unit tests
pnpm -r test                              # SDK (vitest + litesvm) + demo unit tests
pnpm -r typecheck
pnpm --filter @sooth/demo dev:localnet    # solana-test-validator + seed + vite
pnpm --filter @sooth/demo dev:surfpool    # Surfpool variant (fast boot, time-travel)
pnpm --filter @sooth/demo e2e             # Playwright on-chain e2e
```

The demo consumes the SDK's `dist/`: run `pnpm -F @sooth/sdk-solana build` after
SDK changes before demo tests.

## Hard invariant

Every transaction hitting `sooth_core` must prepend
`ComputeBudgetInstruction::request_heap_frame(256 * 1024)` — the program uses a
custom 256 KB bump allocator. The SDK adapter does this on all paths;
hand-rolled callers must too.

## Onboarding

- `HANDOVER.md` — canonical onboarding doc. Read it first.
- `docs/status.md` — current state snapshot (what is deployed, what is open).
- `docs/decision-log.md` — what's resolved vs open.

## License

Apache-2.0.
