// Adapter-direct helpers used by specs that need pre-state set up (a buy
// before sell, a settle before redeem) or that exercise actions the demo
// UI does not surface (mint/merge complete-set, attest_outcome, redeem
// pre-settlement). Uses Anchor + the IDLs directly with the test wallet
// keypair — faster than spinning up the full SolanaChainAdapter.
//
// IMPORTANT: per skill rule, the action UNDER TEST goes through the UI;
// these helpers exist for setup and for explicitly-marked "adapter-direct"
// specs (e.g. settle, attest, mint complete-set — paths the demo doesn't
// surface).

import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SDK_ANCHOR_DIR = resolve(
  REPO_ROOT,
  "packages",
  "sdk-solana",
  "src",
  "anchor",
);

function loadIdl(name: string): any {
  return JSON.parse(
    readFileSync(resolve(SDK_ANCHOR_DIR, `${name}.json`), "utf8"),
  );
}

export const ammIdl = loadIdl("sooth_amm");
export const marketIdl = loadIdl("sooth_market");
export const launchpadIdl = loadIdl("sooth_launchpad");
export const adjudicatorIdl = loadIdl("sooth_adjudicator");
export const bookIdl = loadIdl("sooth_book");

const SOOTH_BOOK_DEFAULT_PROGRAM_ID = new PublicKey(
  "5gAMjRCaZfb4NtHmBf2RZHFJVLAAZQ1PBP6dRNPUTxkH",
);

function programIdOrFallback(idlAddress: unknown, fallback: PublicKey): PublicKey {
  return typeof idlAddress === "string" && idlAddress.length > 0
    ? new PublicKey(idlAddress)
    : fallback;
}

export const ammProgramId = new PublicKey(ammIdl.address);
export const marketProgramId = new PublicKey(marketIdl.address);
export const launchpadProgramId = new PublicKey(launchpadIdl.address);
export const adjudicatorProgramId = new PublicKey(adjudicatorIdl.address);
export const bookProgramId = programIdOrFallback(
  bookIdl.address,
  SOOTH_BOOK_DEFAULT_PROGRAM_ID,
);
const bookProgramIdl = { ...bookIdl, address: bookProgramId.toBase58() };

// ─── Test wallet keypair ────────────────────────────────────────────────
//
// Default path matches what `pnpm dev:localnet` writes (seed-localnet.mjs
// → .localnet/user-keypair.json), so a fresh boot needs no extra env
// plumbing. Two override paths for non-default setups:
//   - TEST_KEYPAIR_PATH=/abs/path.json — load from disk
//   - VITE_TEST_KEYPAIR_BYTES=[1,2,...] — inline JSON byte array
// VITE_TEST_KEYPAIR_BYTES wins when both are set so CI matches the
// browser-side LocalKeypairAdapter the dapp consumes.
const DEMO_DIR = resolve(__dirname, "..", "..");
const LOCALNET_ENV_PATH = resolve(DEMO_DIR, ".localnet", ".env.local");
const DEMO_ENV_PATH = resolve(DEMO_DIR, ".env.local");
const DEFAULT_TEST_KEYPAIR_PATH = resolve(
  DEMO_DIR,
  ".localnet",
  "user-keypair.json",
);

export function loadTestKeypair(): Keypair {
  const inlineBytes = process.env.VITE_TEST_KEYPAIR_BYTES;
  if (inlineBytes) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(inlineBytes)));
  }
  const path = process.env.TEST_KEYPAIR_PATH ?? DEFAULT_TEST_KEYPAIR_PATH;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    out[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return out;
}

function readE2eEnvValue(name: string): string | undefined {
  return (
    process.env[name] ??
    parseEnvFile(LOCALNET_ENV_PATH)[name] ??
    parseEnvFile(DEMO_ENV_PATH)[name]
  );
}

function readE2eEnvPublicKey(name: string): PublicKey {
  const value = readE2eEnvValue(name);
  if (!value) {
    throw new Error(
      `${name} missing; run node apps/demo/scripts/seed-localnet.mjs init first`,
    );
  }
  return new PublicKey(value);
}

// ─── Anchor program factories ───────────────────────────────────────────

function makeProvider(
  conn: Connection,
  signer: Keypair,
): anchor.AnchorProvider {
  const wallet: anchor.Wallet = {
    publicKey: signer.publicKey,
    payer: signer,
    signTransaction: async (tx: any) => {
      if (tx.partialSign) tx.partialSign(signer);
      else tx.sign([signer]);
      return tx;
    },
    signAllTransactions: async (txs: any[]) => {
      for (const tx of txs) {
        if (tx.partialSign) tx.partialSign(signer);
        else tx.sign([signer]);
      }
      return txs;
    },
  };
  return new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

export interface ProgramHandles {
  amm: anchor.Program;
  market: anchor.Program;
  launchpad: anchor.Program;
  adjudicator: anchor.Program;
  book: anchor.Program;
}

export function makePrograms(
  conn: Connection,
  signer: Keypair,
): ProgramHandles {
  const provider = makeProvider(conn, signer);
  return {
    amm: new anchor.Program(ammIdl, provider),
    market: new anchor.Program(marketIdl, provider),
    launchpad: new anchor.Program(launchpadIdl, provider),
    adjudicator: new anchor.Program(adjudicatorIdl, provider),
    book: new anchor.Program(bookProgramIdl, provider),
  };
}

// ─── PDA helpers (mirror packages/sdk-solana/src/pdas.ts) ───────────────

export function deriveMarketPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), marketId],
    marketProgramId,
  )[0];
}
export function deriveAmmStatePda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("amm"), marketId],
    ammProgramId,
  )[0];
}
export function deriveVaultAuthorityPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketId],
    marketProgramId,
  )[0];
}
export function deriveLockAuthorityPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lock"), marketId],
    marketProgramId,
  )[0];
}
export function derivePositionPda(
  marketId: Buffer,
  user: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pos"), marketId, user.toBuffer()],
    ammProgramId,
  )[0];
}
export function deriveLockEntryPda(
  positionPda: PublicKey,
  lockNonce: bigint,
): PublicKey {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(lockNonce, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lock_entry"), positionPda.toBuffer(), nonceBytes],
    ammProgramId,
  )[0];
}
export function deriveYesMintPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), marketId, Buffer.from("y")],
    marketProgramId,
  )[0];
}
export function deriveNoMintPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), marketId, Buffer.from("n")],
    marketProgramId,
  )[0];
}
export function deriveProtocolConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    launchpadProgramId,
  )[0];
}
export function deriveFeePoolAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_pool_authority")],
    launchpadProgramId,
  )[0];
}
export function deriveLpMintPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), marketId],
    launchpadProgramId,
  )[0];
}
export function deriveLpMintAuthorityPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint_authority"), marketId],
    launchpadProgramId,
  )[0];
}
export function deriveLpYieldAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_yield_authority")],
    launchpadProgramId,
  )[0];
}
export function deriveAdjudicatorPda(marketPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("adjudicator"), marketPda.toBuffer()],
    adjudicatorProgramId,
  )[0];
}
export function deriveBookMarketPda(soothMarketPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), soothMarketPda.toBuffer()],
    bookProgramId,
  )[0];
}
export function deriveBookEscrowAuthorityPda(
  bookMarketPda: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), bookMarketPda.toBuffer()],
    bookProgramId,
  )[0];
}
export function deriveBookFundingPda(bookMarketPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("funding"), bookMarketPda.toBuffer()],
    bookProgramId,
  )[0];
}
export function deriveBookMarketLiquiditiesPda(
  bookMarketPda: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liquidities"), bookMarketPda.toBuffer()],
    bookProgramId,
  )[0];
}
export function deriveBookMatchingQueuePda(
  bookMarketPda: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("matching"), bookMarketPda.toBuffer()],
    bookProgramId,
  )[0];
}
export function deriveBookOrderRequestQueuePda(
  bookMarketPda: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order_request"), bookMarketPda.toBuffer()],
    bookProgramId,
  )[0];
}
export function deriveBookMarketOutcomePda(
  bookMarketPda: PublicKey,
  outcomeIndex: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [bookMarketPda.toBuffer(), Buffer.from(String(outcomeIndex))],
    bookProgramId,
  )[0];
}
export function deriveBookPriceLadderPda(
  authority: PublicKey,
  distinctSeed: string,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("price_ladder"),
      authority.toBuffer(),
      Buffer.from(distinctSeed),
    ],
    bookProgramId,
  )[0];
}
export function deriveBookMarketTypePda(name: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_type"), Buffer.from(name)],
    bookProgramId,
  )[0];
}
export function deriveBookAuthorisedOperatorsPda(
  operatorType: "ADMIN" | "MARKET" | "CRANK",
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("authorised_operators"), Buffer.from(operatorType)],
    bookProgramId,
  )[0];
}

// ─── Position / LockEntry account fetch + decode ────────────────────────
//
// We could load via Anchor's coder but a hand-rolled decode is faster and
// avoids loading the full Program type machinery for simple reads.

export interface PositionState {
  yesShares: bigint; // i128
  noShares: bigint; // i128
  lockedCostUsdc: bigint;
  lockNonce: bigint;
}

export async function fetchPosition(
  conn: Connection,
  positionPda: PublicKey,
): Promise<PositionState | null> {
  const info = await conn.getAccountInfo(positionPda);
  if (!info) return null;
  const data = info.data;
  // disc(8) + user(32) + market(32) + yes_shares(i128 LE @ 72) + no_shares(i128 LE @ 88)
  // + locked_cost_usdc(u64 @ 104) + lock_nonce(u64 @ 112)
  const lo = data.readBigUInt64LE(72);
  const hi = data.readBigInt64LE(80);
  const yesShares = (hi << 64n) | lo;
  const lo2 = data.readBigUInt64LE(88);
  const hi2 = data.readBigInt64LE(96);
  const noShares = (hi2 << 64n) | lo2;
  const lockedCostUsdc = data.readBigUInt64LE(104);
  const lockNonce = data.readBigUInt64LE(112);
  return { yesShares, noShares, lockedCostUsdc, lockNonce };
}

export interface LockEntryState {
  user: PublicKey;
  market: PublicKey;
  amountUsdc: bigint;
  unlockAt: bigint;
  nonce: bigint;
}

export async function fetchLockEntry(
  conn: Connection,
  lockEntryPda: PublicKey,
): Promise<LockEntryState | null> {
  const info = await conn.getAccountInfo(lockEntryPda);
  if (!info) return null;
  const d = info.data;
  // disc(8) + user(32 @ 8) + market(32 @ 40) + amount_usdc(u64 @ 72) + unlock_at(i64 @ 80) + nonce(u64 @ 88)
  return {
    user: new PublicKey(d.subarray(8, 40)),
    market: new PublicKey(d.subarray(40, 72)),
    amountUsdc: d.readBigUInt64LE(72),
    unlockAt: d.readBigInt64LE(80),
    nonce: d.readBigUInt64LE(88),
  };
}

// ─── Adjudicator account fetch (attested_outcome) ───────────────────────
//
// Layout (per packages/sdk-solana/src/anchor/sooth_adjudicator.json types
// → Adjudicator struct, Anchor-default ordering):
//   disc(8)
//   market(Pubkey, 32)              @ 8
//   authority(Pubkey, 32)           @ 40
//   dispute_authority(Pubkey, 32)   @ 72
//   kind(AdjudicatorKind enum, 1+)  @ 104  // Manual = unit variant → 1 byte
//   attested_outcome(Option<u8>, 2) @ 105  // 1 byte tag + 1 byte payload
//
// We only need attested_outcome here; Manual variant tag check is one byte.

export interface AdjudicatorState {
  market: PublicKey;
  authority: PublicKey;
  attestedOutcome: number | null; // null → Option::None
}

export async function fetchAdjudicator(
  conn: Connection,
  adjudicatorPda: PublicKey,
): Promise<AdjudicatorState | null> {
  const info = await conn.getAccountInfo(adjudicatorPda);
  if (!info) return null;
  const d = info.data;
  // attested_outcome field starts after kind(=1 byte for Manual unit variant).
  // Option<u8>: byte[0] = 0 (None) or 1 (Some), byte[1] = payload if Some.
  const tag = d.readUInt8(105);
  const attestedOutcome = tag === 1 ? d.readUInt8(106) : null;
  return {
    market: new PublicKey(d.subarray(8, 40)),
    authority: new PublicKey(d.subarray(40, 72)),
    attestedOutcome,
  };
}

export interface AmmStateAccount {
  market: PublicKey;
  qYes: bigint;
  qNo: bigint;
  b: bigint;
  seedQYes: bigint;
  seedQNo: bigint;
  feeBBaseWad: bigint;
  trialEndAt: bigint;
  isGraduated: boolean;
  isDismissed: boolean;
}

function readI128LE(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export async function fetchAmmState(
  conn: Connection,
  ammStatePda: PublicKey,
): Promise<AmmStateAccount | null> {
  const info = await conn.getAccountInfo(ammStatePda);
  if (!info) return null;
  const d = info.data;
  return {
    market: new PublicKey(d.subarray(8, 40)),
    qYes: readI128LE(d, 40),
    qNo: readI128LE(d, 56),
    b: readI128LE(d, 72),
    seedQYes: readI128LE(d, 88),
    seedQNo: readI128LE(d, 104),
    feeBBaseWad: d.readBigUInt64LE(120) | (d.readBigUInt64LE(128) << 64n),
    trialEndAt: d.readBigInt64LE(136),
    isGraduated: d[144] !== 0,
    isDismissed: d[145] !== 0,
  };
}

// ─── Market account fetch (lifecycle + winning_outcome) ─────────────────
//
// Market layout: disc(8) + market_id[16](8) + creator(32 @ 24) + adjudicator(32 @ 56) +
// usdc_mint(32 @ 88) + yes_mint(32 @ 120) + no_mint(32 @ 152) + vault(32 @ 184) +
// lock_vault(32 @ 216) + vault_authority(32 @ 248) + lock_authority(32 @ 280) +
// adjudicator_pda(32 @ 312) + question_hash[32](32 @ 344) + start_time(i64 @ 376) +
// deadline(i64 @ 384) + lifecycle(u8 @ 392) + winning_outcome(u8 @ 393) + ...
//
// We only need lifecycle + winning_outcome here — other fields are read
// by spec-specific paths.

export interface MarketState {
  creator: PublicKey;
  adjudicator: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  lockVault: PublicKey;
  startTime: bigint;
  deadline: bigint;
  lifecycle: number; // 0=Initializing, 1=Open, 2=Locked, 3=Settled
  winningOutcome: number;
}

export async function fetchMarket(
  conn: Connection,
  marketPda: PublicKey,
): Promise<MarketState | null> {
  const info = await conn.getAccountInfo(marketPda);
  if (!info) return null;
  const d = info.data;
  return {
    creator: new PublicKey(d.subarray(24, 56)),
    adjudicator: new PublicKey(d.subarray(56, 88)),
    yesMint: new PublicKey(d.subarray(120, 152)),
    noMint: new PublicKey(d.subarray(152, 184)),
    vault: new PublicKey(d.subarray(184, 216)),
    lockVault: new PublicKey(d.subarray(216, 248)),
    // Layout per packages/programs-core/programs/sooth_market/src/state/market.rs:
    //   8..24    market_id (16)
    //   24..56   creator (32)
    //   56..88   adjudicator (32)
    //   88..120  question_hash (32)
    //   120..152 yes_mint
    //   152..184 no_mint
    //   184..216 vault
    //   216..248 lock_vault
    //   248..256 start_time (i64)
    //   256..264 deadline (i64)
    //   264      lifecycle (u8 enum tag)
    //   265      winning_outcome (u8)
    //   266..271 5 bumps (u8)
    startTime: d.readBigInt64LE(248),
    deadline: d.readBigInt64LE(256),
    lifecycle: d.readUInt8(264),
    winningOutcome: d.readUInt8(265),
  };
}

// ─── BN coercion ────────────────────────────────────────────────────────

const BN = anchor.BN;

export function bn(v: bigint | number | string): anchor.BN {
  return new BN(v.toString());
}

let directBuySalt = 0;

function nextDirectBuyComputeUnitPrice(): number {
  directBuySalt = (directBuySalt % 1_000_000) + 1;
  return directBuySalt;
}

// ─── Adapter-direct buy via Anchor (used as setup for sell/claim specs) ─
//
// Mirrors SolanaChainAdapter.buildTrade — same accounts, same data. We use
// it directly here (rather than instantiating SolanaChainAdapter) because
// the SDK adapter requires a node config + signer adapter; for setup it's
// simpler to drive the on-chain ix straight through Anchor.

export async function buyViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  marketPda: PublicKey;
  marketId: Buffer;
  usdcMint: PublicKey;
  outcome: 0 | 1;
  deltaShares: bigint; // WAD
  maxCostWad: bigint;
}): Promise<string> {
  const {
    conn,
    signer,
    marketPda,
    marketId,
    usdcMint,
    outcome,
    deltaShares,
    maxCostWad,
  } = args;
  const programs = makePrograms(conn, signer);

  const ammPda = deriveAmmStatePda(marketId);
  const positionPda = derivePositionPda(marketId, signer.publicKey);
  const vaultAuthority = deriveVaultAuthorityPda(marketId);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, signer.publicKey);
  const marketVault = getAssociatedTokenAddressSync(
    usdcMint,
    vaultAuthority,
    true,
  );
  const protocolConfig = deriveProtocolConfigPda();
  const feePoolAuthority = deriveFeePoolAuthorityPda();
  const feePoolVault = getAssociatedTokenAddressSync(
    usdcMint,
    feePoolAuthority,
    true,
  );
  const lpMint = deriveLpMintPda(marketId);
  const lpMintAuthority = deriveLpMintAuthorityPda(marketId);
  const userLpAta = getAssociatedTokenAddressSync(
    lpMint,
    signer.publicKey,
    true,
  );

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    // Repeated setup buys can otherwise produce identical signatures when
    // Surfpool returns the same recent blockhash for the same signer + ix.
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: nextDirectBuyComputeUnitPrice(),
    }),
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      userLpAta,
      signer.publicKey,
      lpMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  const ix = await (programs.amm.methods as any)
    .tradePositions(outcome, bn(deltaShares), bn(maxCostWad))
    .accounts({
      market: marketPda,
      ammState: ammPda,
      position: positionPda,
      vaultAuthority,
      userUsdcAta,
      marketVault,
      usdcMint,
      protocolConfig,
      feePoolVault,
      lpMint,
      lpMintAuthority,
      userLpAta,
      user: signer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      soothLaunchpadProgram: launchpadProgramId,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [signer], {
    commitment: "confirmed",
  });
}

// ─── Adapter-direct sell ─────────────────────────────────────────────────

export async function sellViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  marketPda: PublicKey;
  marketId: Buffer;
  usdcMint: PublicKey;
  outcome: 0 | 1;
  deltaShares: bigint; // POSITIVE WAD; sign flipped on-wire
  minProceedsWad?: bigint;
}): Promise<{ sig: string; lockEntryPda: PublicKey }> {
  const {
    conn,
    signer,
    marketPda,
    marketId,
    usdcMint,
    outcome,
    deltaShares,
    minProceedsWad = 0n,
  } = args;
  const programs = makePrograms(conn, signer);

  const ammPda = deriveAmmStatePda(marketId);
  const positionPda = derivePositionPda(marketId, signer.publicKey);
  const vaultAuthority = deriveVaultAuthorityPda(marketId);
  const lockAuthority = deriveLockAuthorityPda(marketId);
  const marketVault = getAssociatedTokenAddressSync(
    usdcMint,
    vaultAuthority,
    true,
  );
  const lockVault = getAssociatedTokenAddressSync(
    usdcMint,
    lockAuthority,
    true,
  );

  const pos = await fetchPosition(conn, positionPda);
  if (!pos) throw new Error("sellViaAdapter: position not found");
  const lockEntryPda = deriveLockEntryPda(positionPda, pos.lockNonce);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  const ix = await (programs.amm.methods as any)
    .sellPositions(outcome, bn(-deltaShares), bn(minProceedsWad))
    .accounts({
      market: marketPda,
      ammState: ammPda,
      position: positionPda,
      vaultAuthority,
      lockAuthority,
      marketVault,
      lockVault,
      lockEntry: lockEntryPda,
      usdcMint,
      user: signer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      soothMarketProgram: marketProgramId,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  tx.add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [signer], {
    commitment: "confirmed",
  });
  return { sig, lockEntryPda };
}

// ─── Adapter-direct claim_unlocked ──────────────────────────────────────

export async function claimUnlockedViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  marketPda: PublicKey;
  marketId: Buffer;
  usdcMint: PublicKey;
  lockEntryPda: PublicKey;
}): Promise<string> {
  const { conn, signer, marketPda, marketId, usdcMint, lockEntryPda } = args;
  const programs = makePrograms(conn, signer);
  const positionPda = derivePositionPda(marketId, signer.publicKey);
  const lockAuthority = deriveLockAuthorityPda(marketId);
  const lockVault = getAssociatedTokenAddressSync(
    usdcMint,
    lockAuthority,
    true,
  );
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, signer.publicKey);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const ix = await (programs.amm.methods as any)
    .claimUnlocked()
    .accounts({
      market: marketPda,
      position: positionPda,
      lockEntry: lockEntryPda,
      lockAuthority,
      lockVault,
      userUsdcAta,
      usdcMint,
      user: signer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      soothMarketProgram: marketProgramId,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [signer], {
    commitment: "confirmed",
  });
}

// ─── Adapter-direct mint_complete_set ────────────────────────────────────

export async function mintCompleteSetViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  marketPda: PublicKey;
  marketId: Buffer;
  usdcMint: PublicKey;
  amount: bigint; // u64 base units (6-decimal USDC)
}): Promise<string> {
  const { conn, signer, marketPda, marketId, usdcMint, amount } = args;
  const programs = makePrograms(conn, signer);
  const vaultAuthority = deriveVaultAuthorityPda(marketId);
  const yesMint = deriveYesMintPda(marketId);
  const noMint = deriveNoMintPda(marketId);
  const vault = getAssociatedTokenAddressSync(usdcMint, vaultAuthority, true);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, signer.publicKey);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, signer.publicKey);
  const userNoAta = getAssociatedTokenAddressSync(noMint, signer.publicKey);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  // Idempotent ATA creates for outcome tokens — neither mint_complete_set
  // nor merge_complete_set initialise the ATAs themselves.
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      userYesAta,
      signer.publicKey,
      yesMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      userNoAta,
      signer.publicKey,
      noMint,
    ),
  );
  const ix = await (programs.market.methods as any)
    .mintCompleteSet(bn(amount))
    .accounts({
      market: marketPda,
      vaultAuthority,
      yesMint,
      noMint,
      vault,
      userUsdcAta,
      userYesAta,
      userNoAta,
      user: signer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [signer], {
    commitment: "confirmed",
  });
}

export async function mergeCompleteSetViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  marketPda: PublicKey;
  marketId: Buffer;
  usdcMint: PublicKey;
  amount: bigint;
}): Promise<string> {
  const { conn, signer, marketPda, marketId, usdcMint, amount } = args;
  const programs = makePrograms(conn, signer);
  const vaultAuthority = deriveVaultAuthorityPda(marketId);
  const yesMint = deriveYesMintPda(marketId);
  const noMint = deriveNoMintPda(marketId);
  const vault = getAssociatedTokenAddressSync(usdcMint, vaultAuthority, true);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, signer.publicKey);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, signer.publicKey);
  const userNoAta = getAssociatedTokenAddressSync(noMint, signer.publicKey);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const ix = await (programs.market.methods as any)
    .mergeCompleteSet(bn(amount))
    .accounts({
      market: marketPda,
      vaultAuthority,
      yesMint,
      noMint,
      vault,
      userUsdcAta,
      userYesAta,
      userNoAta,
      user: signer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [signer], {
    commitment: "confirmed",
  });
}

// ─── Adapter-direct settle (operator path) ──────────────────────────────
//
// Drives sooth_adjudicator::attest_outcome with a creator-keypair signer
// (the registered authority on the per-market Adjudicator PDA). Composes
// with sooth_market::settle via CPI; on success Market.lifecycle = Settled,
// Market.winning_outcome = winningOutcome.
//
// For the demo localnet seed, the creator wallet is the adjudicator
// authority. Loading creator-keypair.json from .localnet/ and signing
// directly is the same pattern global-setup.ts uses for seed_lp.

const CREATOR_KEYPAIR_PATH = resolve(
  __dirname,
  "..",
  "..",
  ".localnet",
  "creator-keypair.json",
);

export function loadCreatorKeypair(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(CREATOR_KEYPAIR_PATH, "utf8"))),
  );
}

const MINT_AUTHORITY_KEYPAIR_PATH = resolve(
  __dirname,
  "..",
  "..",
  ".localnet",
  "mint-authority.json",
);

export function loadMintAuthorityKeypair(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(MINT_AUTHORITY_KEYPAIR_PATH, "utf8")),
    ),
  );
}

export interface FreshMarketSetup {
  marketId: Buffer;
  marketPda: PublicKey;
  ammStatePda: PublicKey;
  lpMint: PublicKey;
  creatorLpAta: PublicKey;
}

export async function createSeededMarketViaAdapter(args: {
  conn: Connection;
  creator: Keypair;
  usdcMint: PublicKey;
  question?: string;
  marketId?: Buffer;
  initialB?: bigint;
  startTime?: bigint;
  deadline: bigint;
}): Promise<FreshMarketSetup> {
  const setup = await createMarketViaAdapter(args);
  await registerAdjudicatorViaAdapter({
    conn: args.conn,
    signer: args.creator,
    marketPda: setup.marketPda,
    authority: args.creator.publicKey,
  });
  await seedLpViaAdapter({
    conn: args.conn,
    creator: args.creator,
    marketPda: setup.marketPda,
    marketId: setup.marketId,
    initialB: args.initialB ?? 1_000n * 10n ** 18n,
  });
  return setup;
}

export interface FreshOrderbookMarketSetup {
  soothMarketPda: PublicKey;
  marketId: Buffer;
  yesMint: PublicKey;
  noMint: PublicKey;
  bookMarketPda: PublicKey;
  escrowAuthority: PublicKey;
  escrowYesAta: PublicKey;
  escrowNoAta: PublicKey;
  marketLiquidities: PublicKey;
  matchingQueue: PublicKey;
  orderRequestQueue: PublicKey;
  outcomeYesPda: PublicKey;
  outcomeNoPda: PublicKey;
  priceLadderPda: PublicKey;
  marketTypePda: PublicKey;
}

export async function createSeededOrderbookMarketViaAdapter(args: {
  conn: Connection;
  creator: Keypair;
  usdcMint: PublicKey;
  existingSoothMarket?: FreshMarketSetup;
  question?: string;
  deadline?: bigint;
  bookTitle?: string;
  marketLockTimestamp?: bigint;
  eventStartTimestamp?: bigint;
}): Promise<FreshOrderbookMarketSetup> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const defaultDeadline = now + 7n * 24n * 60n * 60n;
  const sm =
    args.existingSoothMarket ??
    (await createSeededMarketViaAdapter({
      conn: args.conn,
      creator: args.creator,
      usdcMint: args.usdcMint,
      question: args.question ?? `orderbook market ${Date.now()}`,
      deadline: args.deadline ?? defaultDeadline,
    }));

  const programs = makePrograms(args.conn, args.creator);
  const priceLadderPda = readE2eEnvPublicKey(
    "VITE_SOOTH_BOOK_PRICE_LADDER_PDA",
  );
  const marketTypePda = readE2eEnvPublicKey(
    "VITE_SOOTH_BOOK_MARKET_TYPE_PDA",
  );
  const marketOperatorsPda = deriveBookAuthorisedOperatorsPda("MARKET");
  const yesMint = deriveYesMintPda(sm.marketId);
  const noMint = deriveNoMintPda(sm.marketId);
  const bookMarketPda = deriveBookMarketPda(sm.marketPda);
  const escrowAuthority = deriveBookEscrowAuthorityPda(bookMarketPda);
  const escrowYesAta = getAssociatedTokenAddressSync(
    yesMint,
    escrowAuthority,
    true,
  );
  const escrowNoAta = getAssociatedTokenAddressSync(
    noMint,
    escrowAuthority,
    true,
  );
  const funding = deriveBookFundingPda(bookMarketPda);
  const marketLiquidities = deriveBookMarketLiquiditiesPda(bookMarketPda);
  const matchingQueue = deriveBookMatchingQueuePda(bookMarketPda);
  const orderRequestQueue = deriveBookOrderRequestQueuePda(bookMarketPda);
  const outcomeYesPda = deriveBookMarketOutcomePda(bookMarketPda, 0);
  const outcomeNoPda = deriveBookMarketOutcomePda(bookMarketPda, 1);
  const bookMarketInfo = await args.conn.getAccountInfo(bookMarketPda);

  if (!bookMarketInfo) {
    const marketLockTimestamp =
      args.marketLockTimestamp ?? args.deadline ?? defaultDeadline;
    const eventStartTimestamp =
      args.eventStartTimestamp ?? marketLockTimestamp;
    const bookTitle =
      args.bookTitle ?? args.question ?? `Orderbook ${Date.now()}`;

    await (programs.book.methods as any)
      .createMarket(
        sm.marketPda,
        sm.marketPda,
        null,
        null,
        bookTitle,
        3,
        bn(marketLockTimestamp),
        bn(eventStartTimestamp),
        { none: {} },
      )
      .accounts({
        existingMarket: null,
        market: bookMarketPda,
        escrow: escrowAuthority,
        marketType: marketTypePda,
        funding,
        rent: SYSVAR_RENT_PUBKEY,
        mint: args.usdcMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        marketOperator: args.creator.publicKey,
        authorisedOperators: marketOperatorsPda,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ])
      .signers([args.creator])
      .rpc();

    // Current MarketOutcome accounts reserve 320 inline-price slots; the
    // 999-tick ladder is attached through the singleton PriceLadder account.
    await (programs.book.methods as any)
      .initializeMarketOutcome("YES")
      .accounts({
        systemProgram: SystemProgram.programId,
        outcome: outcomeYesPda,
        priceLadder: priceLadderPda,
        market: bookMarketPda,
        marketOperator: args.creator.publicKey,
        authorisedOperators: marketOperatorsPda,
      })
      .signers([args.creator])
      .rpc();

    await (programs.book.methods as any)
      .initializeMarketOutcome("NO")
      .accounts({
        systemProgram: SystemProgram.programId,
        outcome: outcomeNoPda,
        priceLadder: priceLadderPda,
        market: bookMarketPda,
        marketOperator: args.creator.publicKey,
        authorisedOperators: marketOperatorsPda,
      })
      .signers([args.creator])
      .rpc();

    await (programs.book.methods as any)
      .openMarket()
      .accounts({
        market: bookMarketPda,
        liquidities: marketLiquidities,
        matchingQueue,
        orderRequestQueue,
        marketOperator: args.creator.publicKey,
        authorisedOperators: marketOperatorsPda,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ])
      .signers([args.creator])
      .rpc();
  }

  const escrowAtaTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      args.creator.publicKey,
      escrowYesAta,
      escrowAuthority,
      yesMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      args.creator.publicKey,
      escrowNoAta,
      escrowAuthority,
      noMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(args.conn, escrowAtaTx, [args.creator], {
    commitment: "confirmed",
  });

  return {
    soothMarketPda: sm.marketPda,
    marketId: sm.marketId,
    yesMint,
    noMint,
    bookMarketPda,
    escrowAuthority,
    escrowYesAta,
    escrowNoAta,
    marketLiquidities,
    matchingQueue,
    orderRequestQueue,
    outcomeYesPda,
    outcomeNoPda,
    priceLadderPda,
    marketTypePda,
  };
}

export async function createMarketViaAdapter(args: {
  conn: Connection;
  creator: Keypair;
  usdcMint: PublicKey;
  question?: string;
  marketId?: Buffer;
  initialB?: bigint;
  startTime?: bigint;
  deadline: bigint;
}): Promise<FreshMarketSetup> {
  const {
    conn,
    creator,
    usdcMint,
    question = `e2e market ${Date.now()}`,
    initialB = 1_000n * 10n ** 18n,
    startTime = BigInt(Math.floor(Date.now() / 1000)),
    deadline,
  } = args;
  const programs = makePrograms(conn, creator);
  const marketId = args.marketId ?? randomBytes(16);
  if (marketId.length !== 16) {
    throw new Error(`marketId must be 16 bytes, got ${marketId.length}`);
  }
  const questionHash = createHash("sha256").update(question).digest();

  const marketPda = deriveMarketPda(marketId);
  const ammStatePda = deriveAmmStatePda(marketId);
  const vaultAuthority = deriveVaultAuthorityPda(marketId);
  const lockAuthority = deriveLockAuthorityPda(marketId);
  const yesMint = deriveYesMintPda(marketId);
  const noMint = deriveNoMintPda(marketId);
  const marketVault = getAssociatedTokenAddressSync(
    usdcMint,
    vaultAuthority,
    true,
  );
  const lockVault = getAssociatedTokenAddressSync(
    usdcMint,
    lockAuthority,
    true,
  );
  const protocolConfig = deriveProtocolConfigPda();
  const allowlist = PublicKey.findProgramAddressSync(
    [Buffer.from("adjudicator_allowlist")],
    marketProgramId,
  )[0];

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  const ix = await (programs.launchpad.methods as any)
    .createMarket({
      marketId: Array.from(marketId),
      questionHash: Array.from(questionHash),
      startTime: bn(startTime),
      deadline: bn(deadline),
      adjudicator: creator.publicKey,
      initialB: bn(initialB),
    })
    .accounts({
      config: protocolConfig,
      market: marketPda,
      adjudicatorAllowlist: allowlist,
      vaultAuthority,
      yesMint,
      noMint,
      lockAuthority,
      usdcMint,
      vault: marketVault,
      lockVault,
      ammState: ammStatePda,
      creator: creator.publicKey,
      soothMarketProgram: marketProgramId,
      soothAmmProgram: ammProgramId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  tx.add(ix);
  await sendAndConfirmTransaction(conn, tx, [creator], {
    commitment: "confirmed",
  });

  const lpMint = deriveLpMintPda(marketId);
  const creatorLpAta = getAssociatedTokenAddressSync(lpMint, creator.publicKey);
  return { marketId, marketPda, ammStatePda, lpMint, creatorLpAta };
}

export async function registerAdjudicatorViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  marketPda: PublicKey;
  authority: PublicKey;
}): Promise<string> {
  const { conn, signer, marketPda, authority } = args;
  const programs = makePrograms(conn, signer);
  const adjudicatorPda = deriveAdjudicatorPda(marketPda);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const ix = await (programs.adjudicator.methods as any)
    .registerAdjudicator(authority, { manual: {} })
    .accounts({
      adjudicator: adjudicatorPda,
      market: marketPda,
      signer: signer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [signer], {
    commitment: "confirmed",
  });
}

export async function seedLpViaAdapter(args: {
  conn: Connection;
  creator: Keypair;
  marketPda: PublicKey;
  marketId: Buffer;
  initialB: bigint;
}): Promise<string> {
  const { conn, creator, marketPda, marketId, initialB } = args;
  const programs = makePrograms(conn, creator);
  const lpMint = deriveLpMintPda(marketId);
  const lpMintAuthority = deriveLpMintAuthorityPda(marketId);
  const lpPosition = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), marketId, creator.publicKey.toBuffer()],
    launchpadProgramId,
  )[0];
  const protocolConfig = deriveProtocolConfigPda();
  const creatorLpAta = getAssociatedTokenAddressSync(lpMint, creator.publicKey);
  const ammStatePda = deriveAmmStatePda(marketId);
  const lpMintInfo = await conn.getAccountInfo(lpMint);
  if (lpMintInfo) return "already-seeded";

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  const ix = await (programs.launchpad.methods as any)
    .seedLp({
      lpAmount: bn(initialB / 1_000_000_000_000n),
      seedDepositWad: bn(initialB),
    })
    .accounts({
      config: protocolConfig,
      market: marketPda,
      ammState: ammStatePda,
      lpMint,
      lpMintAuthority,
      creatorLpAta,
      lpPosition,
      creator: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [creator], {
    commitment: "confirmed",
  });
}

export async function dismissMarketViaAdapter(args: {
  conn: Connection;
  creator: Keypair;
  marketPda: PublicKey;
  marketId: Buffer;
}): Promise<string> {
  const { conn, creator, marketPda, marketId } = args;
  const programs = makePrograms(conn, creator);
  const ammState = deriveAmmStatePda(marketId);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const ix = await (programs.amm.methods as any)
    .dismissMarket()
    .accounts({
      market: marketPda,
      ammState,
      creator: creator.publicKey,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [creator], {
    commitment: "confirmed",
  });
}

// Drives sooth_adjudicator::request_lock with a creator-keypair signer (the
// registered Adjudicator.authority). CPIs into sooth_market::lock_for_resolution
// → Market.lifecycle: Open → Locked. Required before attest_outcome can fire
// market::settle, since settle gates on lifecycle == Locked.
export async function requestLockViaAdapter(args: {
  conn: Connection;
  authority: Keypair; // must match Adjudicator.authority
  marketPda: PublicKey;
}): Promise<string> {
  const { conn, authority, marketPda } = args;
  const programs = makePrograms(conn, authority);
  const adjudicatorPda = deriveAdjudicatorPda(marketPda);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const ix = await (programs.adjudicator.methods as any)
    .requestLock()
    .accounts({
      adjudicator: adjudicatorPda,
      market: marketPda,
      authority: authority.publicKey,
      soothMarketProgram: marketProgramId,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [authority], {
    commitment: "confirmed",
  });
}

export async function attestOutcomeViaAdapter(args: {
  conn: Connection;
  authority: Keypair; // must match Adjudicator.authority
  marketPda: PublicKey;
  winningOutcome: 0 | 1 | 2; // 0=NO, 1=YES, 2=INVALID
}): Promise<string> {
  const { conn, authority, marketPda, winningOutcome } = args;
  const programs = makePrograms(conn, authority);
  const adjudicatorPda = deriveAdjudicatorPda(marketPda);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const ix = await (programs.adjudicator.methods as any)
    .attestOutcome(winningOutcome)
    .accounts({
      adjudicator: adjudicatorPda,
      market: marketPda,
      authority: authority.publicKey,
      soothMarketProgram: marketProgramId,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [authority], {
    commitment: "confirmed",
  });
}

// ─── Adapter-direct redeem (operator + user paths) ──────────────────────

export async function redeemViaAdapter(args: {
  conn: Connection;
  signer: Keypair; // user holding YES/NO
  marketPda: PublicKey;
  marketId: Buffer;
  usdcMint: PublicKey;
}): Promise<string> {
  const { conn, signer, marketPda, marketId, usdcMint } = args;
  const programs = makePrograms(conn, signer);
  const vaultAuthority = deriveVaultAuthorityPda(marketId);
  const yesMint = deriveYesMintPda(marketId);
  const noMint = deriveNoMintPda(marketId);
  const vault = getAssociatedTokenAddressSync(usdcMint, vaultAuthority, true);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, signer.publicKey);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, signer.publicKey);
  const userNoAta = getAssociatedTokenAddressSync(noMint, signer.publicKey);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  // Idempotent: ensure outcome ATAs exist before redeem reads them.
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      userYesAta,
      signer.publicKey,
      yesMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      userNoAta,
      signer.publicKey,
      noMint,
    ),
  );
  const ix = await (programs.market.methods as any)
    .redeem()
    .accounts({
      market: marketPda,
      vaultAuthority,
      yesMint,
      noMint,
      vault,
      userUsdcAta,
      userYesAta,
      userNoAta,
      user: signer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [signer], {
    commitment: "confirmed",
  });
}
