# @sooth/sdk-solana

> Solana adapter for `@sooth/sdk` — workspace member of the `sooth-solana` monorepo.
> Published to npm as `@sooth/sdk-solana`. Loaded dynamically by `@sooth/sdk` (in `sooth-alpha`) when the active node is a Solana node.
> Status: AMM (buy / sell / claim / dismiss / refund), complete-set (mint / merge / redeem), LP redemption, operator (request_lock / attest_outcome), `create_market`, `readGraduationProgress`, and `preflight` (simulate-before-sign) all wired end-to-end. 49-spec vitest suite green on `litesvm` covering smoke / sell / claim / refund / LP redemption / graduation-progress / complete-set / redeem-request / operator-request / create-market / submit-failure / preflight / per-program error-classifier / LMSR. Orderbook (`buildOrderbook*`) still throws `NotImplemented` — gated on `sooth_book` (spike P1).

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

**Four programs fully wired.** `SolanaChainAdapter` covers the AMM, complete-set, operator-attestation, and launchpad flows end-to-end (read state, build tx, sign+submit, read back). A 49-spec vitest suite runs against `litesvm` in ~5s.

What's real today:

- `readSnapshot(market, user?)` — Market PDA + AmmState PDA + Position PDA
- `readSnapshots(markets[])` — batched `readSnapshot` for portfolio paths
- `readQuote(market, outcome, deltaShares)` — off-chain LMSR cost (TS port mirrors `_spikes/lmsr-cu`)
- `readPosition(market, user)`
- `readGraduationProgress(market)` — `AmmState.fee_b_base_wad` vs `b * ln(2)` graduation threshold
- `readAdjudicator(market)` — `Adjudicator` PDA fetch (authority + flags) for operator-console gating
- `readPendingUnlocks(market, user)` — enumerate matured `LockEntry` PDAs to drive the claim panel
- `buildTrade(market, args)` for `side: "buy"`
- `buildSell(market, args)` — `sooth_amm::sell_positions` + lock-on-sell `LockEntry` PDA init
- `buildClaim(market, args)` — dispatches on `args.kind`:
  - `"unlock"` (default): `sooth_amm::claim_unlocked` against a matured `LockEntry`
  - `"redeem"`: `sooth_market::redeem` against the resolved outcome (post-settlement)
- `buildClaimRefund(market, args)` — `sooth_market::claim_refund` for dismissed-market AMM Position refunds
- `buildDismissMarket(market, args)` — `sooth_amm::dismiss_market` creator-only dismissal after trial expiry
- `buildRedeemLp(market, args)` — `sooth_launchpad::redeem_lp` post-graduation LP burn for pro-rata USDC yield
- `buildMintCompleteSet(market, args)` / `buildMergeCompleteSet(market, args)` — `sooth_market::mint_complete_set` / `merge_complete_set` for 1 USDC ↔ (1 YES + 1 NO) round-trips
- `buildRequestLock(market, args)` / `buildAttestOutcome(market, args)` — `sooth_adjudicator::request_lock` / `attest_outcome` (operator path; signer must be `Adjudicator.authority`)
- `buildCreateMarket(args)` — `sooth_launchpad::create_market` composes the four-leg init flow via CPI
- `submit(req, signer)` — reconstructs the tx from `req.meta`, attaches a fresh blockhash on each attempt, signs + sends + confirms with bounded retry on transient `BlockhashNotFound`. Returns 1–5 receipts per the integrator contract.
- `preflight(req)` — mirrors `submit`'s tx construction and runs `simulateTransaction` so the consumer sees `unitsConsumed` + a typed `SoothError` before the user is asked to sign.

What still throws `SoothError({ kind: "NotImplemented" })`:

- `buildOrderbook{Buy,Sell,Cancel}` — gated on the `sooth_book` program (spike P1, see programs-core/docs/architecture.md §6)
- `readPortfolio`, `subscribeMarketEvents`, `subscribePositionEvents`, `getCollateralBalance`, `buildApprove`
- `buildTrade({ side: "sell" })` — deliberate; throws with a "use buildSell()" hint. The SDK split mirrors the on-chain ix split (Wave 1A landed `sell_positions` separate from `trade_positions`).

The ChainAdapter interface and supporting types are **vendored** at the top of `src/types.ts` with a `// VENDORED — replace with @sooth/sdk@0.3.0` comment. When upstream Phase A ships, replace the vendored types with the upstream import; the swap is mechanical.

### Completed gating items

- [x] Phase A refactor of existing `@sooth/sdk` to extract the `ChainAdapter` interface — **vendored locally** until upstream lands
- [x] LMSR CU spike — `trade_positions` benches at ~70k CU (well inside 300k budget)

### Still gating production rollout

1. The `sooth-core-solana` design landing on a final orderbook strategy (custom build vs Monaco fork)
2. Real upstream `@sooth/sdk@0.3.0` shipping the canonical ChainAdapter

See [`docs/implementation-guide.md §8`](./docs/implementation-guide.md) for the two-phase migration plan.

## Quick usage

### Read-only

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
      soothLaunchpad: "SoothLp1111111111111111111111111111111111111",
      soothAdjudicator: "SoothAdj111111111111111111111111111111111111",
    },
  },
});

const marketRef = encodePubkeyRef(new PublicKey("…"));
const snap = await adapter.readSnapshot(marketRef);
console.log(snap.market.qYes, snap.market.qNo, snap.market.b);
```

### Build → preflight → submit (wallet adapter)

`SoothRequest.meta` carries an unsigned ix payload that `submit()` (and
`preflight()`) reconstruct on each attempt with a fresh blockhash — the build
methods are pure, so callers can re-quote and re-simulate without rebuilding
state. `submit()` accepts any signer that can produce a `SignatureBytes` for
a `MessageBytes` blob; below uses `@solana/wallet-adapter-react`.

```ts
import { useWallet } from "@solana/wallet-adapter-react";
import { encodePubkeyRef, encodeAddressRef } from "@sooth/sdk-solana";

const wallet = useWallet();

// 1. Build (no network round-trip beyond what readSnapshot needed).
const req = await adapter.buildTrade(marketRef, {
  side: "buy",
  outcome: "yes",
  deltaShares: 5n * 10n ** 18n, // 5 YES at WAD
  maxCost: 5_000_000n, // 5 USDC ceiling (USDC mint = 6 decimals)
  user: encodeAddressRef(wallet.publicKey!),
});

// 2. Simulate before asking the user to sign — surfaces compute usage and
//    typed ProgramError before the wallet popup.
const sim = await adapter.preflight(req);
if (!sim.ok) throw sim.error;

// 3. Sign + send + confirm. The signer takes the message bytes the SDK builds
//    for each retry attempt, not the raw `req`.
const receipt = await adapter.submit(req, {
  publicKey: wallet.publicKey!.toBase58(),
  signMessageBytes: async (msg) => {
    const tx = Transaction.from(msg); // construct a v0 / legacy tx wrapper
    const signed = await wallet.signTransaction!(tx);
    return signed.signature!;
  },
});
console.log("submitted in", receipt.attempts, "attempts");
```

`buildSell`, `buildClaim`, `buildClaimRefund`, `buildDismissMarket`,
`buildRedeemLp`, `buildMintCompleteSet`, `buildMergeCompleteSet`,
`buildRequestLock`, `buildAttestOutcome`, and `buildCreateMarket` follow the
same shape — only the `args` differ.

### SoothRequest meta shape

`req.meta` is the unsigned ix payload the adapter rebuilds on each `submit` /
`preflight` attempt. It is intentionally serializable so callers can ship it
across worker boundaries:

```ts
type SoothRequestMeta = {
  ixData: string; // base64 ix data
  ixKeys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  ixProgramId: string; // base58
  userPk: string; // base58 — fee payer + first signer
  preIxs?: Array<{
    // prepended verbatim under each fresh blockhash;
    programId: string; //   used by buildTrade for the user_lp_ata
    keys: Array<{
      //   create-or-no-op (architecture §4.2)
      pubkey: string;
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: string; // base64
  }>;
};
```

## Building / testing locally

```sh
pnpm install                               # from repo root
pnpm -F @sooth/sdk-solana build            # tsc compile
pnpm -F @sooth/sdk-solana test             # vitest (litesvm-backed)
```

Tests boot `litesvm`, deploy all four Sooth programs from `target/deploy/`,
hand-build the Market + AmmState + Adjudicator fixtures, and exercise the
adapter methods against a fresh USDC mint. The 49-spec suite runs in ~5s on
a developer laptop. See `tests/fixtures/setup.ts` for the fixture layer.

> **Build-step gotcha:** the demo and any consumer ESM caller import from
> `dist/`. After editing `src/`, run `pnpm -F @sooth/sdk-solana build` (or
> `pnpm -r build`) before reloading the dapp — vitest hits `src/` directly,
> but the bundled consumer does not.

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
└── tests/                          # vitest suite (litesvm-backed); 49 specs across 15 files
    ├── smoke.test.ts               #   AMM buy round-trip
    ├── sell-flow.test.ts           #   sell_positions + LockEntry init
    ├── claim-flow.test.ts          #   claim_unlocked against matured LockEntry
    ├── claim-refund-flow.test.ts   #   dismissed-market claim_refund
    ├── complete-set.test.ts        #   mint_complete_set + merge_complete_set
    ├── dismiss-flow.test.ts        #   dismiss_market positive + pre-trial rejection
    ├── read-graduation.test.ts     #   readGraduationProgress accumulator view
    ├── redeem-lp-flow.test.ts      #   redeem_lp pro-rata yield payout
    ├── redeem-request.test.ts      #   buildClaim({kind:"redeem"}) request shape
    ├── operator-request.test.ts    #   request_lock + attest_outcome shapes
    ├── create-market.test.ts       #   launchpad four-leg CPI
    ├── submit-failure.test.ts      #   bounded retry on BlockhashNotFound
    ├── preflight.test.ts           #   simulate-before-sign happy + error paths
    ├── error-classifier.test.ts    #   per-program Anchor error disambiguation
    ├── lmsr.test.ts                #   LMSR closed-form port parity
    └── fixtures/                   #   litesvm boot, USDC mint, fixture seeding
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
