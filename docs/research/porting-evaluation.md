# Sooth Solana Porting Evaluation

Status: fresh code-derived evaluation  
Date: 2026-05-05  
Scope: current Sooth Alpha repo surfaces only. Existing Solana research notes are not treated as source material.

## Verdict

A Solana version of Sooth is viable, but it should be treated as a new SVM-native node family that preserves Sooth product semantics. It should not be treated as a source-level port of the current Solidity contracts.

The practical split is:

- Reuse the product model: binary markets, YES/NO positions, launchpad trial/graduation, LMSR-style AMM economics if benchmarked, fee policy, settlement lifecycle, portfolio/indexer API concepts, and much of the React UI layout.
- Rewrite the chain layer: programs, account layouts, vault custody, token movement, wallet transactions, indexer ingestion, registry schema, and orderbook execution.

The lowest-risk first milestone is an AMM plus lifecycle proof on Solana. A native orderbook should be deferred until the AMM math, custody model, and indexer contract are proven under Solana account and compute limits.

## Basis

This pass was derived from the current repository surfaces:

- `STATUS.md`: app-facing protocol state is v0.2.1 with registry version 0.2.2.
- `packages/registry/nodes.json`: repo registry entries are EVM nodes keyed by numeric `chainId`, hex contract addresses, start blocks, and EVM explorers.
- `packages/registry/src/types.ts`: registry types assume `Address = 0x${string}` and EVM-style contract maps.
- `packages/indexer/ponder.config.ts`: indexer is Ponder over EVM ABIs, `eth_getLogs`, `startBlock`, and per-chain contract addresses.
- `packages/indexer/ponder.schema.ts` and `packages/indexer/src/api/index.ts`: API tables and routes are useful conceptually, but identifiers are EVM-shaped: hex addresses, `chainId`, `blockNumber`, `txHash`, `logIndex`.
- `workers/rpc-proxy/src/index.ts`: RPC proxy allowlist is Ethereum JSON-RPC only.
- `apps/demo/src/lib/wagmi.ts`, `apps/demo/src/main.tsx`, and trading hooks: app writes are wagmi/viem based, with ERC20 approvals, EVM receipts, gas estimation, keccak market keys, and EVM chain switching.
- `packages/contracts-core/src/*.sol`: read-only protocol source for launchpad, AMM, fees, market lifecycle, orderbook, and math.

The repo has light Solana-aware stubs in the demo chain store, but the working product path remains EVM-first.

## Current System Shape

### Protocol Modules

The current Sooth core is not one contract. It is a set of coordinated EVM contracts with distinct custody and lifecycle responsibilities:

- `LaunchpadEngine` creates markets, configures launchpad state, tracks trial/graduation, deploys market-related assets, and initializes AMM behavior.
- `AMMEngine` owns AMM market state, LMSR trades, user AMM positions, lock queues, claim paths, settlement behavior, and LP/fee accounting hooks.
- `FeeRouter` distributes and accrues fees across protocol, market, LP, adjudicator, and pre/post-graduation buckets.
- `TruthMarket` owns resolution, attestation, veto/finalization, settlement, and invalidation semantics.
- `AdjudicatorRegistry` records adjudicator configuration.
- `SoothBook` exposes orderbook actions and canonical order/fill/mint/merge/cancel events.
- `OrderEngine` handles deeper orderbook custody and signed-order semantics, including deposits, withdrawals, EIP-712-style signatures, position accounting, matching, mint/merge, and settlement.
- `LMSRMath`, `DecimalMath`, and bitmap helpers encode economic math and EVM-specific performance assumptions.

That separation matters for Solana because each EVM storage map becomes an account layout and each cross-contract trust boundary becomes a program, PDA, CPI, or shared module boundary.

### App And Indexer Assumptions

The current app and data plane assume Ethereum semantics at many layers:

- Wallet/session: Reown AppKit, wagmi providers, viem public clients, EIP-1193 test connector, EVM chain switching.
- Transaction flow: `writeContractAsync`, `waitForTransactionReceipt`, `receipt.status === "success"`, EVM gas estimation, EVM transaction hashes.
- Token flow: ERC20 `balanceOf`, `allowance`, `approve`, `maxUint256`, spender-specific approvals to `AMMEngine` or `OrderEngine`.
- Market identity: hex addresses and `keccak256(encodePacked(["address"], [marketAddress]))` market keys.
- Data ingestion: Ponder ABI event indexing through `eth_getLogs`, start blocks, log indexes, and contract addresses.
- API identity: numeric `chainId`, `0x` users/markets, block numbers, EVM transaction hashes, log indexes.
- Registry identity: EVM chain metadata and contract-address maps.

Solana support should be added behind explicit adapters. It should not be implemented by sprinkling `isSolana` branches through the existing wagmi-oriented hooks.

## Reusable Pieces

The following can carry over with limited or moderate adaptation:

- Product language and workflows: create market, trade YES/NO, provide liquidity, graduate, resolve, settle, claim, portfolio.
- Outcome semantics: binary outcomes plus invalid settlement need to remain stable across EVM and SVM.
- Fee policy: the split model can be preserved if implemented as state-based accrual and constrained vault movement.
- Indexer API concepts: markets, AMM trades, AMM positions, LP balances, lock entries, portfolio, orderbook orders/fills.
- UI layout: most screens can be reused once the chain-facing hooks are replaced by domain-level adapters.
- Forecast/backtest logic: can be reused if it consumes normalized trade and position data instead of EVM-only identifiers.
- TypeScript formatting/math utilities: reusable after address, transaction, and chain identity types are generalized.

## Rewrite Required

These areas are not portable as-is:

- Solidity contracts: must become Solana programs, likely in Anchor or a minimal native Rust stack.
- Storage: mappings and arrays must become account layouts, PDAs, and explicit rent/account lifecycle handling.
- Custody: ERC20 approvals must become SPL token vaults, ATAs, token-account constraints, and PDA authorities.
- Deployment registry: hex contract-address maps must become chain-family-aware node records with cluster, program IDs, IDLs, mints, PDAs, and slot/signature metadata.
- Wallet transport: wagmi/viem writes must become Solana transaction builders, wallet adapters, confirmation handling, and blockhash/priority-fee management.
- Indexing: Ponder over EVM logs must be replaced or supplemented by Solana account/event ingestion.
- Order signatures: EIP-712 signed orders do not carry over. If signed off-chain orders remain a feature, Solana needs an explicit message/signature format and replay domain.
- Orderbook execution: EVM bitmap/order-array assumptions need a new design or an external Solana CLOB integration decision.
- RPC proxy: current worker only permits Ethereum JSON-RPC methods.

## Recommended SVM MVP

Build the Solana path in this order.

### 1. AMM And Lifecycle First

Start with a small Solana program surface that can create a market, initialize vaults, execute AMM trades, accrue fees, resolve/settle, and claim outcomes.

This is the right first milestone because:

- The AMM path is the clearest user-facing product surface.
- LMSR math and token custody are the highest-confidence blockers to measure early.
- Orderbook design depends on settlement, custody, and indexer primitives anyway.
- It avoids committing to a native book or external CLOB before the core market lifecycle works.

### 2. Preserve Core Semantics

The Solana MVP should preserve these semantics unless the product intentionally changes:

- Market lifecycle: live, resolved, attested/finalized, settled, invalid.
- Trial expiry: ungraduated markets should stop trading after trial expiry and exit through the normal invalid/settlement path, not through an unrelated refund-only lifecycle.
- Outcomes: keep canonical outcome encoding consistent at adapter boundaries.
- Fees: keep fee accrual pull-based where possible; do not rely on arbitrary client-supplied fee destinations.
- Collateral: validate the base mint and every token account against config, PDA seeds, or deterministic associated token accounts.
- Settlement: settlement claims must derive from recorded positions and final outcome state, not client-provided balances.

### 3. Use A Small Program Set

A reasonable first SVM shape:

- `sooth_config`
  - Protocol config, authority, treasury, supported mints, fee parameters, adjudicator allowlist.
- `sooth_market`
  - Market account, lifecycle state, metadata hash/pointer, deadline, trial timing, outcome, invalidation, settlement authority.
- `sooth_amm`
  - AMM state, LMSR quantities, liquidity state, AMM positions, trade execution, lock entries, fee accrual, claims.
- `sooth_adjudicator_manual`
  - Minimal resolver-gated adjudication for the MVP.

This can be one Anchor workspace with separate programs or a smaller number of programs with clearly separated account namespaces. The important point is to keep account ownership, authority, and CPI boundaries explicit.

Defer `sooth_book` until AMM/lifecycle/indexer are measured.

## Blocking Design Gates

### Gate 1: LMSR Compute And Precision

The Solidity implementation relies on WAD fixed-point math, exponential/log approximations, and decimal conversion helpers. On Solana, this must be proven rather than assumed.

Required work:

- Port the quote/trade math to Rust with deterministic fixed-point behavior.
- Generate golden vectors from the current Solidity/TypeScript behavior.
- Benchmark quote, buy, sell, and settlement paths on `solana-test-validator`.
- Record compute units, account list size, and priority-fee sensitivity.
- Decide early whether to keep exact WAD math, use tables/approximations, or alter the curve.

No Solana build should proceed to orderbook work until this gate is answered.

### Gate 2: Custody And Fee Invariants

The current EVM app depends on approvals to known spender contracts. Solana has no allowance equivalent, so custody must be program-controlled.

Required invariants:

- Base token mint is fixed by protocol or node config.
- Market vaults are owned by deterministic PDA authorities.
- User token accounts are constrained to the signer and expected mint.
- Fee destination accounts are derived or checked against config, not trusted from client input.
- LP/adjudicator/protocol accrual cannot be redirected by substituting token accounts.
- Rent close paths cannot leak funds or break later claims.
- Rounding behavior is specified at every WAD-to-token boundary.

This is the highest security gate for a Solana implementation.

### Gate 3: Account Model For Positions

The current system has AMM positions, orderbook/internal positions, LP balances, lock entries, and settlement claims. Solana needs an explicit model for which of these are SPL mints and which are program accounts.

Main choices:

- Program-owned `Position` accounts per market/user.
- SPL mints for YES/NO shares, improving composability but increasing token-account and settlement complexity.
- Hybrid model: internal AMM positions first, optional tokenized positions later.

Recommendation: start with program-owned AMM positions for MVP. Add tokenized YES/NO mints only after composability needs justify the extra account and settlement surface.

### Gate 4: Indexer Contract

The current Ponder schema is useful as a product API, but its identifiers are EVM-specific.

The Solana indexer must define:

- Chain family: `evm` or `solana`.
- Cluster: `devnet`, `testnet`, `mainnet-beta`, or local.
- Program IDs and IDL versions.
- Slot, signature, instruction index, and account pubkeys.
- Market, user, position, LP, lock, and trade identities independent of `0x` addresses.
- Normalized API responses that the app can consume without caring whether the source is EVM or SVM.

The existing API routes can inspire the shape, but their path params and schemas need generalized identifiers.

### Gate 5: Orderbook Decision

Do not assume a native SoothBook port as part of v1.

There are two viable paths:

- Native Sooth orderbook:
  - Best control over binary-market semantics, settlement shutdown, custody, mint/merge, and fee routing.
  - Requires careful account design, matching limits, and compute/account benchmarks.
- External Solana CLOB:
  - Better ecosystem fit and potentially lower matching complexity.
  - Harder to preserve Sooth-specific lifecycle controls, invalid settlement, fee policy, and UX guarantees.

Decision gate:

- Build a minimal native book benchmark for one market and crossing orders.
- Build one external-CLOB devnet spike.
- Compare account footprint, partial-fill semantics, custody, fees, lifecycle shutdown, settlement, and indexer complexity.

Until then, ship AMM-first.

## Frontend Integration Strategy

Do not retrofit Solana directly into existing wagmi hooks. Introduce domain adapters:

- `marketAdapter`: list markets, get market detail, get lifecycle state.
- `tradeAdapter`: quote, approve-or-prepare, submit trade, confirm trade.
- `portfolioAdapter`: positions, LP balances, locks, claimable amounts.
- `orderbookAdapter`: optional; disabled until native or external CLOB decision is made.
- `registryAdapter`: resolve active nodes by chain family and environment.

Then implement:

- `evmAdapter` using current wagmi/viem code.
- `solanaAdapter` using Solana transaction builders and wallet confirmation semantics.

This keeps the UI product screens stable while isolating chain differences.

## Registry Changes Needed

The registry should become chain-family aware before a Solana node is added.

Current EVM-style node shape:

- numeric `chainId`
- hex `contracts`
- `startBlock`
- EVM explorer
- EVM `deployedBy`

Solana node shape needs at least:

- `chainFamily: "solana"`
- `cluster`
- `programs`
- `programVersion`
- `idlVersion`
- `baseMint`
- `baseMintDecimals`
- `deployedSlot`
- `deployedSignature`
- `deployedBy` as a pubkey
- explorer URL patterns for address, signature, and transaction
- optional indexer cursor/checkpoint state

Keep EVM fields EVM-specific. Do not force Solana pubkeys into `0x${string}` types.

## Proposed Work Plan

1. Write `solana/v1-spec.md`
   - Program list, account layouts, PDA seeds, instruction signatures, authority rules, event/indexing model, and invariants.

2. Build `solana/prototypes/lmsr-benchmark/`
   - Minimal Rust/Anchor math and `trade_positions` instruction.
   - Golden vectors against current EVM behavior.
   - Compute-unit report for quote, buy, sell, settle, and claim paths.

3. Build `solana/prototypes/custody/`
   - PDA vaults, associated token constraints, fee accrual, claim/close behavior.
   - Negative tests for redirected fee accounts and wrong mints.

4. Draft `solana/indexer-schema.md`
   - Chain-neutral market/trade/position/order/portfolio API contract.
   - Explicit EVM and Solana identifier fields.

5. Add frontend adapter interfaces
   - No Solana UI until adapter boundaries are in place.
   - Keep existing EVM hooks working while extracting domain interfaces.

6. Revisit orderbook
   - Native book versus external CLOB only after AMM, custody, and indexer gates are measured.

## Bottom Line

Porting Sooth to Solana is not blocked by the product model. It is blocked by unproven chain primitives: LMSR compute, SPL/PDA custody, chain-neutral indexing, registry identity, and orderbook architecture.

The first Solana milestone should be an AMM/lifecycle prototype with measured compute and custody tests. A full SoothBook rewrite should wait until the core market path is proven.
