# Sooth SDK — Integrator Compatibility Contract

> Canonical, third-party-facing spec for `@sooth/sdk` cross-chain compatibility.
> Audience: external developers building on Sooth (frontends, market aggregators, Telegram bots, portfolio trackers, indexer mirrors).
> Companion docs: `./implementation-guide.md` (SDK-author implementation guide), `../../programs-core/docs/architecture.md` (Solana program design).
> Status: design spec — frozen surface defined, implementation gated by Phase A refactor.
> Updated 2026-05-05.

---

## §1. Purpose & Audience

This is the contract that `@sooth/sdk` makes to anyone building on top of it. If you are integrating Sooth into a frontend, an automated trading bot, a market discovery aggregator, a portfolio tracker, or any other application — this doc tells you exactly what API surface you can rely on across both EVM and Solana Sooth deployments.

### The single-line guarantee

**Code written against `@sooth/sdk` runs unchanged on EVM and Solana Sooth deployments. The chain is a runtime property of the active node, not a compile-time choice.**

You write your integration once. Users on a Base Sepolia node see EVM behavior. Users on a Solana mainnet-beta node see Solana behavior. Your code does not change. There is no `if (chain === 'solana')` branch anywhere in your application.

### Audience this doc is for

- Frontend developers shipping a Sooth-powered web app
- Bot operators automating trades against Sooth markets
- Aggregator developers indexing markets across multiple Sooth nodes
- Tooling authors building portfolio trackers, P&L analyzers, market alerts
- Anyone writing TypeScript that imports from `@sooth/sdk`

### Audience this doc is NOT for

- Sooth SDK contributors (see `./implementation-guide.md` for the implementation guide)
- Sooth contract/program authors (see `../../programs-core/docs/architecture.md`)
- Operators deploying their own Sooth nodes (separate operator docs)

### Out of scope

The contract does NOT promise to abstract:

1. **Wallet UX** — Phantom popups look different from MetaMask popups. Your users see different wallet interfaces depending on the active chain. Your code is identical; their experience differs.
2. **Block time / finality** — Solana finalizes in ~400ms; EVM L2s in 2–4s. The SDK's `await client.submit(...)` resolves on finality on both chains, but the elapsed time differs. UI code may want chain-aware "confirming…" copy.
3. **Fee currency** — gas in ETH/HYPE/MON on EVM, SOL fees + USDC priority fees on Solana. The SDK exposes a normalized `feeUsd` estimate for display; raw "gas: X wei" displays must accept that the underlying unit changes.

These are physical differences. They surface in the user's wallet and in the units of fee data, not in your code.

---

## §2. The Three Categories of Difference

Every difference between EVM and Solana behavior falls into one of three buckets. Two are tolerable and one is forbidden.

### Hidden — integrators never encounter

These vary internally but are completely invisible from outside `@sooth/sdk`:

- Internal LOC count and repo split (the SDK's `evm/` and `solana/` subdirectories — never importable by you)
- Underlying program implementation (Monaco fork vs custom Anchor program vs Phoenix CPI integration)
- Transaction submission mechanism (viem `writeContract` vs Anchor `program.methods.x().rpc()`)
- Wallet adapter wiring (the SDK accepts a uniform `SignerRef` and routes internally)
- Account model details (PDA derivation, ALT management, retry-on-race logic)

You can ignore all of this. If you find yourself needing to know any of it, the SDK has failed its contract — file an issue.

### Additive — opt-in observability

These are new fields/variants present on Solana but absent on EVM. They never break existing code; they exist for integrators who want telemetry:

- **`SubmitReceipt.attempts?: number`** — present on Solana when client-driven matching retried; absent (or always `1`) on EVM. Ignoring this field gives identical behavior on both chains.
- **`SoothError.kind = "BookMoved"`** — only ever raised by Solana when an orderbook trade lost a race against a concurrent fill. Integrators using exhaustive switches over `SoothError.kind` get a compile-time prompt to handle it (typically: retry transparently or show "market moved, please try again"). Integrators using untyped `try/catch` see a typed error like any other.

These additions are SemVer-minor. Adding more such variants over time is permitted without a major-version bump.

### Disqualifying — explicitly forbidden

The contract forbids any of these from leaking through. If you observe one, the SDK is non-compliant:

- **Different function names per chain** — no `placeOrderEVM` / `placeOrderSolana` split. One name, one signature, two implementations underneath.
- **Different argument shapes** — `tick: number` means the same thing on both chains. No `tick` on EVM and `priceOdds` on Solana.
- **Different return shapes** — receipts have a unified `txId: string` field (chain-prefixed). No `txHash` on EVM and `signature` on Solana at the type level.
- **Different error taxonomies** — chain-specific error types do NOT escape. Everything funnels into the `SoothError` union.
- **Different async semantics** — `await client.submit(...)` resolves on finality on both chains. EVM-style "resolves on broadcast, separate `wait()` for confirmation" patterns are normalized away.
- **Chain branching in user code** — if the contract requires you to write `if (node.chainKind === 'solana') { ... } else { ... }` to handle a normal flow, the contract is broken. The only legitimate use of `chainKind` in user code is for chain-specific UX flourishes (different wallet logos, different explorer URLs).

---

## §3. The Integrator Surface — Complete Symbol Inventory

This is the frozen public API. Roughly 35 symbols. Every row carries a contract guarantee — what is identical, what is allowed to differ additively, and what is internal.

> **Frozen** in the rightmost column means: signature changes require a major version bump and a 6-month deprecation window. **Additive-OK** means new optional fields or variants are permitted (SemVer-minor).

### Client factory

| Symbol                        | Kind | Signature                                   | Behavior                                                     | Frozen? |
| ----------------------------- | ---- | ------------------------------------------- | ------------------------------------------------------------ | ------- |
| `createSoothClient`           | fn   | `(opts: SoothClientOptions) => SoothClient` | Synchronous. Picks adapter based on `opts.node.chainKind`.   | Frozen  |
| `createSoothClientFromNodeId` | fn   | `(nodeId: string) => Promise<SoothClient>`  | Resolves node from registry, then calls `createSoothClient`. | Frozen  |

### React hooks (all live under `@sooth/sdk/react`)

All hooks return a TanStack-Query-compatible result object: `{ data, isLoading, isError, error, refetch }`. Mutation hooks additionally expose `{ mutate, mutateAsync, isPending, reset }`.

| Symbol           | Signature                                                                    | Behavior                                            | Frozen? |
| ---------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- | ------- |
| `useMarketInfo`  | `(market: MarketRef) => QueryResult<MarketInfo>`                             | Single-market snapshot read                         | Frozen  |
| `useMarkets`     | `(filter?: MarketFilter) => QueryResult<MarketInfo[]>`                       | List markets, optionally filtered                   | Frozen  |
| `usePosition`    | `(market: MarketRef, user?: AddressRef) => QueryResult<Position>`            | User's position on one market                       | Frozen  |
| `usePositions`   | `(markets: MarketRef[], user?: AddressRef) => QueryResult<Position[]>`       | Batch position read                                 | Frozen  |
| `usePortfolio`   | `(user?: AddressRef) => QueryResult<Portfolio>`                              | Aggregated holdings + LP + locks                    | Frozen  |
| `useTrade`       | `(market: MarketRef) => MutationResult<TradeArgs, SubmitReceipt>`            | AMM trade (LMSR side)                               | Frozen  |
| `useOrderbook`   | `(market: MarketRef) => MutationResult<OrderArgs, SubmitReceipt>`            | CLOB place/cancel/mint/merge dispatcher             | Frozen  |
| `useClaim`       | `(market: MarketRef) => MutationResult<ClaimArgs, SubmitReceipt>`            | Settlement redemption                               | Frozen  |
| `useCancelOrder` | `(market: MarketRef) => MutationResult<{ orderId: string }, SubmitReceipt>`  | Cancel a specific order                             | Frozen  |
| `useSoothQuote`  | `(market: MarketRef, args: QuoteArgs) => QueryResult<TradeQuote>`            | AMM quote (cost/fee/impact)                         | Frozen  |
| `useApproval`    | `(spender: AddressRef) => MutationResult<{ amount: bigint }, SubmitReceipt>` | Collateral approval (EVM) / SPL delegation (Solana) | Frozen  |

### Builder functions

For integrators not using React, the underlying builders are exported. They return `SoothRequest` objects suitable for passing to `client.submit`.

| Symbol                            | Signature                                                    | Frozen?                   |
| --------------------------------- | ------------------------------------------------------------ | ------------------------- | ------ |
| `buildTradeRequest`               | `(client, market, args: TradeArgs) => Promise<SoothRequest>` | Frozen                    |
| `buildSoothBookBuyRequest`        | `(client, market, args: BuyArgs) => Promise<SoothRequest>`   | Frozen                    |
| `buildSoothBookSellRequest`       | `(client, market, args: SellArgs) => Promise<SoothRequest>`  | Frozen                    |
| `buildClaimRequest`               | `(client, market, args: ClaimArgs) => Promise<SoothRequest>` | Frozen                    |
| `buildSoothBookCancelByIdRequest` | `(client, orderId: string) => Promise<SoothRequest>`         | Frozen                    |
| `computeSoothBookMaxCost`         | `(args: BuyArgs) => bigint`                                  | Pure math; no chain calls | Frozen |

### Submission and subscriptions (via `SoothClient`)

| Symbol                           | Signature                                                                | Behavior                     | Frozen? |
| -------------------------------- | ------------------------------------------------------------------------ | ---------------------------- | ------- |
| `client.submit`                  | `(req: SoothRequest, signer: SignerRef) => Promise<SubmitReceipt>`       | Resolves on finality         | Frozen  |
| `client.preflight`               | `(req: SoothRequest) => Promise<PreflightResult>`                        | Simulates without submitting | Frozen  |
| `client.subscribeMarketEvents`   | `(market: MarketRef, handler: (e: MarketEvent) => void) => Unsubscribe`  | Live event feed              | Frozen  |
| `client.subscribePositionEvents` | `(user: AddressRef, handler: (e: PositionEvent) => void) => Unsubscribe` | Live position feed           | Frozen  |

### Types

| Symbol            | Shape                                                                                                                                                                                    | Frozen?     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `MarketInfo`      | `{ market: MarketRef, question: string, deadline: bigint, isLive: boolean, isSettled: boolean, outcome?: 0 \| 1 \| 2, qYes: bigint, qNo: bigint, b: bigint, isGraduated: boolean, ... }` | Additive-OK |
| `Position`        | `{ yesShares: bigint, noShares: bigint, lockedYes?: bigint, lockedNo?: bigint, unlockableAt?: bigint }`                                                                                  | Additive-OK |
| `Order`           | `{ id: string, market: MarketRef, side: 0 \| 1, tick: number, amount: bigint, escrow: boolean, status: "active" \| "filled" \| "cancelled", maker: AddressRef }`                         | Additive-OK |
| `Fill`            | `{ orderId: string, taker: AddressRef, maker: AddressRef, takerSide: 0 \| 1, yesTick: number, noTick: number, amount: bigint, surplus: bigint, timestamp: bigint }`                      | Additive-OK |
| `TradeQuote`      | `{ cost: bigint, fee: bigint, netCost: bigint, newYesPrice: bigint, priceImpact: bigint }`                                                                                               | Additive-OK |
| `SubmitReceipt`   | `{ txId: string, confirmedAt: bigint, fills: Fill[], attempts?: number }`                                                                                                                | Additive-OK |
| `PreflightResult` | `{ ok: boolean, error?: SoothError, gasEstimate?: bigint, feeUsd?: number }`                                                                                                             | Additive-OK |
| `SoothError`      | tagged union (see §3 sub-table below)                                                                                                                                                    | Additive-OK |
| `MarketRef`       | `string` (opaque chain-prefixed identifier)                                                                                                                                              | Frozen      |
| `SignerRef`       | `EVMSigner \| SolanaSigner` (the SDK accepts both; integrators pass whichever their wallet provides)                                                                                     | Frozen      |
| `MarketEvent`     | tagged union: `OrderPlaced \| OrderFilled \| OrderCancelled \| Minted \| Merged \| MarketResolved \| MarketSettled`                                                                      | Additive-OK |

### `SoothError` variants

| `kind`                 | Fields                              | Raised on                |
| ---------------------- | ----------------------------------- | ------------------------ |
| `InsufficientShares`   | `needed: bigint, available: bigint` | Both chains              |
| `OrderNotActive`       | `orderId: string`                   | Both chains              |
| `MarketNotActive`      | `market: MarketRef`                 | Both chains              |
| `InvalidTick`          | `tick: number`                      | Both chains              |
| `SlippageExceeded`     | `expected: bigint, actual: bigint`  | Both chains              |
| `InsufficientApproval` | `needed: bigint, available: bigint` | Both chains              |
| `BookMoved`            | `attempt: number`                   | Solana only (race retry) |
| `Reverted`             | `reason: string`                    | EVM fallback             |
| `ProgramError`         | `code: number, msg: string`         | Solana fallback          |

### Constants

| Symbol        | Value                                    | Notes                     |
| ------------- | ---------------------------------------- | ------------------------- |
| `OUTCOME`     | `{ NO: 0, YES: 1, INVALID: 2 } as const` | Protocol-wide canonical   |
| `WAD`         | `1_000_000_000_000_000_000n` (1e18)      | Internal precision        |
| `MAX_UINT256` | `2n ** 256n - 1n`                        | EVM origin; valid on both |
| `MIN_TICK`    | `1`                                      | Inclusive                 |
| `MAX_TICK`    | `999`                                    | Inclusive                 |
| `NUM_TICKS`   | `1000`                                   | Tick space size           |

### Utilities

| Symbol               | Signature                                      | Notes                                 |
| -------------------- | ---------------------------------------------- | ------------------------------------- |
| `formatWad`          | `(value: bigint, decimals?: number) => string` | Pure math                             |
| `parseWad`           | `(value: string \| number) => bigint`          | Pure math                             |
| `shortAddress`       | `(addr: AddressRef) => string`                 | Display helper                        |
| `computeMarketKey`   | `(market: AddressRef) => string`               | Deterministic; chain-aware internally |
| `classifyTradeError` | `(err: unknown) => SoothError`                 | Normalizes thrown errors              |

---

## §4. The 8-Point Integrator Checklist

Concrete tests an integrator can run on their own code to confirm SDK-compat compliance.

### 1. Install one package

✅ Pass: `pnpm add @sooth/sdk`

❌ Fail: `pnpm add @sooth/sdk-evm` or `pnpm add @sooth/sdk-solana`

There are no per-chain packages. Both backends ship in one package with the Solana adapter being tree-shakeable.

### 2. Import from one path

✅ Pass:

```ts
import { createSoothClient, OUTCOME } from "@sooth/sdk";
import { useTrade } from "@sooth/sdk/react";
```

❌ Fail:

```ts
import { evmClient } from "@sooth/sdk/evm";
import { solanaClient } from "@sooth/sdk/solana";
```

Sub-paths under `@sooth/sdk/evm/*` and `@sooth/sdk/solana/*` are SDK-internal and not part of the contract.

### 3. Discover chain via registry, not at compile time

✅ Pass:

```ts
const node = await registry.getNodeById(activeNodeId);
const client = createSoothClient({ node });
```

❌ Fail:

```ts
const client = isProduction
  ? createSoothClient({ chain: "evm" })
  : createSoothClient({ chain: "solana" });
```

The chain is a property of the node, discovered at runtime. Integrators do not select chains at build time.

### 4. Use one wallet abstraction

✅ Pass:

```ts
// EVM user — wagmi signer
const signer = useSigner(); // from your wallet provider
await client.submit(req, signer);

// Solana user — same code
const signer = useSolanaSigner(); // from wallet-adapter
await client.submit(req, signer);
```

❌ Fail:

```ts
if (node.chainKind === "evm") {
  await client.submitEVM(req, viemSigner);
} else {
  await client.submitSolana(req, anchorSigner);
}
```

`client.submit` accepts both signer shapes via the `SignerRef` union. Integrators pass whichever their wallet provider yields.

### 5. Handle one error union

✅ Pass:

```ts
try {
  await placeOrder(args);
} catch (e) {
  const err = classifyTradeError(e);
  switch (err.kind) {
    case "InsufficientShares":
      return showInsufficientToast();
    case "BookMoved":
      return retry(); // Solana-only, OK to handle
    default:
      return showGenericError(err);
  }
}
```

❌ Fail:

```ts
try { ... } catch (e) {
  if (e instanceof ViemContractRevertError) { ... }
  else if (e instanceof AnchorError) { ... }
}
```

Chain-specific error types do not escape. Everything funnels through `SoothError`.

### 6. Read one event stream

✅ Pass:

```ts
const unsubscribe = client.subscribeMarketEvents(market, (e) => {
  if (e.kind === "OrderFilled") {
    appendToFeed({ taker: e.taker, amount: e.amount });
  }
});
```

The `MarketEvent` shape is identical from either chain. Underlying source (EVM logs, Solana program logs, indexer webhook) is hidden.

### 7. Get one type for everything

✅ Pass:

```ts
function renderMarket(info: MarketInfo) { ... }
```

Works for both EVM and Solana market data. There is no `EVMMarketInfo` / `SolanaMarketInfo` split.

### 8. Bundle artifact is tree-shakeable

If your build only ever connects to EVM nodes (e.g. you're shipping a chain-restricted frontend), the Solana wasm matcher and Anchor IDL JSON should not appear in your final bundle. Modern bundlers (Vite, esbuild, webpack 5) achieve this via dynamic `import()` on the adapter selection path.

✅ Pass: bundling an EVM-only app produces a bundle <50KB larger than today's `@sooth/sdk` build.

❌ Fail: every `@sooth/sdk` consumer ships ~500KB of Solana matcher wasm regardless of usage.

---

## §5. What Cannot Be Made Identical (Honest Constraints)

Three things the contract does not abstract. Knowing what's deliberately _not_ normalized is as important as knowing what is.

### Wallet UX

The SDK normalizes the **programmatic** interface (your code calls `client.submit(req, signer)`), but the **user-facing** wallet popup is still rendered by Phantom or MetaMask or whichever wallet your user is on. Solana wallets show transaction simulation differently from EVM wallets. SOL fees show up in different units from gas.

If your application surfaces a transaction-preview UI of your own (not relying on the wallet's preview), you may want to use `client.preflight(req)` and render `feeUsd` rather than the chain-native unit.

### Block time and finality

`await client.submit(...)` resolves on finality on both chains. On Solana that's typically <1s; on EVM L2s it's 2–4s. Your application's perceived latency differs accordingly.

If you have animations like "Confirming transaction…" that include a progress bar, you may want to tune the expected duration based on `node.chainKind`. This is a UI flourish, not a code branch on the contract.

### Fee currency

Sooth contracts charge fees in the collateral currency (USDC) — that's normalized. But the _transaction_ fee charged by the underlying chain (gas on EVM, SOL + priority fees on Solana) is paid in the chain's native token. The SDK's `PreflightResult.feeUsd` normalizes this for display; if you choose to surface raw fees ("0.0003 ETH" or "0.000005 SOL") you accept that the unit changes.

---

## §6. Borderline Behaviors That Need Explicit Documentation

Three places where the SDK contract holds but the underlying differences are user-observable.

### Race retries on Solana

On Solana, the SoothBook orderbook's matching may be client-driven (the SDK enumerates likely fills off-chain and includes them in the transaction). If a concurrent trade fills against the same orders between read and submit, the program rejects with `BookMoved` and the SDK retries automatically.

**Contract guarantee**: `await client.submit(...)` resolves with a successful receipt OR a final error after retries are exhausted. Integrators do not write retry loops themselves.

**Observable**: the resolved `SubmitReceipt.attempts` field reports the retry count. Integrators with hard-coded UI timeouts (e.g. "fail UI if no receipt in 3 seconds") may need to bump them. The SDK targets <5% retry rate in steady state; if production observes higher, file an issue.

### Escrow atomicity is a hard SDK invariant

`buildSoothBookBuyRequest({ escrow: true })` debits opposite-side shares to use as collateral, attempts to match, and refunds the opposite shares on cancel/dust. The contract requires this entire sequence to be **atomic** — either it all happens, or none of it happens.

**The choice of underlying Solana program backend MUST honor this.** Custom-built `sooth_book` and Monaco-fork-based programs both can; Phoenix and OpenBook v2 integrations cannot (escrow becomes a multi-transaction sequence with intermediate states). Therefore, regardless of which Solana orderbook backend ends up shipping, escrow atomicity is the gating invariant.

If you observe non-atomic escrow on any Sooth deployment, the SDK is non-compliant with the contract. File an issue.

### Tick quantization risk

Sooth's protocol model uses 1000 discrete ticks. If a future Solana orderbook backend uses fewer effective price levels (Monaco's default is 30 per side; some forks may use 100), the SDK adapter will round your `tick: number` argument to the nearest active level.

**Contract guarantee**: rounding is deterministic, documented, and observable. If your `tick: 600` rounds to `tick: 605` due to backend quantization, the resulting `SubmitReceipt` reports the actual tick used. You can detect rounding by comparing `request.tick` vs `receipt.actualTick` (where `receipt.actualTick` is an additive-OK field present only when rounding occurred).

For most integrators this is invisible. For high-frequency market-makers who price to 0.1% precision, this matters — consult the active node's `node.tickResolution` field (additive-OK) to know the effective tick granularity.

---

## §7. Versioning & Backward Compatibility Policy

`@sooth/sdk` follows SemVer.

| Change                                                       | Version bump                           |
| ------------------------------------------------------------ | -------------------------------------- |
| Add a new contract symbol                                    | minor                                  |
| Add an optional field to an existing type                    | minor                                  |
| Add a new variant to a tagged union (e.g. `SoothError.kind`) | minor                                  |
| Add a new chain backend (e.g. Solana support)                | minor — opt-in via registry            |
| Change the signature of a frozen contract symbol             | **major + 6-month deprecation window** |
| Remove a frozen contract symbol                              | **major + 6-month deprecation window** |
| Internal refactor with no contract surface change            | patch                                  |

### Deprecation policy

When a frozen symbol is slated for removal:

1. The next minor release marks it `@deprecated` in TypeScript and prints a one-time runtime warning when first used.
2. The deprecation notice references the replacement symbol (always present before removal).
3. The symbol is removed only in the _next_ major release after the 6-month window.
4. Removed symbols are logged in the changelog with a migration snippet.

### What's NOT versioned

- The internal `evm/` and `solana/` adapter implementations may change in any release without bumping major. They are not part of the contract.
- The set of supported nodes (registry contents) changes via `@sooth/registry` versioning, separate from the SDK.

---

## §8. Reference Implementation Snippets

Three end-to-end snippets. **Each is byte-identical regardless of whether the active node is EVM or Solana.** If you copy one of these into a project that swaps between chains, no part of the snippet should change.

### Snippet 1: Build a market list page

```tsx
import { useMarkets, formatWad, OUTCOME } from "@sooth/sdk";

export function MarketList() {
  const { data: markets, isLoading, error } = useMarkets({ isLive: true });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBanner error={error} />;

  return (
    <ul>
      {markets.map((m) => (
        <li key={m.market}>
          <h3>{m.question}</h3>
          <p>YES probability: {formatProbability(m.qYes, m.qNo)}</p>
          <p>
            Deadline: {new Date(Number(m.deadline) * 1000).toLocaleString()}
          </p>
        </li>
      ))}
    </ul>
  );
}

function formatProbability(qYes: bigint, qNo: bigint): string {
  // Pure math, identical on both chains
  const total = qYes + qNo;
  if (total === 0n) return "—";
  return `${Number((qYes * 10000n) / total) / 100}%`;
}
```

### Snippet 2: Place an orderbook trade

```tsx
import {
  useOrderbook,
  computeSoothBookMaxCost,
  classifyTradeError,
  OUTCOME,
  parseWad,
} from "@sooth/sdk";

export function BuyButton({ market }: { market: MarketRef }) {
  const orderbook = useOrderbook(market);

  const handleBuy = async () => {
    try {
      const args = {
        side: OUTCOME.YES,
        tick: 600,
        amount: parseWad("100"),
        escrow: false,
        matchLimit: 100,
      };
      const maxCost = computeSoothBookMaxCost(args);

      const receipt = await orderbook.mutateAsync({ ...args, maxCost });

      // attempts may be present on Solana; ignore safely on EVM
      console.log(
        `Filled in ${receipt.attempts ?? 1} attempt(s):`,
        receipt.fills,
      );
    } catch (e) {
      const err = classifyTradeError(e);
      switch (err.kind) {
        case "InsufficientShares":
          return alert(`Need ${err.needed}, have ${err.available}`);
        case "BookMoved":
          return alert("Market moved, please retry");
        case "SlippageExceeded":
          return alert(`Price moved past your limit`);
        default:
          return alert(`Trade failed: ${JSON.stringify(err)}`);
      }
    }
  };

  return <button onClick={handleBuy}>Buy YES</button>;
}
```

### Snippet 3: Subscribe to fills for a market

```tsx
import { useEffect, useState } from "react";
import { createSoothClient, type Fill, type MarketRef } from "@sooth/sdk";

export function FillFeed({
  client,
  market,
}: {
  client: ReturnType<typeof createSoothClient>;
  market: MarketRef;
}) {
  const [fills, setFills] = useState<Fill[]>([]);

  useEffect(() => {
    const unsubscribe = client.subscribeMarketEvents(market, (event) => {
      if (event.kind === "OrderFilled") {
        setFills((prev) => [event, ...prev].slice(0, 50));
      }
    });
    return unsubscribe;
  }, [client, market]);

  return (
    <ul>
      {fills.map((f) => (
        <li key={`${f.orderId}-${f.timestamp}`}>
          {new Date(Number(f.timestamp) * 1000).toLocaleTimeString()} —{" "}
          {f.takerSide === 1 ? "YES" : "NO"} × {f.amount.toString()} (surplus:{" "}
          {f.surplus.toString()})
        </li>
      ))}
    </ul>
  );
}
```

---

## §9. How This Contract Is Implemented

Briefly, for integrators curious about what's underneath (full detail in `./implementation-guide.md`):

- All contract symbols live in `@sooth/sdk/core/*` and `@sooth/sdk/react/*`. These directories are frozen at the import-path level.
- Contract methods dispatch to a `ChainAdapter` interface (also in `core/`). The interface is SDK-internal — integrators never import it.
- Each chain (EVM via viem, Solana via Anchor) ships a `ChainAdapter` implementation under `evm/` or `solana/`. These are SDK-internal subdirectories.
- The adapter is selected at `createSoothClient` time based on `node.chainKind` from the registry.
- New chain backends ship by adding a new adapter implementation; the contract surface is unchanged.

---

## §10. Reporting Contract Violations

If you observe behavior that violates this contract — different signatures, leaked chain-specific types, non-atomic escrow, missing error variants, anything that breaks the single-line guarantee — please file an issue at the Sooth SDK repository with:

1. The contract symbol involved
2. The expected behavior per this doc
3. The observed behavior
4. A minimal reproduction (preferably with both chains compared)

Contract violations are SDK bugs, not protocol features. They are P0.

---

_Last updated: 2026-05-05. Companion docs: `./implementation-guide.md` (implementation guide), `../../programs-core/docs/architecture.md` (Solana program design)._
