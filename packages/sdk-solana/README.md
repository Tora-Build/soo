# @sooth/sdk-solana

> Solana adapter for `@sooth/sdk` — workspace member of the `sooth-solana` monorepo.
> Published to npm as `@sooth/sdk-solana`. Loaded dynamically by `@sooth/sdk` (in `sooth-alpha`) when the active node is a Solana node.
> Status: AMM buy / sell / claim, `create_market`, and `preflight` (simulate-before-sign) wired end-to-end. 40-spec vitest suite green on `litesvm` (smoke / sell / claim / create-market / submit-failure / preflight / per-program error-classifier). Orderbook, redeem, and full portfolio paths still throw `NotImplemented`.

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

**AMM vertical landed.** The package exports a real `SolanaChainAdapter` class with the AMM buy / sell / claim paths, `create_market`, and `preflight` (simulate-before-sign) wired end-to-end (read state, build tx, sign+submit, read back). A 40-spec vitest suite covering smoke / sell / claim / create-market / submit-failure / preflight / per-program error-classifier plus the LMSR port runs against `litesvm` in <5s.

What's real today:

- `readSnapshot(market, user?)` — Market PDA + AmmState PDA + Position PDA
- `readQuote(market, outcome, deltaShares)` — off-chain LMSR cost (TS port mirrors `_spikes/lmsr-cu`)
- `readPosition(market, user)`
- `buildTrade(market, args)` for `side: "buy"` (sell callers route through `buildSell` — see below)
- `buildSell(market, args)` — `sooth_amm::sell_positions` + lock-on-sell `LockEntry` PDA init
- `buildClaim(market, args)` — `sooth_amm::claim_unlocked` (one LockEntry per call; multi-claim fans out at the call site)
- `buildCreateMarket(args)` — `sooth_launchpad::create_market` composes the four-leg init flow via CPI
- `submit(req, signer)` via `Connection.sendRawTransaction` + `confirmTransaction`, with bounded retry on transient `BlockhashNotFound`

What still throws `SoothError({ kind: "NotImplemented" })`:

- `readPortfolio`, `buildOrderbook*` (gated on §6's CLOB choice — see programs-core/docs/architecture.md), `preflight`, `subscribeMarketEvents`, `subscribePositionEvents`, `getCollateralBalance`, `buildApprove`
- `buildTrade({ side: "sell" })` deliberately throws `NotImplemented` with a "use buildSell()" hint — the SDK split mirrors the on-chain ix split (Wave 1A landed `sell_positions` separate from `trade_positions`).
- Redeem / LP-redeem (gated on `sooth_market::redeem` and `sooth_launchpad::seed_lp` landing — both currently `todo!()` per architecture.md §4.5 / §8).

The ChainAdapter interface and supporting types are **vendored** at the top of `src/types.ts` with a `// VENDORED — replace with @sooth/sdk@0.3.0` comment. When upstream Phase A ships, replace the vendored types with the upstream import; the swap is mechanical.

### Completed gating items

- [x] Phase A refactor of existing `@sooth/sdk` to extract the `ChainAdapter` interface — **vendored locally** until upstream lands
- [x] LMSR CU spike — `trade_positions` benches at ~70k CU (well inside 300k budget)

### Still gating production rollout

1. The `sooth-core-solana` design landing on a final orderbook strategy (custom build vs Monaco fork)
2. Real upstream `@sooth/sdk@0.3.0` shipping the canonical ChainAdapter

See [`docs/implementation-guide.md §8`](./docs/implementation-guide.md) for the two-phase migration plan.

## Quick usage

```ts
import { SolanaChainAdapter, encodePubkeyRef } from "@sooth/sdk-solana";
import { PublicKey } from "@solana/web3.js";

const adapter = new SolanaChainAdapter({
  node: {
    id: "sol-devnet",
    chainKind: "solana",
    chainId: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    programs: {
      soothAmm: "SoothAMM11111111111111111111111111111111111",
      soothMarket: "SoothMkt11111111111111111111111111111111111",
    },
  },
});

const marketRef = encodePubkeyRef(new PublicKey("…"));
const snap = await adapter.readSnapshot(marketRef);
console.log(snap.market.qYes, snap.market.qNo, snap.market.b);
```

## Building / testing locally

```sh
pnpm install                               # from repo root
pnpm -F @sooth/sdk-solana build            # tsc compile
pnpm -F @sooth/sdk-solana test             # vitest, including bankrun smoke test
```

The smoke / sell / claim / create-market / submit-failure tests boot `litesvm`, deploy all three Sooth programs from `target/deploy/`, hand-build the Market + AmmState fixtures, and exercise the corresponding adapter methods against a fresh USDC mint. Full 29-spec suite runs in <5s on a developer laptop. See `tests/fixtures/setup.ts` for the fixture layer.

## Layout

```
packages/sdk-solana/                # workspace member of sooth-solana monorepo
├── README.md                       # this file
├── docs/
│   ├── integrator-contract.md      # third-party-facing frozen surface (CANONICAL)
│   └── implementation-guide.md     # SDK-author implementation guide
├── package.json                    # name: "@sooth/sdk-solana"
├── tsconfig.json
├── src/
│   ├── adapter.ts                  # implements ChainAdapter (vendored at top of types.ts)
│   ├── anchor/                     # generated IDL types from ../programs-core/target/idl/
│   ├── math/                       # LMSR closed-form port of _spikes/lmsr-cu
│   ├── pdas.ts                     # PDA derivation helpers
│   ├── refs.ts                     # AddressRef / MarketRef encode-decode
│   ├── errors.ts                   # SoothError taxonomy
│   ├── types.ts                    # vendored ChainAdapter contract (replace at upstream Phase A)
│   └── index.ts                    # public surface
└── tests/                          # vitest suite (litesvm-backed); 29 specs across
    ├── smoke.test.ts               #   buy / sell / claim / create-market / submit-failure /
    ├── sell-flow.test.ts           #   plus the LMSR closed-form port.
    ├── claim-flow.test.ts
    ├── create-market.test.ts
    ├── submit-failure.test.ts
    ├── lmsr.test.ts
    └── fixtures/                   # litesvm boot, USDC mint, fixture seeding
```

Orderbook (`buildOrderbook*`) and Address-Lookup-Table / matcher-wasm modules are absent because the CLOB program (`sooth_book`) hasn't landed — see programs-core/docs/architecture.md §6.

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
