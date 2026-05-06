// PDA derivation helpers — pure functions taking a 16-byte `marketId` and a
// program-id pair and returning the canonical PDAs that `sooth_amm` and
// `sooth_market` agree on.
//
// Seed conventions are load-bearing — they are duplicated across the on-chain
// programs and must match exactly. The canonical source is
// `packages/programs-core/programs/sooth_market/src/state/market.rs` (table
// in the module comment). Any change here must be paired with the on-chain
// constants and a workspace-wide test sweep.

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
  soothAmm: PublicKey;
  soothMarket: PublicKey;
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

function assertMarketId(marketId: MarketId): Buffer {
  if (marketId.length !== 16) {
    throw new Error(
      `marketId must be exactly 16 bytes, got ${marketId.length}`,
    );
  }
  return Buffer.from(marketId);
}

// Owned by `sooth_market`. Seeds: [b"market", market_id].
export function deriveMarketPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_MARKET), id],
    programs.soothMarket,
  );
}

// Owned by `sooth_amm`. Seeds: [b"amm", market_id].
export function deriveAmmStatePda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_AMM), id],
    programs.soothAmm,
  );
}

// Signer-only PDA owned by `sooth_market`. Seeds: [b"vault", market_id].
export function deriveVaultAuthorityPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_VAULT), id],
    programs.soothMarket,
  );
}

// Signer-only PDA owned by `sooth_market`. Seeds: [b"lock", market_id].
export function deriveLockAuthorityPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LOCK), id],
    programs.soothMarket,
  );
}

// Owned by `sooth_amm`. Seeds: [b"pos", market_id, user].
export function derivePositionPda(
  marketId: MarketId,
  user: PublicKey,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_POS), id, user.toBuffer()],
    programs.soothAmm,
  );
}

// Owned by `sooth_amm`. Seeds: [b"lock_entry", position.key(), nonce_le_u64].
//
// The chosen seed scheme is documented in
// `packages/programs-core/programs/sooth_amm/src/state/lock_entry.rs` (see
// the "Seed scheme" section). The nonce source is `Position::lock_nonce` at
// the moment of the sell — callers must read the on-chain `Position` first,
// derive the LockEntry against the *current* nonce, and only then build the
// `sell_positions` ix. The handler increments `lock_nonce` after init, so a
// subsequent sell uses a fresh PDA.
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
  // Buffer doesn't have writeBigUInt64LE on all targets prior to Node 12+;
  // Node 20 (engines.node) does. Use it directly.
  nonceBytes.writeBigUInt64LE(lockNonce, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_LOCK_ENTRY), positionPda.toBuffer(), nonceBytes],
    programs.soothAmm,
  );
}

// Owned by spl-token. Seeds: [b"mint", market_id, b"y"|b"n"]. The mint
// authority is the `vault_authority` PDA — verified at `initialize_market`.
export function deriveYesMintPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_MINT), id, Buffer.from(SEED_Y)],
    programs.soothMarket,
  );
}

export function deriveNoMintPda(
  marketId: MarketId,
  programs: ProgramIds,
): [PublicKey, number] {
  const id = assertMarketId(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_MINT), id, Buffer.from(SEED_N)],
    programs.soothMarket,
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
