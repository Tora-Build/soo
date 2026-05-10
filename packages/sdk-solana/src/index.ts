// Public surface of `@sooth/sdk-solana`. The umbrella `@sooth/sdk` (per Phase
// A in `docs/implementation-guide.md §8`) will dynamically import this
// package when `node.chainKind === "solana"` and route ChainAdapter calls
// through `SolanaChainAdapter`.

export {
  SolanaChainAdapter,
  type MintCompleteSetToProgramOwnedArgs,
  type RedeemFromProgramOwnedArgs,
  type SolanaAdapterOptions,
} from "./adapter.js";
export { SoothError, notImplemented } from "./errors.js";
export type { SoothErrorInit, SoothErrorKind } from "./errors.js";

// PDA helpers and refs are re-exported because tests + future SDK callers
// derive accounts independently of the adapter (e.g. an indexer mirroring
// the seed conventions).
export {
  deriveAdjudicatorPda,
  deriveAmmStatePda,
  deriveBookMarketPda,
  deriveBookOrderRequestQueuePda,
  deriveBookPriceLadderPda,
  deriveLockAuthorityPda,
  deriveLockEntryPda,
  deriveLockVaultAta,
  deriveLpYieldAuthority,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveNoMintPda,
  derivePositionPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
  type MarketId,
  type ProgramIds,
} from "./pdas.js";

export {
  encodePubkeyRef,
  decodePubkeyRef,
  encodeSignatureRef,
  SOL_REF_PREFIX,
} from "./refs.js";

// Math is part of the public surface — integrators sometimes want the
// off-chain LMSR cost without going through `readQuote` (e.g. simulating
// trades against a hypothetical book).
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

// IDLs are exported so consumers can build their own Anchor `Program`
// instances if they need read paths the adapter doesn't expose.
export { soothAmmIdl, soothMarketIdl, soothBookIdl } from "./anchor/index.js";

// VENDORED chain-adapter types — see top of `./types.ts` for the Phase A
// swap-out comment.
export * from "./types.js";
