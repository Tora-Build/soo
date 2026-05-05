# Glossary — Sooth Solana Spec Suite

> Terms used across `sooth-core-solana` and `sooth-sdk-solana` specs.
> One sentence per term unless context is genuinely needed.

## Sooth-protocol terms

- **OUTCOME** — Protocol-wide encoding for binary outcomes plus invalid: `NO=0`, `YES=1`, `INVALID=2`. Source of truth: [`.claude/rules/knowledge.md`](../../.claude/rules/knowledge.md).
- **WAD** — Fixed-point precision constant, `1e18`. All internal math (LMSR, fees, position accounting) uses WAD; conversions to token decimals happen at boundaries (`_wadToUsdc`, `_usdcToWad`).
- **tick** — Discrete price level in SoothBook's orderbook; integer in `[1, 999]` where tick T means "buyer pays T/1000 for that outcome." 1000 ticks total.
- **escrow** — Boolean flag on `SoothBook.buyYes`/`buyNo` that uses the _opposite_ outcome shares as collateral instead of pulling base token. Atomic: debit opposite → match → credit opposite on cancel/dust.
- **surplus** — Extra collateral generated when a YES order at tick A crosses a NO order at tick B with `A + B > 1000`; the `(A+B-1000) × fill / 1000` overage is paid out atomically as a complete-set mint.
- **mint** (orderbook action) — Atomic exchange of base token for one unit each of YES + NO shares. Inverse of `merge`.
- **merge** (orderbook action) — Atomic exchange of one unit each of YES + NO shares back to base token.
- **complete set** — One unit each of YES and NO; redeemable for base token via `merge` regardless of outcome.
- **graduation** — When a Launchpad market accumulates enough fees (`bBase × ln(2) × multiplier`) to reach LP break-even; switches fee distribution from 100%-bBase-growth to the 4-way split.
- **trial period** — Window after market creation during which the creator can `dismiss` if `!isGraduated`. Duration is `min(0.3 × time-to-deadline, defaultTrialPeriod)`. Default cap is 3 days as of 2026-04.
- **adjudicator** — Contract/program that resolves a market. Multi-phase: `configureMarket → resolve → attest → settle` with `dispute` veto branch. Each adjudicator is a separate contract/program (Manual, ZkTLS, etc.).
- **Lock-on-Sell** — On AMM sell, proceeds are credited but locked for 24h before the user can withdraw. Spendable inside the protocol immediately; only withdrawal is gated.
- **node** — A single deployment of the Sooth core (one set of contract/program addresses on one chain). Identified by deterministic `id = first-8-of-SHA256(chainId:launchpadEngine)`. Catalogued in `packages/registry/nodes.json`.

## SDK terms

- **`@sooth/sdk`** — The TypeScript SDK package consumed by `apps/demo`, `apps/telegram`, `apps/market`, and external integrators.
- **`ChainAdapter`** — Internal interface in `core/adapter.ts` that EVM and Solana adapters both implement. SDK-internal; never imported by external developers.
- **frozen surface** — The set of contract symbols (functions, types, constants, hooks) whose signatures must not change without a major version bump. Defined in [`sdk-solana/docs/integrator-contract.md §3`](../packages/sdk-solana/docs/integrator-contract.md).
- **`SoothRequest`** — Built but not yet submitted transaction object. Returned from `build*` functions; consumed by `client.submit()`. Chain-internal shape.
- **`SubmitReceipt`** — Result of a successful submission: `{ txId: string, confirmedAt: bigint, fills: Fill[], attempts?: number }`. Identical shape on EVM and Solana.
- **`SoothError`** — Tagged union covering all errors raised by the SDK across both chains. Variants: `InsufficientShares`, `OrderNotActive`, `MarketNotActive`, `InvalidTick`, `SlippageExceeded`, `InsufficientApproval`, `BookMoved` (Solana-only), `Reverted` (EVM fallback), `ProgramError` (Solana fallback).
- **MarketRef** — Opaque, chain-prefixed identifier for a market. EVM: `evm:0x…`. Solana: `sol:…`. Frozen string type.

## Solana-specific terms

- **PDA** — Program Derived Address. A deterministic address derived from seeds + program ID; lets a program "own" an account without a private key. Sooth uses PDAs for all market/state accounts.
- **CPI** — Cross-Program Invocation. How one Anchor program calls another (e.g. `sooth_market` CPIs into `spl-token` to transfer USDC). Depth capped at 4 in production.
- **CU** — Compute Unit. Solana's gas-equivalent. Default per-instruction limit is 200k; max is 1.4M; per-transaction max is also 1.4M. LMSR's `exp`/`ln` is the dominant CU consumer in Sooth's design.
- **ALT** — Address Lookup Table. Mechanism in v0 transactions for compressing the account-list footprint; essential for transactions that touch many accounts (e.g. orderbook trades crossing multiple ticks).
- **slab** — A bump-allocated memory region inside one large account, often hosting linked data structures (free list + heap). Used by Phoenix, OpenBook, and Manifest to put an entire orderbook into one account.
- **critbit tree** — Crit-bit tree (radix tree variant); a common slab-friendly data structure used by Solana CLOBs to index orders by price.
- **HyperTree** — Manifest's novel data structure: uniform 80-byte graph nodes interleaved within a single market account's dynamic byte array. Solves "you must declare all space upfront on Solana" by sharing node space across bids/asks/free list.
- **Sealevel** — Solana's runtime; schedules transactions in parallel based on declared account write-locks. Trades on the same `BookState`/`AmmState` account serialize.
- **JIT auction** — Drift Protocol's "Just-In-Time" auction pattern: a 5-second Dutch auction on every market order, compensating for Solana's lack of mempool.
- **Anchor** — The dominant Solana program framework. Provides IDL generation, account validation macros, and TypeScript client codegen. Not strictly required but used by ~all production Solana programs.
- **IDL** — Interface Definition Language. Anchor-generated JSON describing a program's instructions and account layouts. Consumed by SDK clients; analogous to EVM ABIs.
- **slot** — Solana's unit of time. ~400ms each. Finality is ~32 slots after submission.
- **rent** — Lamports a Solana account must hold to remain on-chain. Rent-exempt accounts (size-dependent) are paid once at creation; refundable on close.

## EVM terms (for cross-reference)

- **ABI** — Application Binary Interface. JSON descriptor of a Solidity contract's functions and events. EVM analogue of an Anchor IDL.
- **chainId** — Numeric EIP-155 chain identifier. Sooth's registry currently keys on this; widening to support Solana clusters is decision **P3** in the decision log.
- **Multicall3** — Standard contract for batching read calls; used by `core/contracts/*` to bundle market reads into a single RPC roundtrip.

## Project terms

- **monorepo (this suite)** — Future `Tora-Build/sooth-solana` repo, currently staged in `sooth-alpha/solana/` as the init structure. Two workspace packages: `packages/programs-core/` (Anchor programs) and `packages/sdk-solana/` (`@sooth/sdk-solana` TypeScript adapter), plus `docs/` for cross-cutting materials. Linked to `sooth-alpha` only via the published `@sooth/sdk-solana` npm package.
- **Phase A** — In the SDK migration plan: pure refactor that extracts `ChainAdapter` from current EVM-coupled code. No Solana code yet. Apps continue working.
- **Phase B** — In the SDK migration plan: Solana adapter implementation. Gated by Phase A + the LMSR CU spike.
- **The spike** — 1-week prototype validating LMSR `exp`/`ln` runs within Solana's CU budget. Single highest-leverage activity blocking everything else.
