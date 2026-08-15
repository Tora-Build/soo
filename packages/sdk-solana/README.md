# @sooth/sdk-solana

> The Solana adapter for Sooth — a workspace member of the `sooth-solana`
> monorepo, published to npm as `@sooth/sdk-solana`.

`SolanaChainAdapter` is the whole surface: it reads protocol state, builds every
`sooth_core` instruction, simulates, signs, and submits. Frontends in this repo
(`apps/pulse` directly, `apps/demo` through its chain-shim) use nothing else to
reach the chain.

The public API that third parties may rely on is frozen in
[`docs/integrator-contract.md`](./docs/integrator-contract.md); how it is
implemented is in [`docs/implementation-guide.md`](./docs/implementation-guide.md).
If the two ever disagree, the integrator contract wins.

## What it does

**Reads**

- `readSnapshot(market, user?)` / `readSnapshots(markets[])` — `Market`,
  `AmmState`, and the caller's `Position`
- `readQuote(market, outcome, deltaShares)` — LMSR cost computed client-side, no
  RPC round-trip
- `readPosition`, `readPortfolio`, `readAmmState`, `readLpRedemption`
- `readGraduationProgress(market)` — accrued fees against the `b·ln(2)` threshold
- `readMarketQuestion(market)` — the question text stored on-chain
- `readMarketTrades(market, {limit})` / `readBookHistory` — price history decoded
  from events, AMM and book on one YES-price axis
- `readBook(market)` — the live order book
- `readAdjudicator`, `readPendingUnlocks`, `readVenueFeeBps`

**Builds**

- Creation and liquidity: `buildCreateMarket` (defaults `market_id` to the first
  16 bytes of `sha256(question)`; `marketIdForQuestion` is exported),
  `buildSeedLp`
- AMM: `buildTrade` (buy), `buildSell`, `buildClaim`
- Book: `buildBookPlace`, `buildBookCancel`, `buildBookCancelMany`,
  `buildBookWithdraw`
- Resolution and payout: `buildRequestLock`, `buildAttestOutcome`,
  `buildSettle`, `buildRedeemAmmPosition`, `buildRedeemBookSeat`,
  `buildClaimRefund`, `buildDismissMarket`
- LP, fees, end of life: `buildRedeemLp`, `buildDistributeFees`,
  `buildReclaimSubsidy`, `buildSweepResidual`, `buildCloseMarket`

**Submits** — `preflight` simulates before signing; `submit` sets a compute-unit
price, salts duplicate transactions, and retries on a stale blockhash. Errors
come back as `SoothError`, classified from the program's Anchor codes.

Every built transaction prepends
`ComputeBudgetInstruction.requestHeapFrame(256 * 1024)`. `sooth_core` runs a
custom bump allocator over that region and aborts without it, so the adapter
adds it on all paths — including read-only simulations.

`buildTrade({ side: "sell" })` throws with a "use buildSell()" hint. The split
mirrors the on-chain one between `trade_positions` and `sell_positions`, because
sells escrow their proceeds.

## Quick usage

See the examples further down for the read path, the
build → preflight → submit path with a wallet adapter, and the `SoothRequest`
meta shape.

## Building and testing locally

```sh
pnpm install                               # from repo root
pnpm -F @sooth/sdk-solana build            # tsc compile
pnpm -F @sooth/sdk-solana test             # vitest (litesvm-backed)
```

Tests boot `litesvm`, deploy `sooth_core` from `target/deploy/`, seed the market
fixtures, and exercise the adapter against fresh venue mints. Coverage spans the
AMM flows, the book (placement, matching behaviour, CU budget, heap frame,
events, constants), venue separation and mint defaults, graduation gating and LP,
adjudication end to end, fee distribution, solvency invariants, market close, IDL
freshness, submit retry and priority fee, PDAs, and the LMSR port.

> **Build-step gotcha:** the demo and any consumer ESM caller import from
> `dist/`. After editing `src/`, run `pnpm -F @sooth/sdk-solana build` before
> reloading the dapp — vitest hits `src/` directly, but the bundled consumer does
> not.

## Layout

```
packages/sdk-solana/
├── README.md                       # this file
├── docs/
│   ├── integrator-contract.md      # third-party-facing frozen surface (CANONICAL)
│   ├── implementation-guide.md     # how the adapter is built
│   └── orderbook-cancel-ux.md      # what cancelling returns, and when
├── src/
│   ├── adapter.ts                  # SolanaChainAdapter — reads, builders, submit
│   ├── anchor/                     # sooth_core IDL + typed loader
│   ├── book/                       # book decoding and event helpers
│   ├── orderbook/                  # error classification for book paths
│   ├── math/lmsr.ts                # client-side LMSR quote math
│   ├── pdas.ts                     # PDA derivation helpers
│   ├── refs.ts                     # AddressRef / MarketRef encode-decode
│   ├── errors.ts                   # SoothError taxonomy
│   ├── types.ts                    # public types
│   └── index.ts                    # public surface
└── tests/                          # vitest suite over litesvm
```

## Companions

- [`../programs-core/`](../programs-core/) — the program whose IDL this SDK consumes
- [`../../docs/spec/`](../../docs/spec/) — per-subsystem specs
- [`../../docs/decision-log.md`](../../docs/decision-log.md) — resolved and open decisions
