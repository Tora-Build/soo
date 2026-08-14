// PDA derivation helpers — pure functions taking a 16-byte `marketId` and a
// program-id and returning the canonical PDAs that `sooth_core` uses.
//
// Seed conventions are load-bearing — they must match exactly what the
// on-chain program derives. The canonical source is
// `packages/programs-core/programs/sooth-core/src/`. Any change here must be
// paired with the on-chain constants and a workspace-wide test sweep.

import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// `marketId` is a 16-byte truncated keccak256 (architecture §2.2). The test
// fixture generates it as random bytes; production derives from
// `keccak256(question || creator || nonce)` truncated.
export type MarketId = Uint8Array;

export interface ProgramIds {
  soothCore: PublicKey;
  /** Durable-log sink invoked by `buy`. Defaults to the canonical id; a
   *  program cannot CPI into itself, so this cannot be folded into
   *  `soothCore` however much the single-program design would prefer it. */
}

const enc = new TextEncoder();
const SEED_MARKET = enc.encode("market");
const SEED_AMM = enc.encode("amm");
const SEED_VAULT = enc.encode("vault");
const SEED_LOCK = enc.encode("lock");
const SEED_LOCK_ENTRY = enc.encode("lock_entry");
const SEED_POS = enc.encode("pos");
const SEED_MINT = enc.encode("mint");
const SEED_Y = enc.encode("y");
const SEED_N = enc.encode("n");
const SEED_PROTOCOL_CONFIG = enc.encode("protocol_config");
const SEED_FEE_POOL_AUTHORITY = enc.encode("fee_pool_authority");
const SEED_LP = enc.encode("lp");
const SEED_LP_MINT_AUTHORITY = enc.encode("lp_mint_authority");
const SEED_LP_POSITION = enc.encode("lp_position");
const SEED_LP_YIELD_AUTHORITY = enc.encode("lp_yield_authority");
const SEED_MARKET_BOOK = enc.encode("market_book");
const SEED_BOOK_SIDE = enc.encode("book_side");
const SEED_ORDERBOOK_POSITION = enc.encode("orderbook_position");
const SEED_FEE_POOL_BOOK = enc.encode("fee_pool_book");
const SEED_FEE_POOL_AMM = enc.encode("fee_pool_amm");
const SEED_ADJUDICATOR = enc.encode("adjudicator");

export const SOOTH_CORE_PROGRAM_ID = new PublicKey(
  "EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw",
);


function assertMarketId(marketId: MarketId): Buffer {
  if (marketId.length !== 16) {
    throw new Error(
      `marketId must be exactly 16 bytes, got ${marketId.length}`,
    );
  }
  return Buffer.from(marketId);
}

// Owned by `sooth_core`. Seeds: [b"market", market_id].
export function deriveMarketPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_MARKET), id],
    programs.soothCore,
  );
}

// Owned by `sooth_core`. Seeds: [b"amm", market_id].
export function deriveAmmStatePda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_AMM), id],
    programs.soothCore,
  );
}

// Signer-only PDA owned by `sooth_core`. Seeds: [b"vault", market_id].
export function deriveVaultAuthorityPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_VAULT), id],
    programs.soothCore,
  );
}

// Signer-only PDA owned by `sooth_core`. Seeds: [b"lock", market_id].
export function deriveLockAuthorityPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LOCK), id],
    programs.soothCore,
  );
}

// Owned by `sooth_core`. Seeds: [b"pos", market_id, user].
export function derivePositionPda(
  marketId: MarketId,
  user: PublicKey,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_POS), id, user.toBuffer()],
    programs.soothCore,
  );
}

// Per-market `AdjudicatorEntry` PDA owned by `sooth_core`.
// Seeds: [b"adjudicator", market_pda]. Replaces the old allowlist approach.
// Required by `attest_outcome` / `register_adjudicator` ix account lists.
export function deriveAdjudicatorEntryPda(
  marketPda: PublicKey,
  programs: ProgramIds,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_ADJUDICATOR), marketPda.toBuffer()],
    programs.soothCore,
  );
}

// Owned by `sooth_core`. Seeds: [b"lock_entry", position.key(), nonce_le_u64].
//
// The chosen seed scheme is documented in the on-chain state. The nonce
// source is `Position::lock_nonce` at the moment of the sell — callers must
// read the on-chain `Position` first, derive the LockEntry against the
// *current* nonce, and only then build the `sell_positions` ix. The handler
// increments `lock_nonce` after init, so a subsequent sell uses a fresh PDA.
//
// `lockNonce` is encoded as 8 little-endian bytes (matching Anchor's
// `u64::to_le_bytes()` on the program side).
export function deriveLockEntryPda(
  positionPda: PublicKey,
  lockNonce: bigint,
  programs: ProgramIds,
): [PublicKey, number] {
  if (lockNonce < 0n || lockNonce > 0xffffffffffffffffn) {
    throw new Error(`lockNonce must fit in u64, got ${lockNonce.toString()}`);
  }
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(lockNonce, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LOCK_ENTRY), positionPda.toBuffer(), nonceBytes],
    programs.soothCore,
  );
}

// SPL mint PDA for YES outcome tokens.
// Seeds: [b"mint", market_id, b"y"]. Owned by spl-token program;
// the mint authority is the `vault_authority` PDA.
export function deriveYesMintPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_MINT), id, Buffer.from(SEED_Y)],
    programs.soothCore,
  );
}

export function deriveNoMintPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_MINT), id, Buffer.from(SEED_N)],
    programs.soothCore,
  );
}

// Vault USDC ATA (associated token address; not a PDA in the seed sense).
// Owner = `vault_authority` PDA.
export function deriveMarketVaultAta(
  marketId: MarketId,
  usdcMint: PublicKey,
  programs: ProgramIds,
): PublicKey {
  const [vaultAuth] = deriveVaultAuthorityPda(marketId, programs);
  return getAssociatedTokenAddressSync(
    usdcMint,
    vaultAuth,
    /* allowOwnerOffCurve */ true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

export function deriveLockVaultAta(
  marketId: MarketId,
  usdcMint: PublicKey,
  programs: ProgramIds,
): PublicKey {
  const [lockAuth] = deriveLockAuthorityPda(marketId, programs);
  return getAssociatedTokenAddressSync(
    usdcMint,
    lockAuth,
    /* allowOwnerOffCurve */ true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

// Convenience: the user's USDC ATA, off-curve permitted (handles PDA owners).
export function deriveUserUsdcAta(
  user: PublicKey,
  usdcMint: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(usdcMint, user, true);
}

// Owned by `sooth_core`. Seeds: [b"protocol_config"]. Singleton — there
// is exactly one of these per cluster deploy.
export function deriveProtocolConfigPda(
  programs: Pick<ProgramIds, "soothCore">,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_PROTOCOL_CONFIG)],
    programs.soothCore,
  );
}

// Owned by `sooth_core`. Seeds: [b"fee_pool_authority"]. Singleton —
// there is exactly one of these per cluster deploy. Used as the authority
// (token::authority) on the global `fee_pool_vault` USDC ATA.
export function deriveFeePoolAuthorityPda(
  programs: Pick<ProgramIds, "soothCore">,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_FEE_POOL_AUTHORITY)],
    programs.soothCore,
  );
}

// Global fee-pool USDC ATA. Owner = `fee_pool_authority` PDA.
// Off-curve permitted because the owner is a PDA.
export function deriveFeePoolVaultAta(
  usdcMint: PublicKey,
  programs: Pick<ProgramIds, "soothCore">,
): PublicKey {
  const [authority] = deriveFeePoolAuthorityPda(programs);
  return getAssociatedTokenAddressSync(
    usdcMint,
    authority,
    /* allowOwnerOffCurve */ true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

// Per-market LP token mint owned by `sooth_core`. Seeds: [b"lp", market_id].
export function deriveLpMintPda(
  marketId: MarketId,
  programs: Pick<ProgramIds, "soothCore">,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LP), id],
    programs.soothCore,
  );
}

// Per-market signer-only PDA owned by `sooth_core`. The mint authority on the
// per-market LP mint. Seeds: [b"lp_mint_authority", market_id].
export function deriveLpMintAuthorityPda(
  marketId: MarketId,
  programs: Pick<ProgramIds, "soothCore">,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LP_MINT_AUTHORITY), id],
    programs.soothCore,
  );
}

// Singleton signer-only PDA owned by `sooth_core`. Seeds: [b"lp_yield_authority"].
// Used as the token authority on the LP-yield USDC vault drained by `redeem_lp`.
export function deriveLpYieldAuthority(
  programs: Pick<ProgramIds, "soothCore">,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LP_YIELD_AUTHORITY)],
    programs.soothCore,
  );
}

// Per-(creator, market) LP claim record owned by `sooth_core`.
// Seeds: [b"lp_position", market_id, creator].
export function deriveLpPositionPda(
  marketId: MarketId,
  creator: PublicKey,
  programs: Pick<ProgramIds, "soothCore">,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LP_POSITION), id, creator.toBuffer()],
    programs.soothCore,
  );
}

// User's LP-token ATA. Off-curve permitted because the LP mint may have
// PDA-owned token accounts.
export function deriveUserLpAta(user: PublicKey, lpMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    lpMint,
    user,
    /* allowOwnerOffCurve */ true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

// ─── sooth_core orderbook PDA helpers ───────────────────────────────────────

type OrderbookProgramIds = Partial<Pick<ProgramIds, "soothCore">>;

function orderbookProgramId(
  programs: OrderbookProgramIds | undefined,
): PublicKey {
  return programs?.soothCore ?? SOOTH_CORE_PROGRAM_ID;
}

// MarketBook: one PDA per orderbook-enabled market, owned by sooth_core.
export function marketBookPda(
  marketId: Uint8Array,
  programs?: Partial<Pick<ProgramIds, "soothCore">>,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_MARKET_BOOK), id],
    orderbookProgramId(programs),
  );
}

// BookSide: one PDA per populated (market, side, tick), owned by sooth_core.
// side: 0 = AGAINST, 1 = FOR. Tick is encoded as Rust `u16::to_le_bytes()`.
export function bookSidePda(
  marketId: Uint8Array,
  side: 0 | 1,
  tick: number,
  programs?: Partial<Pick<ProgramIds, "soothCore">>,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  if (!Number.isInteger(tick) || tick < 0 || tick > 0xffff) {
    throw new Error(`tick must fit in u16, got ${tick}`);
  }
  const tickBuf = Buffer.alloc(2);
  tickBuf.writeUInt16LE(tick, 0);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED_BOOK_SIDE),
      id,
      Buffer.from([side]),
      tickBuf,
    ],
    orderbookProgramId(programs),
  );
}

// OrderbookPosition: one PDA per (market, user), owned by sooth_core.
export function orderbookPositionPda(
  marketId: Uint8Array,
  user: PublicKey,
  programs?: Partial<Pick<ProgramIds, "soothCore">>,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_ORDERBOOK_POSITION), id, user.toBuffer()],
    orderbookProgramId(programs),
  );
}

// Fee pools: one TokenAccount per market PER VENUE, owned by sooth_core.
//
// Two, because an SPL token account holds exactly one mint and the venues are
// denominated differently. Distinct seed literals rather than one seed plus
// the mint, so the venue is fixed by the derivation and a caller cannot hand
// an instruction the other venue's pool.
export function feePoolBookPda(
  marketId: Uint8Array,
  programs?: Partial<Pick<ProgramIds, "soothCore">>,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_FEE_POOL_BOOK), id],
    orderbookProgramId(programs),
  );
}

/** THIS market's AMM-side LP yield vault. Seeds: [b"lp_yield_amm", market_id].
 *  Per-market on purpose: the global predecessor let one market's LPs claim
 *  every market's yield. */
export function lpYieldAmmPda(
  marketId: MarketId,
  programs: Pick<ProgramIds, "soothCore">,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_yield_amm"), id],
    programs.soothCore,
  );
}

/** THIS market's book-side LP yield vault. Seeds: [b"lp_yield_book", market_id]. */
export function lpYieldBookPda(
  marketId: MarketId,
  programs: Pick<ProgramIds, "soothCore">,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_yield_book"), id],
    programs.soothCore,
  );
}

export function feePoolAmmPda(
  marketId: Uint8Array,
  programs?: Partial<Pick<ProgramIds, "soothCore">>,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_FEE_POOL_AMM), id],
    orderbookProgramId(programs),
  );
}
