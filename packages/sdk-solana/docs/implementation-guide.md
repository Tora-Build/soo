# Sooth SDK ↔ Solana Compatibility Evaluation

> Evaluation doc for porting the Sooth Protocol stack to Solana **at the SDK level**.
> Companion to `../../programs-core/docs/architecture.md` (which covers the contract layer).
> Status: design exploration. No code committed. Updated 2026-05-05.

This doc answers a single question: **can `@sooth/sdk` expose one API surface that lets app code (`apps/demo`, `apps/telegram`, `apps/market`) work unchanged against either an EVM or a Solana backend?**

Spoiler: yes, but with three load-bearing constraints. Most of the work is interface extraction inside `@sooth/sdk`, not new code.

---

## §1. Executive Summary

> **This doc is the SDK-author-facing implementation guide.** The third-party-facing **integrator contract** is the canonical source for what symbols are frozen and what guarantees are made — see `./integrator-contract.md`. This doc explains _how_ that contract is implemented underneath.

### The compatibility goal

Apps and third-party integrators must continue calling the same SDK functions with the same arguments and getting back the same return shapes regardless of whether the active node is EVM or Solana. The chain is an SDK implementation detail, not a consumer concern. This is achievable; the SDK already concentrates ~90% of its EVM coupling in three identifiable seams (`core/abis`, `core/contracts`, `core/actions`), which can be moved behind a `ChainAdapter` interface.

### The three load-bearing constraints

1. **Escrow atomicity.** SoothBook's `escrow=true` flag (debit opposite-side shares → match → credit on cancel/dust, atomically per `SoothBook.sol:421-438`) is a SoothBook-specific invariant. **Preserving it on Solana requires a custom matcher (Option A from `../../programs-core/docs/architecture.md §6`)**. Phoenix/OpenBook integration cannot deliver atomic escrow → those paths break SDK-level parity. **Decision required before any Solana SDK work begins.**
2. **Shared Rust matcher crate.** For `placeOrder` to behave identically across chains, the off-chain enumeration logic (used by the Solana adapter to construct fill arrays) and the on-chain validation logic (used by the `sooth_book` program to verify them) must be byte-identical. The only sane way to enforce that is a single Rust crate compiled to both wasm (for the SDK) and BPF (for the program). Diverging implementations create silent settlement bugs.
3. **Registry schema must accept non-numeric chain IDs.** Today `SoothNode.chainId: number` is hardcoded across `@sooth/registry` types, the registry-api worker, and the indexer's Postgres `chainId: integer` column. Solana's "chain" is a cluster (`devnet`/`mainnet-beta`), not a numeric ID. Either widen the type to `number | string` or allocate Solana-namespace integers (e.g. 900/901, the convention some bridges use). This is a one-time schema migration, not a runtime cost — but it touches every consumer of the registry.

### Reusable LOC at SDK level

Approximately **1,400 LOC** of TypeScript in `@sooth/sdk` and `@sooth/registry` is already chain-agnostic and can be reused as-is (or with one trivial extraction). Approximately **1,200 LOC** of new Solana adapter code is needed in `@sooth/sdk`, plus a **~600 LOC** Rust matcher crate. The Postgres indexer schema and Hono REST API surface are reusable verbatim — only event handlers need rewriting for Solana program logs.

### What this evaluation does NOT cover

- Implementing the Solana programs (covered in `../../programs-core/docs/architecture.md`)
- The 1-week LMSR + matcher CU spike (gating prerequisite, see `../../programs-core/docs/architecture.md §13`)
- Splitting `packages/sdk` into `core | evm | solana` directories (Phase A of §8 below)

---

## §2. The ChainAdapter Contract

The single new abstraction this whole evaluation hinges on. Every chain-coupled function currently in `@sooth/sdk/core/contracts` and `core/actions` is reframed as a method on a `ChainAdapter` interface. EVM and Solana each ship one implementation; apps and `core/*` depend only on the interface.

### Interface sketch (TypeScript)

```ts
// packages/sdk/src/core/adapter.ts (NEW)

export interface ChainAdapter {
  // Identity
  readonly node: SoothNode;
  readonly chainKind: "evm" | "solana";

  // ─── Reads (snapshots) ────────────────────────────────────────────
  readSnapshot(
    market: MarketRef,
    user?: AddressRef,
  ): Promise<SoothCoreSnapshot>;
  readSnapshots(
    markets: MarketRef[],
    user?: AddressRef,
  ): Promise<SoothCoreSnapshot[]>;
  readQuote(
    market: MarketRef,
    outcome: 0 | 1,
    deltaShares: bigint,
  ): Promise<TradeQuote>;
  readPosition(market: MarketRef, user: AddressRef): Promise<Position>;
  readPortfolio(user: AddressRef): Promise<Portfolio>;

  // ─── Writes (request builders + submitters) ───────────────────────
  // Builder pattern preserved from current SDK — apps choose to submit later
  buildTrade(market: MarketRef, args: TradeArgs): Promise<TradeRequest>;
  buildClaim(market: MarketRef, args: ClaimArgs): Promise<ClaimRequest>;
  buildOrderbookBuy(
    market: MarketRef,
    args: BuyArgs,
  ): Promise<OrderbookRequest>;
  buildOrderbookSell(
    market: MarketRef,
    args: SellArgs,
  ): Promise<OrderbookRequest>;
  buildOrderbookCancel(
    market: MarketRef,
    orderId: string,
  ): Promise<OrderbookRequest>;
  buildCreateMarket(args: CreateMarketArgs): Promise<CreateMarketRequest>;

  // Submission — chain-specific concerns hidden
  submit(req: SoothRequest, signer: SignerRef): Promise<SubmitReceipt>;
  preflight(req: SoothRequest): Promise<PreflightResult>;

  // ─── Subscriptions (event stream) ─────────────────────────────────
  subscribeMarketEvents(
    market: MarketRef,
    handler: (e: MarketEvent) => void,
  ): Unsubscribe;
  subscribePositionEvents(
    user: AddressRef,
    handler: (e: PositionEvent) => void,
  ): Unsubscribe;

  // ─── Wallet + token (collateral side) ─────────────────────────────
  getCollateralBalance(user: AddressRef): Promise<bigint>;
  buildApprove(spender: AddressRef, amount: bigint): Promise<SoothRequest>;
}
```

### Return shape normalization

| Field          | EVM                       | Solana                           | Normalized SDK shape                                 |
| -------------- | ------------------------- | -------------------------------- | ---------------------------------------------------- |
| Tx identifier  | `0x…` 32-byte hex hash    | base58 signature string          | `txId: string` (chain-prefixed: `evm:0x…` / `sol:…`) |
| Receipt timing | 1 confirmation block      | 1 finalized slot                 | `confirmedAt: bigint` (Unix ms)                      |
| Fills          | event log array           | parsed from program logs         | `fills: Fill[]` (same shape both chains)             |
| Retries        | not applicable            | up to N retries on race          | `attempts: number` (always 1 on EVM)                 |
| Errors         | revert reason or selector | Anchor error code or program log | `SoothError` enum (see below)                        |

The `attempts` field is the only **additive** change: EVM always returns `1`; Solana may return 1–5. App code that ignores it sees no behavioral change. App code that wants telemetry gets it for free.

### Error taxonomy

A unified `SoothError` enum replaces today's per-chain error decoding:

```ts
type SoothError =
  | { kind: "InsufficientShares"; needed: bigint; available: bigint }
  | { kind: "OrderNotActive"; orderId: string }
  | { kind: "MarketNotActive"; market: MarketRef }
  | { kind: "InvalidTick"; tick: number }
  | { kind: "SlippageExceeded"; expected: bigint; actual: bigint }
  | { kind: "BookMoved"; attempt: number } // Solana-only; never raised on EVM
  | { kind: "Reverted"; reason: string } // EVM fallback
  | { kind: "ProgramError"; code: number; msg: string }; // Solana fallback
```

Today's `core/errors.ts` decodes Solidity 4-byte selectors and panic codes. The Solana adapter does the equivalent for Anchor's `#[error_code]` enum. Both adapters surface the same `SoothError` variants for the same protocol-level conditions; the chain-specific fallbacks (`Reverted`, `ProgramError`) catch everything else.

### What apps see

Apps import `useTrade`, `useOrderbook`, `usePlaceOrder`, `usePosition`, `useMarketInfo` — chain-agnostic React hooks built on top of `ChainAdapter`. The adapter is selected at app startup from the active node's `chainKind`. No `if (chain === 'solana')` branches anywhere in app code.

---

## §3. Module-by-Module Inventory

This is the master compatibility table. Every package and module across the monorepo, classified.

### Coupling categories

- **AGNOSTIC** — pure logic, no chain primitives. Reuse as-is.
- **MIXED** — mostly portable; one or two EVM imports that should be abstracted into the `ChainAdapter`.
- **EVM-COUPLED** — irreducibly EVM-specific. Needs a Solana sibling under `src/solana/`.
- **EVM-ONLY (deliberate)** — chain-locked by design (HyperEVM precompile, Lens). Does not get a Solana counterpart.

### `@sooth/sdk` module table

| Module                           | Path                               | Coupling    | Reuse Strategy                                                                                                                          | Solana Work                                           |
| -------------------------------- | ---------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| LMSR math                        | `core/math/lmsr.ts`                | AGNOSTIC    | Reuse as-is                                                                                                                             | None                                                  |
| Market stats math                | `core/math/marketStats.ts`         | AGNOSTIC    | Reuse as-is                                                                                                                             | None                                                  |
| Core types                       | `core/types.ts`                    | AGNOSTIC    | Reuse as-is                                                                                                                             | None                                                  |
| WAD/format utils                 | `core/utils.ts`                    | MIXED       | Extract `wadFormatter` from viem `formatUnits` to a small internal helper; keep API identical                                           | None (utility is pure after extraction)               |
| SQF metadata                     | `lib/sqf.ts`                       | AGNOSTIC    | Reuse as-is                                                                                                                             | None                                                  |
| Registry types                   | `registry-types.ts`                | MIXED       | Widen `chainId: number` → `number \| string`; add optional `cluster` field                                                              | None (consumed identically)                           |
| Registry client                  | `registry.ts`                      | AGNOSTIC    | Reuse as-is                                                                                                                             | None                                                  |
| Action context types             | `core/actions/types.ts`            | MIXED       | Generalize `ActionContext` to depend on `ChainAdapter`, not `PublicClient`/`WalletClient`                                               | None                                                  |
| Error decoding                   | `core/errors.ts`                   | EVM-COUPLED | Refactor: keep `decodeErrorHex` as `evm/errors.ts`; add `solana/errors.ts`; both feed unified `SoothError` taxonomy in `core/errors.ts` | New: Anchor error code → `SoothError` mapping         |
| Contract reads (markets)         | `core/contracts/markets.ts`        | EVM-COUPLED | Refactor behind `ChainAdapter.readSnapshot`/`readSnapshots`                                                                             | New: Solana adapter implementations                   |
| Contract reads (AMM)             | `core/contracts/amm.ts`            | EVM-COUPLED | Refactor behind `ChainAdapter.readQuote`                                                                                                | New: Solana adapter implementations                   |
| Contract reads (portfolio)       | `core/contracts/portfolio.ts`      | EVM-COUPLED | Refactor behind `ChainAdapter.readPortfolio`                                                                                            | New: PDA-based portfolio aggregation                  |
| Contract reads (launchpad AMM)   | `core/contracts/launchpadAmm.ts`   | EVM-COUPLED | Same as above                                                                                                                           | New                                                   |
| Contract reads (sooth-core)      | `core/contracts/soothCore.ts`      | EVM-COUPLED | Refactor behind `ChainAdapter.buildTrade` / `preflight`                                                                                 | New                                                   |
| Write actions (simulate)         | `core/actions/simulate.ts`         | EVM-COUPLED | Move to `evm/actions/simulate.ts`; the simulate harness is EVM-test-bench-only                                                          | None (test-only; OK to stay EVM)                      |
| Write actions (canonical writes) | `core/actions/writes.ts`           | EVM-COUPLED | Move per-action call sites behind adapter `build*` methods; receipt parsing becomes adapter-internal                                    | New: Solana submitters + log parsing                  |
| ABIs                             | `core/abis/*`                      | EVM-COUPLED | Move to `evm/abis/` — consumed only by EVM adapter                                                                                      | New: `solana/idls/` (Anchor IDL JSON files)           |
| Megaeth chain detection          | `core/megaeth.ts`                  | EVM-ONLY    | Move to `evm/megaeth.ts`                                                                                                                | None (deliberately not ported)                        |
| Root `client.ts`                 | `client.ts`                        | EVM-COUPLED | Move to `evm/client.ts`; introduce `core/createClient` factory that picks adapter                                                       | New: `solana/client.ts` using `@coral-xyz/anchor`     |
| Root `wallet.ts`                 | `wallet.ts`                        | EVM-COUPLED | Move to `evm/wallet.ts`                                                                                                                 | New: `solana/wallet.ts` for SPL token + ATA           |
| Root `market.ts`                 | `market.ts`                        | EVM-COUPLED | Move to `evm/market.ts`                                                                                                                 | New: `solana/market.ts` (driver-level, mostly thin)   |
| Root `orderbook.ts`              | `orderbook.ts`                     | EVM-COUPLED | Move to `evm/orderbook.ts`                                                                                                              | New: `solana/orderbook.ts` with client-driven matcher |
| CLI (interactive REPL)           | `cli/interactive.ts`               | EVM-COUPLED | Stays EVM. Adding Solana parity to the multi-actor CLI is out of scope; CLI is a development harness.                                   | None (out of scope)                                   |
| CLI commands                     | `cli/commands/*`                   | EVM-COUPLED | Stays EVM                                                                                                                               | None                                                  |
| CLI actors / scenarios           | `cli/actors.ts`, `cli/scenarios/*` | EVM-COUPLED | Stays EVM                                                                                                                               | None                                                  |
| Assertions                       | `cli/assertions/invariants.ts`     | EVM-COUPLED | Stays EVM (used by CLI)                                                                                                                 | None                                                  |

### Other packages

| Package                                                 | Coupling                                 | Reuse Strategy                                                                                        | Solana Work                                                                                 |
| ------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@sooth/registry` (manifest module)                     | MIXED                                    | Schema widen (chainId, optional cluster); functions are filter-only and stay                          | One JSON-shape change + KV worker schema update                                             |
| `@sooth/indexer` (Postgres schema)                      | AGNOSTIC                                 | Reuse all 13 tables as-is; `chainId` column either widens to text or namespaces Solana to integer IDs | None (schema), but new event handlers needed                                                |
| `@sooth/indexer` (REST API)                             | AGNOSTIC                                 | Reuse all routes as-is; consumers see same shape                                                      | None                                                                                        |
| `@sooth/indexer` (event handlers)                       | EVM-COUPLED                              | Per-chain handler: today Ponder reads viem ABIs from EVM logs                                         | New: Helius/Geyser-driven handler that maps Solana program logs to the same Postgres schema |
| `@sooth/contracts-plugin` (ZkTLSAdjudicator)            | EVM-COUPLED in form, AGNOSTIC in concept | Concept ports (Primus is chain-agnostic); rewrite as Anchor program                                   | New Rust program (~200 lines equivalent)                                                    |
| `@sooth/contracts-plugin` (HyperEVM oracle adjudicator) | EVM-ONLY                                 | Stays EVM. HyperCore precompile `0x0807` has no Solana equivalent.                                    | None                                                                                        |
| `@sooth/contracts-plugin` (Lens post action)            | EVM-ONLY                                 | Stays EVM. Lens V3 is Polygon-only.                                                                   | None                                                                                        |
| `workers/registry-api`                                  | MIXED                                    | Update node submission schema for widened chainId; KV writes likewise                                 | One schema migration                                                                        |
| `workers/rpc-proxy`                                     | EVM-ONLY (proxies Ethereum JSON-RPC)     | Add a parallel Solana RPC proxy worker, **OR** route by RPC method shape inside one worker            | New: `workers/sol-rpc-proxy` (or extension)                                                 |

### Summary of new code

| Surface                                                     | Status                  | Approx LOC          |
| ----------------------------------------------------------- | ----------------------- | ------------------- |
| `ChainAdapter` interface + factory in `core/`               | New                     | ~120                |
| EVM adapter wrapping current code                           | Refactor (no new logic) | ~0 net new          |
| Solana adapter (read paths, build paths, submit, subscribe) | New                     | ~800                |
| Solana IDL wrappers + tx builders + ALT manager             | New                     | ~300                |
| Solana matcher wasm bindings (consumes Rust crate)          | New                     | ~100                |
| Solana RPC proxy worker                                     | New                     | ~150                |
| Indexer Solana event handlers                               | New                     | ~400                |
| Total new TS/JS                                             |                         | **~1,870 LOC**      |
| Rust matcher crate (BPF + wasm targets)                     | New                     | ~600                |
| Solana programs (per `../../programs-core/docs/architecture.md §1`)          | New                     | (out of scope here) |

---

## §4. Top-15 Public API — the compatibility frozen surface

> **Superseded by `./integrator-contract.md §3`.** The complete frozen-surface inventory (now ~35 symbols, including planned hooks under `core/hooks/`) lives there. The table below documents an earlier 15-symbol cut focused on what apps in this monorepo import today; consult the contract doc for the authoritative list any new code should target.

This was the original **contract** that the Solana adapter must honor exactly. These 15 exports are what the apps actually import; if they change shape, app code breaks. If they don't change shape, the chain swap is invisible.

| #   | Export                                               | Used by                     | EVM signature today                                          | Solana implementation strategy                                                                                                                                         | Return-shape change                                                                     |
| --- | ---------------------------------------------------- | --------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `readSoothCoreSnapshot(market, user?)`               | telegram (3 hooks)          | viem multicall against TruthMarket + AMMEngine + OrderEngine | Anchor `program.account.X.fetchMultiple([market_pda, amm_state_pda, position_pda])`                                                                                    | None                                                                                    |
| 2   | `readSoothCoreSnapshots(markets, user?)`             | telegram (2 hooks, freq 9×) | batched multicall                                            | batched Anchor fetchMultiple + getMultipleAccounts                                                                                                                     | None                                                                                    |
| 3   | `OUTCOME` (constant `{ NO: 0, YES: 1, INVALID: 2 }`) | telegram                    | constant                                                     | constant (identical)                                                                                                                                                   | None                                                                                    |
| 4   | `readSoothQuote(market, outcome, amount)`            | telegram                    | `AMMEngine.getPositionQuote` view call (returns 4 values)    | Solana adapter calls quote view (could be a separate `quote` instruction returning via `set_return_data`, or pure off-chain reproduction of LMSR math from `AmmState`) | None                                                                                    |
| 5   | `buildTradeRequest(market, args)`                    | telegram                    | encodes `tradePositions(...)` calldata against AMMEngine     | builds Solana `Transaction` with `trade_positions` instruction + ALT                                                                                                   | None (still returns a `SoothRequest` object)                                            |
| 6   | `buildSoothBookBuyRequest(market, args)`             | telegram                    | encodes `buyYes`/`buyNo` calldata against SoothBook          | reads book → runs shared matcher → builds Solana TX with enumerated `fills` array + maker accounts                                                                     | `attempts?: number` may appear in the resulting submit receipt; request shape unchanged |
| 7   | `buildSoothBookSellRequest(market, args)`            | telegram                    | mirror of buy                                                | mirror                                                                                                                                                                 | Same                                                                                    |
| 8   | `buildClaimRequest(market, args)`                    | telegram                    | encodes `redeem` against OrderEngine                         | builds Solana `redeem` instruction with `Position` PDA                                                                                                                 | None                                                                                    |
| 9   | `buildSoothBookCancelByIdRequest(orderId)`           | telegram                    | encodes `cancelById(uint64)`                                 | builds Solana `cancel` with order PDA derived from orderId                                                                                                             | None                                                                                    |
| 10  | `MarketInfo` (type)                                  | demo, telegram              | bigint fields                                                | bigint fields                                                                                                                                                          | None — pure type                                                                        |
| 11  | `WAD`, `MAX_UINT256` (constants)                     | demo, telegram              | `1n << 256n - 1n`, `10n ** 18n`                              | identical                                                                                                                                                              | None                                                                                    |
| 12  | `formatWad(x)`, `parseWad(x)`                        | demo (re-exported by app)   | viem `formatUnits(x, 18)` / `parseUnits(s, 18)`              | identical implementation (no viem dep needed; trivial bigint math)                                                                                                     | None                                                                                    |
| 13  | `preflightTrade(request)`                            | telegram                    | viem `simulateContract`                                      | Solana `simulateTransaction` RPC call                                                                                                                                  | None — same `PreflightResult` shape                                                     |
| 14  | `classifyTradeError(error)`                          | telegram                    | matches against EVM 4-byte selectors → typed error           | matches against Anchor error codes → same typed error                                                                                                                  | None — both return `SoothError`                                                         |
| 15  | `computeSoothBookMaxCost(...)`                       | telegram                    | pure WAD math                                                | identical (no chain calls)                                                                                                                                             | None                                                                                    |

**Verdict: 15 of 15 preserve their current public signatures.** The only behavioral additions are:

- `attempts?: number` in `SubmitReceipt` (telemetry; ignorable)
- `BookMoved` variant in `SoothError` (Solana-only failure mode; falls through `classifyTradeError` correctly)

App code does not need to change for any of these.

---

## §5. Cross-package compatibility

### `@sooth/registry`

**Schema change required** in `registry-types.ts`:

```ts
// BEFORE
interface SoothNode {
  id: string;
  chainId: number; // EIP-155 numeric
  // ...
}

// AFTER
interface SoothNode {
  id: string;
  chainId: number | string; // numeric for EVM; string ("devnet"/"mainnet-beta") for Solana
  cluster?: "devnet" | "mainnet-beta" | "testnet"; // Solana only; absent on EVM
  // ...
}
```

Every consumer (`getNodeByChainId`, `getNodesByChainId`, `getChain`) accepts the union without behavioral change because they compare-and-filter rather than arithmetic. The KV-backed worker (`workers/registry-api`) needs the same schema in its node-submission validation.

**Alternative considered**: allocate Solana integer IDs (e.g. 900 = mainnet-beta, 901 = devnet — convention used by some bridges). Avoids the type widening but requires consumer awareness. Recommendation: widen the type. It's one PR; the union is more honest about the underlying reality.

### `@sooth/indexer`

The Postgres schema (13 tables: `launchpad_market`, `amm_trade`, `amm_position`, `lp_balance`, `lock_entry`, `trial_state`, `refund_claim`, `market_veto`, `protocolState`, `market`, `order`, `fill`, `mintMerge`) is fully reusable. Every table is keyed by `chainId + address` and stores WAD bigints — neither field is EVM-specific.

**What needs to change**: the event handler layer (`src/{amm,launchpad,soothbook}.ts` in the indexer) is Ponder-driven, reading viem-typed event logs from EVM RPCs. For Solana, replace this with a Helius webhook (or our own Geyser plugin) that subscribes to program logs and writes the same Postgres rows. The Hono REST API on top is **completely reusable** — consumers see identical JSON shapes.

**chainId column decision**: Postgres `integer` works either with widened-string (use `text`) or with the Solana-namespaced integer convention. The choice should match the registry decision in §5.1. If we go string, migrate `chainId integer` → `chainId text` (cheap, but a one-shot migration with downstream query updates).

### `@sooth/contracts-plugin`

| Adapter                                   | Compatibility                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZkTLSAdjudicator.sol`                    | **Concept ports.** Primus is chain-agnostic. Rewrite as a Solana program (`sooth_zktls_adjudicator`); the proof-verification interface is the same. |
| `SoothHIP4OracleAdjudicator.sol`          | **EVM-only.** Reads HyperCore precompile `0x0807`. No Solana equivalent. Stays as-is.                                                               |
| `SoothPostAction.sol` (Lens)              | **EVM-only.** Lens V3 is a Polygon protocol with no Solana counterpart. Stays as-is.                                                                |
| `SoothLensAdapter.sol`, `IPostAction.sol` | **EVM-only.** Same.                                                                                                                                 |

### Workers

**`workers/rpc-proxy`** assumes Ethereum JSON-RPC (`eth_call`, `eth_sendTransaction`). Solana JSON-RPC has different method names and request shapes. Two options:

- **Separate worker** `workers/sol-rpc-proxy/`: simpler, mirrors the EVM worker's CORS allowlist + caching. Recommended for v1.
- **Unified worker** with method-prefix routing: less infrastructure but more code paths in one binary.

**`workers/registry-api`** needs the schema widening from §5.1; it embeds `nodes.json` at build time and accepts pending node submissions through a Cloudflare Form, which validates `chainId` numerically today. Update validation to accept either numeric or one of the Solana cluster strings.

---

## §6. SoothBook-specific carve-out

> The escrow atomicity requirement is now formalized as a hard SDK invariant in `./integrator-contract.md §6`. Underlying program choice (Monaco fork, custom build, Phoenix) MUST honor it; this disqualifies Phoenix/OpenBook integration regardless of other engineering trade-offs.

This section is the load-bearing constraint for SDK-level parity. It refers to and depends on the SoothBook auto-match evaluation done in the prior conversation turn (not yet captured as a standalone doc — should it be needed, write `solana/soothbook-automatch-evaluation.md`).

### The decision gate

SoothBook on Solana has three options (per `../../programs-core/docs/architecture.md §6` and the auto-match eval):

- **Option A — Port SoothBook with client-driven matching.** SDK adapter reads book state, runs the shared Rust matcher off-chain to produce a `fills` array, submits TX with enumerated maker accounts. Program validates and applies. **Preserves escrow + surplus + 4-atomic guarantee.** Retries on race (visible to SDK only as `attempts: N` in receipt).
- **Option B — Phoenix integration.** Each (market, side) becomes Phoenix YES/USDC and NO/USDC markets. Solana program drives via CPI. **Loses atomic escrow** (sell-YES + buy-NO are two TXs; non-atomic). Loses surplus mechanic (Phoenix matches at single price; SoothBook's `surplus = (yesTick + noTick - 1000) × fill / 1000` requires post-CPI reconciliation).
- **Option C — OpenBook v2.** Same trade-offs as Phoenix.

### Why this is the SDK-level gate

SDK compatibility means **`buildSoothBookBuyRequest({ escrow: true })` returns a request that, when submitted, produces an atomic outcome**. If escrow can't be atomic (Options B/C), then either:

- App code learns to handle the non-atomic case (breaks the abstraction), or
- The SDK fakes atomicity by submitting two TXs and rolling back on partial failure (introduces a new failure mode that doesn't exist on EVM)

Both options are unacceptable for SDK parity. **Option A is required.**

### What this costs

Option A is the highest-engineering-cost option (custom slab allocator or pre-enumerated matching, plus the shared Rust matcher crate). Roughly 4–6 weeks of work versus 1–2 weeks for a Phoenix shim. The cost is justified only if:

1. `escrow=true` usage is meaningful in production (check telegram app analytics — how many orderbook trades use it?)
2. Atomic complete-set surplus is part of Sooth's market design identity (it is — see `OrderEngine.fillOrder`'s 9-arg signature in the contracts)

If both answers are "no" and we'd be content with non-atomic escrow (or removing the feature), Phoenix becomes viable and saves weeks. **Decision should be made at the founder level before the LMSR/matcher spike.**

---

## §7. SDK package layout — proposed

The end-state directory structure that delivers SDK-level parity. Apps continue to import from `@sooth/sdk` (and `@sooth/sdk/core/*`) — the EVM/Solana split is invisible to them.

```
packages/sdk/
├── src/
│   ├── core/                      # ALL chain-agnostic. Apps import only from here.
│   │   ├── adapter.ts             # NEW — ChainAdapter interface + createAdapter() factory
│   │   ├── types.ts               # KEPT — MarketInfo, Position, OrderArgs, Fill, …
│   │   ├── errors.ts              # REFACTORED — SoothError taxonomy, generic decoder
│   │   ├── math/
│   │   │   ├── lmsr.ts            # KEPT
│   │   │   └── marketStats.ts     # KEPT
│   │   ├── utils.ts               # KEPT (one viem dep extracted)
│   │   ├── hooks/                 # NEW — useTrade, useOrderbook, usePosition, useMarketInfo
│   │   ├── contracts/             # KEPT (signatures stable; bodies dispatch to adapter)
│   │   │   ├── markets.ts
│   │   │   ├── amm.ts
│   │   │   ├── portfolio.ts
│   │   │   ├── launchpadAmm.ts
│   │   │   └── soothCore.ts
│   │   ├── actions/
│   │   │   ├── types.ts           # KEPT (ActionContext now wraps ChainAdapter)
│   │   │   └── writes.ts          # REFACTORED — dispatches to adapter.build*
│   │   └── index.ts               # public re-export surface
│   ├── evm/                       # MOVED from current root + core/
│   │   ├── adapter.ts             # NEW — implements ChainAdapter via viem
│   │   ├── abis/                  # MOVED from core/abis/
│   │   ├── client.ts              # MOVED from root
│   │   ├── wallet.ts              # MOVED from root
│   │   ├── market.ts              # MOVED from root
│   │   ├── orderbook.ts           # MOVED from root
│   │   ├── megaeth.ts             # MOVED from core/megaeth.ts
│   │   ├── errors.ts              # NEW — EVM-specific decoder feeding SoothError
│   │   └── actions/
│   │       └── simulate.ts        # MOVED from core/actions/simulate.ts (test harness)
│   ├── solana/                    # NEW
│   │   ├── adapter.ts             # NEW — implements ChainAdapter via @coral-xyz/anchor
│   │   ├── client.ts              # NEW — Anchor program client factory
│   │   ├── wallet.ts              # NEW — SPL Token + ATA helpers
│   │   ├── market.ts              # NEW — sooth_market & sooth_amm wrappers
│   │   ├── orderbook.ts           # NEW — sooth_book wrapper with client-driven matcher
│   │   ├── idls/                  # NEW — Anchor IDLs from packages/programs-core
│   │   ├── programs/              # NEW — typed Anchor wrappers
│   │   ├── matcher-wasm/          # NEW — bindings to sooth-book-matcher Rust crate
│   │   ├── tx-builder/            # NEW — ALT mgmt, retry-on-race
│   │   └── errors.ts              # NEW — Anchor error decoder feeding SoothError
│   ├── registry.ts                # KEPT
│   ├── registry-types.ts          # MODIFIED — chainId widened
│   ├── lib/
│   │   └── sqf.ts                 # KEPT
│   ├── cli/                       # KEPT (EVM-only test harness)
│   └── index.ts                   # re-exports core/*; apps NEVER import evm/* or solana/*
```

### `package.json` `exports` preservation

The current `exports` field maps `./core`, `./core/utils`, `./core/types`, `./core/errors`, `./core/abis`, `./core/math`, `./core/config`, `./core/contracts`. Under the proposed layout:

- `./core`, `./core/utils`, `./core/types`, `./core/errors`, `./core/math`, `./core/contracts` — preserved (all live in `src/core/`)
- `./core/abis` — **needs deprecation note**: today it re-exports EVM ABIs. After move to `evm/abis`, either keep `./core/abis` as a passthrough re-export from `evm/abis` (zero-disruption) or migrate consumers to import from `@sooth/sdk/evm/abis`. **Recommendation**: passthrough re-export for one major version, then deprecate. App audit shows direct ABI imports in only 3 places — easy migration.
- `./core/config` — already chain-agnostic; preserved.

No new `./solana/*` exports need to be public — apps consume Solana through `core/` only. The `evm/` and `solana/` subtrees are SDK-internal.

---

## §8. Migration order (engineering discipline)

Two-phase plan. Phase A is pure refactor — no Solana code, no behavioral change, all four apps continue working identically. Phase B introduces Solana, gated by the LMSR/matcher CU spike from `../../programs-core/docs/architecture.md §13`.

### Phase A — Interface extraction (no Solana, ~1–2 weeks)

1. **Define `ChainAdapter`** in `src/core/adapter.ts`. Sketch from §2; iterate as we discover edge cases in EVM call sites.
2. **Implement `EvmAdapter`** in `src/evm/adapter.ts`. Initially a thin facade over current `core/contracts/*` and `core/actions/writes` functions — same code, just routed through the interface.
3. **Migrate `core/contracts/*` and `core/actions/writes`** to dispatch through the adapter. The public function signatures stay identical; their bodies become `adapter.method(...)`. This is the contract for §4's frozen API.
4. **Move EVM-specific code** out of `src/core/` into `src/evm/`: `core/abis/` → `evm/abis/`, `core/megaeth.ts` → `evm/megaeth.ts`, root `client.ts`/`wallet.ts`/`market.ts`/`orderbook.ts` → `evm/`. Add `./core/abis` passthrough export for backward compat.
5. **Verify**: all four apps build; all SDK tests pass; CLI scenarios (`pnpm interactive:base`, scenarios) run identically. No registry changes yet.

After Phase A: zero new functionality, but the codebase is structurally ready for a Solana adapter to slot in. Ship this independently.

### Phase B — Solana adapter (gated)

**Prerequisites** (from `../../programs-core/docs/architecture.md §13`):

1. 1-week LMSR Rust port + CU benchmark on `solana-test-validator` — ≤300k CU per `trade_positions` or we redesign.
2. Founder-level decision on Option A vs Option C (escrow load-bearing? See §6.)
3. Registry schema widening shipped.

**Sequence** (assume Option A chosen, ~6 weeks):

1. Build the shared Rust matcher crate (`packages/programs-core/crates/sooth-book-matcher/`). Compile to wasm, package into `src/solana/matcher-wasm/`.
2. Implement Solana programs (out of this doc's scope; see `../../programs-core/docs/architecture.md §11`).
3. Generate Anchor IDLs into `src/solana/idls/`.
4. Implement `SolanaAdapter` in `src/solana/adapter.ts`: read paths first, then build paths, then submit (with retry-on-race), then subscriptions.
5. Wire `core/createClient` to select adapter from `node.chainKind`.
6. Add Solana node entries to registry; deploy Solana RPC proxy worker.
7. Wire indexer Solana event handlers; backfill from devnet first.
8. Apps work unchanged. End-to-end E2E: replicate `apps/telegram` flows on a Solana devnet node. If green → mainnet candidate.

### Why Phase A first

Even if Solana never ships, Phase A is valuable: it cleans up the chain coupling that will otherwise calcify, and creates a real `ChainAdapter` boundary that makes future EVM-side changes (a new chain, a new wallet integration) easier. The cost is ~1–2 weeks of refactor plus regression testing.

---

## §9. What stays EVM-only (deliberately)

Some pieces are correctly EVM-locked and gain nothing from Solana parity. They stay where they are.

| Piece                                                                      | Why EVM-only                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SoothHIP4OracleAdjudicator.sol`                                           | Reads HyperCore precompile `0x0807` — Hyperliquid-specific; no Solana equivalent.                                                                                  |
| `SoothPostAction.sol` (Lens)                                               | Lens V3 is a Polygon-only protocol.                                                                                                                                |
| `SoothLensAdapter.sol`, `IPostAction.sol`                                  | Same.                                                                                                                                                              |
| `core/megaeth.ts`                                                          | Detects Megaeth/HyperEVM RPCs; selects native vs HTTP-proxy URL. Solana has its own RPC ecosystem; no shared concern.                                              |
| `cli/interactive.ts`, `cli/commands/*`, `cli/actors.ts`, `cli/scenarios/*` | Multi-actor E2E test harness. Adding Solana parity would double the CLI surface for marginal benefit; if/when needed, a separate `cli-solana/` can be added later. |
| `cli/assertions/invariants.ts`                                             | EVM-specific protocol invariants (PnL conservation, LP equity). Equivalent invariants on Solana are similar but separately written.                                |

These are not "compatibility blockers" — they are legitimately chain-specific functionality. The compatibility evaluation does not require them to be ported.

---

## §10. Risk register & open questions

### Risks

| Risk                                                  | Severity | Mitigation                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LMSR `exp`/`ln` exceeds 300k CU                       | High     | 1-week Rust spike before any Solana SDK work (see `../../programs-core/docs/architecture.md §13`). Fallback: approximation tables.                                                                                                                             |
| Race-induced retry rate >5%                           | Medium   | If the SDK frequently retries `placeOrder`, p99 latency degrades visibly. Mitigation: Jito bundles for atomic read+write; SDK exposes `attempts` so app can show a transient indicator.                                                       |
| Shared matcher crate diverges from on-chain validator | High     | Single Rust source of truth, compiled to both wasm + BPF. CI must build and test both targets. Property-based tests asserting equivalence.                                                                                                    |
| Indexer schema widening breaks downstream queries     | Low      | If we go `chainId text`, downstream Workers/REST queries comparing `chainId == 84532` (numeric) need a one-shot migration. Mitigate by namespacing Solana to integers (alternative chosen path).                                              |
| Solana ATA/rent payment surprise users                | Medium   | Document in app onboarding: each new market position costs ~0.002 SOL rent (refundable on close). Consider treasury subsidization for hot markets.                                                                                            |
| Anchor IDL drift from program updates                 | Medium   | CI step: regenerate IDLs after any program change; fail SDK build if Solana adapter consumes a stale IDL.                                                                                                                                     |
| Tick quantization (e.g. Monaco's 60-cap)              | Medium   | Internal-program concern; the contract requires the SDK adapter to round transparently and surface `actualTick` on the receipt when rounding occurred. Document the rounding policy per backend in `./integrator-contract.md §6`. |

### Open questions for founder decision

1. **Is `escrow=true` load-bearing?** This gates Option A vs Option C. Pull telegram analytics: what % of orderbook trades use escrow? (Analytics expected to live with the indexer or Privy.)
2. **What's the acceptance threshold for race-induced retries?** Suggested target: <5% retry rate at p50 trade volume. Above that, we need Jito or restructuring.
3. **Indexer namespace strategy.** Widen `chainId` to text (clean, one migration), or allocate Solana integer IDs (compatible, but cosmetically wrong)?
4. **Does `cli/` get a Solana port?** Recommendation: no, not in v1. Build a thin parity test in `tests/` that exercises the Solana adapter through the same SDK API.
5. **Wallet UX**: app already supports Privy + MetaMask + Wagmi. For Solana we need Phantom/Solflare/Backpack (via Wallet Adapter or Privy Solana). Is Privy's Solana support production-ready as of 2026-05?
6. **Pricing model on Solana.** Current EVM model assumes user pays gas. Solana model could subsidize via priority-fee budget (us paying CU cost). Decision affects `submit()` semantics in the adapter.

---

## §11. Quick-reference: what to do next

1. **Read this doc + `../../programs-core/docs/architecture.md`** — they're the design surface.
2. **Decide on §10 questions 1, 4, 6** — these gate Solana SDK work without needing any code.
3. **Schedule the 1-week LMSR/matcher spike** (`../../programs-core/docs/architecture.md §13`) — its result decides whether Phase B is feasible.
4. **Independently of Solana**: Phase A refactor (§8) is high-value cleanup that pays off even if Solana never ships.
5. **Update `STATUS.md` + `DECISIONS.md`** to reference this evaluation as the canonical SDK-compat plan.

---

_Last updated: 2026-05-05. Companion doc: `../../programs-core/docs/architecture.md`._
