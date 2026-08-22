// Public surface of `@sooth/sdk-solana`.
//
// `SolanaChainAdapter` is the entry point: the umbrella SDK imports this
// package when `node.chainKind === "solana"` and routes ChainAdapter calls
// through it. Everything else exported here is something a caller needs
// WITHOUT an adapter in hand — PDA derivation for an indexer, LMSR math for an
// off-chain quote, the book decoder, the event decoder, the IDL.

export { marketIdForQuestion } from "./adapter.js";
export {
  SolanaChainAdapter,
  type SolanaAdapterOptions,
  type AdjudicatorView,
  type MarketResolutionState,
} from "./adapter.js";
export { SoothError, notImplemented } from "./errors.js";
export type { SoothErrorInit, SoothErrorKind } from "./errors.js";

// PDA helpers and refs: an indexer mirrors the seed conventions without
// constructing an adapter.
export {
  deriveAdjudicatorEntryPda,
  deriveAmmStatePda,
  deriveLockAuthorityPda,
  deriveLockEntryPda,
  deriveLockVaultAta,
  deriveLpYieldAuthority,
  deriveMarketPda,
  deriveMarketVaultAta,
  derivePositionPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
  feePoolBookPda,
  SOOTH_CORE_PROGRAM_ID,
  type MarketId,
  type ProgramIds,
} from "./pdas.js";

// zkTLS adjudication helpers. `computeRuleHash` is the one an integrator
// cannot skip: the market's commitment must be derived exactly this way or
// no attestation will ever verify against it.
export {
  computeRuleHash,
  hexToBytes,
  toZkAttestationArg,
  MAX_ZK_VALUE_SCALE,
  ZK_COMPARATOR,
  type PrimusAttestation,
  type ZkAttestationArg,
  type ZkComparatorName,
} from "./zk.js";

export {
  encodePubkeyRef,
  decodePubkeyRef,
  encodeSignatureRef,
  SOL_REF_PREFIX,
} from "./refs.js";

// Math is public: an integrator can price a hypothetical state without the
// round trip `readQuote` makes.
export {
  WAD,
  WAD_TO_USDC_SCALAR,
  LN2_WAD,
  costDelta,
  expWad,
  lmsrCost,
  lnWad,
  wadDiv,
  wadMul,
  wadToUsdcCeil,
  wadToUsdcFloor,
  yesPriceWad,
  LmsrMathError,
} from "./math/lmsr.js";

// IDL is exported so consumers can build their own Anchor `Program`
// instances if they need read paths the adapter doesn't expose.
export { soothCoreIdl } from "./anchor/index.js";

// The orderbook (docs/design/orderbook-redesign.md).
export {
  BLOCKS_OFFSET,
  BLOCK_SIZE,
  MAX_ORDERS,
  NIL,
  NUM_TICKS,
  ONE_SHARE,
  SIDE_ASK,
  SIDE_BID,
  bookLayoutSelfCheck,
  bookPda,
  eventAuthorityPda,
  bookSpace,
  buildBookCancel,
  buildBookGrow,
  BOOK_INIT_HEAP_BYTES,
  MAX_CANCELS_PER_TX,
  buildBookInit,
  buildBookInitIxs,
  buildBookPlace,
  buildBookWithdraw,
  decodeBook,
  ladder,
  seatOf,
  type BookOrder,
  type BookRefs,
  type BookSeat,
  type BookSnapshot,
  type PlaceArgs,
} from "./book/index.js";

export {
  BOOK_EVENT_DISC,
  BOOK_EVENT_VERSION,
  CPI_EVENT_TAG,
  decodeBookEvent,
  decodeBookEventsFromInner,
  type BookEvent,
  type BookFillRecord,
  type BookFilledEvent,
  type BookOrderCancelledEvent,
  type BookOrderPlacedEvent,
} from "./book/events.js";

export {
  classifyError as classifyOrderbookError,
  type ClassifiedError as ClassifiedOrderbookError,
} from "./orderbook/error-classifier.js";

// The vendored cross-chain adapter interface — see `./types.ts`.
export * from "./types.js";
