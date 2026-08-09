// =============================================================================
// VENDORED — replace with `@sooth/sdk@0.3.0` import when Phase A ships.
// -----------------------------------------------------------------------------
// The umbrella `@sooth/sdk` Phase A refactor (per
// `docs/implementation-guide.md §8`) will extract the `ChainAdapter` interface
// and the supporting cross-chain types into `@sooth/sdk/core/*`. Until that
// ships as `@sooth/sdk@0.3.0`, this package vendors the spec verbatim from the
// canonical sketch in `docs/implementation-guide.md §2`.
//
// When swapping over:
//
//   - delete this file
//   - replace imports with: `import type { ChainAdapter, SoothCoreSnapshot, ... } from "@sooth/sdk"`
//   - the `SolanaChainAdapter` class signatures should not need to change; the
//     vendored types are deliberately byte-aligned with the spec.
//
// If a divergence between this file and `@sooth/sdk@0.3.0` is observed at swap
// time, the upstream package wins (it owns the canonical surface) and the
// adapter is updated to match.
// =============================================================================

// Chain-prefixed market identifier. Solana shape: `sol:<base58 market PDA>`.
export type MarketRef = string;

// Chain-prefixed user address. Solana shape: `sol:<base58 pubkey>`.
export type AddressRef = string;

// Tx identifier. Solana shape: `sol:<base58 signature>`.
export type TxId = string;

// Registry node descriptor. The full type lives in `@sooth/registry`; we only
// need the fields the adapter consumes.
export interface SoothNode {
  id: string;
  chainKind: "evm" | "solana";
  chainId: number | string;
  cluster?: "devnet" | "mainnet-beta" | "testnet";
  rpcUrl: string;
  // Sooth program addresses — base58, Solana-only.
  //
  // The 5→1 merge left one program: `soothCore`. `soothLog` is gone too — it
  // existed because a program was believed unable to CPI into itself, which is
  // false (Solana permits direct self recursion), so events now use Anchor's
  // `emit_cpi!` instead. The pre-merge keys are retained
  // as deprecated so existing node descriptors still typecheck — the adapter
  // reads only `soothCore` and `usdcMint`, so leaving the old ones set is a
  // silent no-op rather than an error.
  programs?: {
    soothCore?: string;
    usdcMint?: string;
    /** @deprecated merged into `soothCore`; ignored by the adapter. */
    soothAmm?: string;
    /** @deprecated merged into `soothCore`; ignored by the adapter. */
    soothMarket?: string;
    /** @deprecated merged into `soothCore`; ignored by the adapter. */
    soothBook?: string;
  };
}

// Wallet abstraction. The umbrella SDK accepts both EVM and Solana shapes;
// the Solana adapter narrows to the Solana side.
export interface SolanaSigner {
  // Public key as base58.
  publicKey: string;
  // Sign a serialized message; returns a 64-byte signature.
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  // Sign a serialized transaction (legacy or v0). Either of the two below
  // satisfies the adapter; in tests we use `signTransaction`.
  signTransaction?: (txBytes: Uint8Array) => Promise<Uint8Array>;
  signAllTransactions?: (txs: Uint8Array[]) => Promise<Uint8Array[]>;
}

// SignerRef is a union in the umbrella SDK; the Solana adapter only handles
// the Solana arm.
export type SignerRef = SolanaSigner;

// ─── Snapshots ─────────────────────────────────────────────────────────────

export interface MarketInfo {
  market: MarketRef;
  question: string;
  deadline: bigint;
  isLive: boolean;
  isSettled: boolean;
  outcome?: 0 | 1 | 2;
  qYes: bigint;
  qNo: bigint;
  b: bigint;
  isGraduated: boolean;
}

export interface Position {
  yesShares: bigint;
  noShares: bigint;
  lockedCostUsdc?: bigint;
  lockedYes?: bigint;
  lockedNo?: bigint;
  unlockableAt?: bigint;
}

export interface Portfolio {
  positions: Array<{ market: MarketRef; position: Position }>;
}

// `SoothCoreSnapshot` is the umbrella SDK's normalized read shape. The
// canonical definition lives in `sooth-alpha/packages/sdk/src/types.ts` —
// when Phase A ships we replace this with the upstream type.
export interface SoothCoreSnapshot {
  market: MarketInfo;
  position?: Position;
}

// ─── Quotes ────────────────────────────────────────────────────────────────

export interface TradeQuote {
  cost: bigint; // WAD; signed (sell returns negative)
  fee: bigint; // WAD; always non-negative
  netCost: bigint; // cost + fee
  newYesPrice: bigint; // WAD probability after the trade
  priceImpact: bigint; // WAD (newYesPrice - oldYesPrice)
}

// ─── Trade args ────────────────────────────────────────────────────────────

export interface TradeArgs {
  outcome: 0 | 1; // NO | YES
  deltaShares: bigint; // WAD; signed (>0 buy, <0 sell)
  maxCostWad: bigint; // WAD; slippage envelope
  side: "buy" | "sell";
}

// ─── Requests ──────────────────────────────────────────────────────────────

// Account participation metadata, mirroring `solana/web3.js`'s `AccountMeta`.
// Used by `SoothRequest.accounts` so callers building Address Lookup Tables or
// inspecting trade requests get the full account list with role flags — the
// same source of truth Anchor's instruction builder produces.
export interface AccountMeta {
  // base58-encoded pubkey (chain-prefixed refs are NOT used here — this is a
  // Solana-only structural field; the EVM adapter never populates `accounts`).
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

// Generic request. The Solana adapter populates `serializedTx` with the
// unsigned transaction bytes; the EVM adapter populates `calldata` instead.
// Both shapes round-trip through `submit`.
export interface SoothRequest {
  kind: "trade" | "claim" | "orderbook" | "createMarket" | "approve";
  // Solana-only: serialized unsigned transaction (legacy or v0).
  serializedTx?: Uint8Array;
  // Cost estimate in WAD (display only; not authoritative).
  costEstimateWad?: bigint;
  // Solana-only: account list for inspection / ALT building. Shape is the
  // exact `AccountMeta[]` derived from the underlying instruction's `keys`,
  // so consumers see writable/signer flags and can replay the layout into a
  // versioned tx with an Address Lookup Table.
  accounts?: AccountMeta[];
  // Diagnostic metadata.
  meta?: Record<string, unknown>;
}

export type TradeRequest = SoothRequest & { kind: "trade" };
export type ClaimRequest = SoothRequest & { kind: "claim" };
export type OrderbookRequest = SoothRequest & { kind: "orderbook" };
export type CreateMarketRequest = SoothRequest & { kind: "createMarket" };

// ─── Receipts ──────────────────────────────────────────────────────────────

export interface Fill {
  orderId: string;
  taker: AddressRef;
  maker: AddressRef;
  takerSide: 0 | 1;
  yesTick: number;
  noTick: number;
  amount: bigint;
  surplus: bigint;
  timestamp: bigint;
}

export interface SubmitReceipt {
  txId: TxId;
  confirmedAt: bigint; // Unix ms
  fills: Fill[];
  attempts?: number; // Solana-only; absent on EVM
}

// Solana-only submission options. Capped at 5 attempts per the
// integrator-contract spec (`docs/implementation-guide.md §2`):
// "EVM always returns 1; Solana may return 1–5." The EVM adapter ignores
// this argument; that's why it's optional and absent from the EVM call sites.
export interface SubmitOptions {
  // Maximum total attempts (including the first send). Default 5; clamped to
  // [1, 5] to honor the spec ceiling.
  maxAttempts?: number;
}

export interface PreflightResult {
  ok: boolean;
  error?: { kind: string; [k: string]: unknown };
  gasEstimate?: bigint;
  feeUsd?: number;
}

// ─── Events ────────────────────────────────────────────────────────────────

export type MarketEvent =
  | { kind: "OrderPlaced"; [k: string]: unknown }
  | { kind: "OrderFilled"; [k: string]: unknown }
  | { kind: "OrderCancelled"; [k: string]: unknown }
  | { kind: "Minted"; [k: string]: unknown }
  | { kind: "Merged"; [k: string]: unknown }
  | { kind: "MarketResolved"; [k: string]: unknown }
  | { kind: "MarketSettled"; [k: string]: unknown };

export type PositionEvent = { kind: string; [k: string]: unknown };

export type Unsubscribe = () => void;

// ─── Other arg types (carried through, not all consumed by this adapter) ──

export interface ClaimArgs {
  outcome: 0 | 1 | 2;
}
export interface BuyArgs {
  side: 0 | 1;
  tick: number;
  amount: bigint;
  escrow: boolean;
  matchLimit: number;
  maxCost?: bigint;
}

// `mint_complete_set` / `merge_complete_set` on Solana take a single u64
// USDC-base-units arg. The ix mints / burns equal-weight YES + NO outcome
// tokens at parity (1 USDC = 1·WAD YES = 1·WAD NO).
//
// `user` is a Solana-only meta channel — same convention as TradeArgs.user.
export interface SellArgs extends BuyArgs {}

export interface OrderbookCancelOptions {
  user: AddressRef;
  byId?: bigint;
}

export interface CreateMarketArgs {
  question: string;
  deadline: bigint;
  // ── Solana-specific extensions ──────────────────────────────────────────
  // The umbrella SDK's `CreateMarketArgs` is intentionally narrow — `question`
  // + `deadline` are the load-bearing inputs. Solana additionally needs a
  // deterministic `marketId` (PDA seed), `startTime`, `adjudicator`, and
  // `initialB` for the LMSR. These are optional on the surface so the
  // umbrella type stays portable; the Solana adapter falls back to safe
  // defaults (random `marketId`, `now()` for `startTime`, the calling
  // creator pubkey for `adjudicator`, and `1000 * WAD` for `initialB`).
  marketId?: Uint8Array; // 16 bytes; default = random
  questionHash?: Uint8Array; // 32 bytes; default = sha256(question)
  startTime?: bigint; // unix seconds; default = current chain time
  adjudicator?: string; // base58; default = creator
  initialB?: bigint; // WAD; default = 1000 * 10^18
  // Solana-only meta channel: the user's pubkey (creator + payer for every
  // CPI leg). Same convention as `buildTrade.user` — the umbrella SDK plumbs
  // this in via the wallet adapter at request-build time.
  user?: string;
}

// ─── The interface ────────────────────────────────────────────────────────

export interface ChainAdapter {
  readonly node: SoothNode;
  readonly chainKind: "evm" | "solana";

  // Reads
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

  // Writes
  buildTrade(market: MarketRef, args: TradeArgs): Promise<TradeRequest>;
  buildClaim(market: MarketRef, args: ClaimArgs): Promise<ClaimRequest>;
  // The book: one place/cancel/withdraw set. The legacy two-sided
  // buy/sell/cancel trio it replaced is gone along with the instructions
  // behind it.
  buildBookPlace(
    market: MarketRef,
    args: {
      user: AddressRef;
      side: number;
      limitTick: number;
      amount: bigint;
      matchLimit?: number;
      postRemainder?: boolean;
    },
  ): Promise<TradeRequest>;
  buildBookCancel(
    market: MarketRef,
    args: { user: AddressRef; orderSeq: bigint },
  ): Promise<TradeRequest>;
  buildBookWithdraw(
    market: MarketRef,
    args: { user: AddressRef },
  ): Promise<TradeRequest>;
  buildCreateMarket(args: CreateMarketArgs): Promise<CreateMarketRequest>;

  // Submission
  submit(
    req: SoothRequest,
    signer: SignerRef,
    options?: SubmitOptions,
  ): Promise<SubmitReceipt>;
  preflight(req: SoothRequest): Promise<PreflightResult>;

  // Subscriptions
  subscribeMarketEvents(
    market: MarketRef,
    handler: (e: MarketEvent) => void,
  ): Unsubscribe;
  subscribePositionEvents(
    user: AddressRef,
    handler: (e: PositionEvent) => void,
  ): Unsubscribe;

  // Wallet + collateral
  getCollateralBalance(user: AddressRef): Promise<bigint>;
  buildApprove(spender: AddressRef, amount: bigint): Promise<SoothRequest>;
}

// ─── Constants (mirrors `@sooth/sdk` core constants) ─────────────────────

export const OUTCOME = { NO: 0, YES: 1, INVALID: 2 } as const;
export const WAD = 1_000_000_000_000_000_000n; // 1e18
// USDC has 6 decimals; WAD has 18; ratio = 1e12.
export const WAD_TO_USDC_SCALAR = 1_000_000_000_000n;
