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
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import {
  SOOTH_CORE_PROGRAM_ID,
  SOOTH_LOG_PROGRAM_ID,
  SolanaChainAdapter,
  type SignerRef,
} from "@sooth/sdk-solana";

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

// One program, not five. The 5→1 merge folded sooth_amm, sooth_market,
// sooth_book, sooth_launchpad and sooth_adjudicator into sooth_core; sooth_log
// stays separate because a program cannot CPI into itself.
export const coreIdl = loadIdl("sooth_core");

function programIdOrFallback(idlAddress: unknown, fallback: PublicKey): PublicKey {
  return typeof idlAddress === "string" && idlAddress.length > 0
    ? new PublicKey(idlAddress)
    : fallback;
}

export const coreProgramId = programIdOrFallback(
  coreIdl.address,
  SOOTH_CORE_PROGRAM_ID,
);

/** Durable-event sink invoked by `buy`. No IDL is shipped for it — the e2e
 *  path only needs the address to put in the buy account list. */
export const logProgramId = SOOTH_LOG_PROGRAM_ID;

const coreProgramIdl = { ...coreIdl, address: coreProgramId.toBase58() };

/**
 * Compute-budget preamble every sooth_core transaction needs.
 *
 * The heap frame is MANDATORY, not an optimisation: sooth_core installs a
 * 256 KB `#[global_allocator]` and the runtime only maps that region when the
 * transaction asks for it. Because the allocator hands out addresses from the
 * top of the region, omitting the frame makes the FIRST allocation land
 * outside mapped memory and the program aborts with "Access violation in heap
 * section" — on every instruction, not just multi-fill buys. @sooth/sdk-solana
 * does this on all its paths; these adapter-direct helpers must too.
 */
export const SOOTH_CORE_HEAP_BYTES = 256 * 1024;

export function heapFrameIx(): TransactionInstruction {
  return ComputeBudgetProgram.requestHeapFrame({
    bytes: SOOTH_CORE_HEAP_BYTES,
  });
}

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

/** All subsystems live in one program now, so these are the same handle. The
 *  five names are kept so call sites still read as which subsystem they mean
 *  — `programs.amm.methods.tradePositions` says more than `programs.core`
 *  does — but they are deliberately one object, not five. */
export interface ProgramHandles {
  core: anchor.Program;
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
  const core = new anchor.Program(coreProgramIdl, provider);
  return {
    core,
    amm: core,
    market: core,
    launchpad: core,
    adjudicator: core,
    book: core,
  };
}

// ─── PDA helpers (mirror packages/sdk-solana/src/pdas.ts) ───────────────

export function deriveMarketPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), marketId],
    coreProgramId,
  )[0];
}
export function deriveAmmStatePda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("amm"), marketId],
    coreProgramId,
  )[0];
}
export function deriveVaultAuthorityPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketId],
    coreProgramId,
  )[0];
}
export function deriveLockAuthorityPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lock"), marketId],
    coreProgramId,
  )[0];
}
export function derivePositionPda(
  marketId: Buffer,
  user: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pos"), marketId, user.toBuffer()],
    coreProgramId,
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
    coreProgramId,
  )[0];
}
export function deriveYesMintPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), marketId, Buffer.from("y")],
    coreProgramId,
  )[0];
}
export function deriveNoMintPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), marketId, Buffer.from("n")],
    coreProgramId,
  )[0];
}
export function deriveProtocolConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    coreProgramId,
  )[0];
}
export function deriveFeePoolAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_pool_authority")],
    coreProgramId,
  )[0];
}
export function deriveLpMintPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), marketId],
    coreProgramId,
  )[0];
}
export function deriveLpMintAuthorityPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint_authority"), marketId],
    coreProgramId,
  )[0];
}
export function deriveLpYieldAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_yield_authority")],
    coreProgramId,
  )[0];
}
export function deriveAdjudicatorPda(marketPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("adjudicator"), marketPda.toBuffer()],
    coreProgramId,
  )[0];
}
export function deriveMarketBookPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_book"), marketId],
    coreProgramId,
  )[0];
}
export function deriveBookSidePda(
  marketId: Buffer,
  side: 0 | 1,
  tick: number,
): PublicKey {
  const tickBuf = Buffer.alloc(2);
  tickBuf.writeUInt16LE(tick, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("book_side"), marketId, Buffer.from([side]), tickBuf],
    coreProgramId,
  )[0];
}
export function deriveOrderbookPositionPda(
  marketId: Buffer,
  user: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook_position"), marketId, user.toBuffer()],
    coreProgramId,
  )[0];
}
export function deriveMarketFeePoolPda(marketId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_fee_pool"), marketId],
    coreProgramId,
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
  await initMarketFeePoolViaAdapter({
    conn,
    signer,
    usdcMint,
    marketPda,
    marketId,
  });

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
    heapFrameIx(),
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
      marketFeePool: deriveMarketFeePoolPda(marketId),
      lpMint,
      lpMintAuthority,
      userLpAta,
      user: signer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
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
  tx.add(heapFrameIx());
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
      protocolConfig: deriveProtocolConfigPda(),
      marketFeePool: deriveMarketFeePoolPda(marketId),
      user: signer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
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
  tx.add(heapFrameIx());
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
  tx.add(heapFrameIx());
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
  tx.add(heapFrameIx());
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

export async function fundOrderbookTrader(args: {
  conn: Connection;
  trader: Keypair;
  mintAuthority: Keypair;
  usdcMint: PublicKey;
  usdcBaseUnits?: bigint;
  sol?: number;
}): Promise<void> {
  const sol = args.sol ?? 2;
  if ((await args.conn.getBalance(args.trader.publicKey)) < LAMPORTS_PER_SOL) {
    const sig = await args.conn.requestAirdrop(
      args.trader.publicKey,
      sol * LAMPORTS_PER_SOL,
    );
    await args.conn.confirmTransaction(sig, "confirmed");
  }

  const ata = getAssociatedTokenAddressSync(
    args.usdcMint,
    args.trader.publicKey,
  );
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      args.mintAuthority.publicKey,
      ata,
      args.trader.publicKey,
      args.usdcMint,
    ),
    createMintToInstruction(
      args.usdcMint,
      ata,
      args.mintAuthority.publicKey,
      args.usdcBaseUnits ?? 100_000_000n,
    ),
  );
  await sendAndConfirmTransaction(args.conn, tx, [args.mintAuthority], {
    commitment: "confirmed",
  });
}

export function minRestingOrderForTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < 1 || tick > 999) {
    throw new Error(`tick must be 1..999, got ${tick}`);
  }
  const baseUnitWad = 1_000_000_000_000n;
  return (baseUnitWad * 1000n + BigInt(tick) - 1n) / BigInt(tick);
}

export interface OrderbookPositionState {
  market: PublicKey;
  user: PublicKey;
  yesShares: bigint;
  noShares: bigint;
}

export async function fetchOrderbookPosition(args: {
  conn: Connection;
  marketId: Buffer;
  user: PublicKey;
}): Promise<OrderbookPositionState> {
  const pda = deriveOrderbookPositionPda(args.marketId, args.user);
  const info = await args.conn.getAccountInfo(pda);
  if (!info) {
    return {
      market: PublicKey.default,
      user: args.user,
      yesShares: 0n,
      noShares: 0n,
    };
  }
  const d = info.data;
  return {
    market: new PublicKey(d.subarray(8, 40)),
    user: new PublicKey(d.subarray(40, 72)),
    yesShares: d.readBigUInt64LE(72) | (d.readBigUInt64LE(80) << 64n),
    noShares: d.readBigUInt64LE(88) | (d.readBigUInt64LE(96) << 64n),
  };
}

export async function getTokenAccountAmount(
  conn: Connection,
  tokenAccount: PublicKey,
): Promise<bigint> {
  try {
    return (await getAccount(conn, tokenAccount)).amount;
  } catch {
    return 0n;
  }
}

export async function mintOrderbookCompleteSetViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  usdcMint: PublicKey;
  marketPda: PublicKey;
  amount: bigint;
}): Promise<string> {
  const adapter = makeSolanaAdapter({ conn: args.conn, usdcMint: args.usdcMint });
  const req = await adapter.buildOrderbookMint(
    `sol:${args.marketPda.toBase58()}`,
    {
      amount: args.amount,
      user: `sol:${args.signer.publicKey.toBase58()}`,
    },
  );
  const receipt = await adapter.submit(req, makeSignerRef(args.signer));
  return receipt.txId;
}

export function buildOrderbookFillBundle(args: {
  marketId: Buffer;
  usdcMint: PublicKey;
  maker: PublicKey;
  makerSide: 0 | 1;
  makerTick: number;
}): AccountMeta[] {
  return [
    {
      pubkey: deriveBookSidePda(args.marketId, args.makerSide, args.makerTick),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: deriveOrderbookPositionPda(args.marketId, args.maker),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: getAssociatedTokenAddressSync(args.usdcMint, args.maker),
      isSigner: false,
      isWritable: true,
    },
    // Exactly FILL_BUNDLE_LEN (3) accounts: [book_side, maker_position,
    // maker_usdc_ata]. This used to append two reserved SystemProgram
    // placeholders, left over from when the CPI-era layout was 5 wide. The
    // program requires remaining_accounts.len() % 3 == 0, so the extra pair
    // made every crossing buy fail with WrongBundleArity BEFORE any real
    // validation ran — which masked the error the caller was testing for.
  ];
}

export async function sendOrderbookBuyWithRemainingAccounts(args: {
  conn: Connection;
  signer: Keypair;
  usdcMint: PublicKey;
  marketPda: PublicKey;
  side: 0 | 1;
  tick: number;
  amount: bigint;
  escrow?: boolean;
  matchLimit?: number;
  remainingAccounts: AccountMeta[];
}): Promise<string> {
  const adapter = makeSolanaAdapter({ conn: args.conn, usdcMint: args.usdcMint });
  const ixs = await adapter.buildOrderbookBuyTx(
    `sol:${args.marketPda.toBase58()}`,
    {
      side: args.side,
      tick: args.tick,
      amount: args.amount,
      escrow: args.escrow ?? false,
      matchLimitPerTx: args.matchLimit ?? 3,
      user: `sol:${args.signer.publicKey.toBase58()}`,
    },
    args.remainingAccounts,
  );
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    heapFrameIx(),
    ...ixs,
  );
  return sendAndConfirmTransaction(args.conn, tx, [args.signer], {
    commitment: "confirmed",
  });
}

export async function fetchTransactionLogs(
  conn: Connection,
  txId: string,
): Promise<string[]> {
  const signature = txId.replace(/^sol:/, "");
  const tx = await conn.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx?.meta?.logMessages ?? [];
}

export async function distributeMarketFeesViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  usdcMint: PublicKey;
  marketPda: PublicKey;
  marketId: Buffer;
}): Promise<string> {
  const creatorAta = getAssociatedTokenAddressSync(
    args.usdcMint,
    args.signer.publicKey,
  );
  const lpYieldAuthority = deriveLpYieldAuthorityPda();
  const lpYieldVault = getAssociatedTokenAddressSync(
    args.usdcMint,
    lpYieldAuthority,
    true,
  );
  const createAtaTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      args.signer.publicKey,
      creatorAta,
      args.signer.publicKey,
      args.usdcMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      args.signer.publicKey,
      lpYieldVault,
      lpYieldAuthority,
      args.usdcMint,
    ),
  );
  await sendAndConfirmTransaction(args.conn, createAtaTx, [args.signer], {
    commitment: "confirmed",
  });
  await patchProtocolTreasuryViaSurfpool({
    conn: args.conn,
    treasury: creatorAta,
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    heapFrameIx(),
  );
  const ix = new TransactionInstruction({
    programId: coreProgramId,
    keys: [
      { pubkey: deriveProtocolConfigPda(), isSigner: false, isWritable: false },
      { pubkey: args.marketPda, isSigner: false, isWritable: false },
      {
        pubkey: deriveFeePoolAuthorityPda(),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: args.usdcMint, isSigner: false, isWritable: false },
      {
        pubkey: deriveMarketFeePoolPda(args.marketId),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: creatorAta, isSigner: false, isWritable: true },
      { pubkey: lpYieldVault, isSigner: false, isWritable: true },
      { pubkey: creatorAta, isSigner: false, isWritable: true },
      { pubkey: creatorAta, isSigner: false, isWritable: true },
      { pubkey: args.signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: createHash("sha256")
      .update("global:distribute_fees")
      .digest()
      .subarray(0, 8),
  });
  tx.add(ix);
  return sendAndConfirmTransaction(args.conn, tx, [args.signer], {
    commitment: "confirmed",
  });
}

async function patchProtocolTreasuryViaSurfpool(args: {
  conn: Connection;
  treasury: PublicKey;
}): Promise<void> {
  const protocolConfig = deriveProtocolConfigPda();
  const info = await args.conn.getAccountInfo(protocolConfig);
  if (!info) throw new Error(`ProtocolConfig missing at ${protocolConfig}`);
  const data = Buffer.from(info.data);
  const treasuryOffset = 8 + 32;
  const current = new PublicKey(
    data.subarray(treasuryOffset, treasuryOffset + 32),
  );
  if (current.equals(args.treasury)) return;
  args.treasury.toBuffer().copy(data, treasuryOffset);
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [
        protocolConfig.toBase58(),
        {
          lamports: info.lamports,
          owner: info.owner.toBase58(),
          data: data.toString("hex"),
          executable: info.executable,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`surfnet_setAccount: HTTP ${res.status}`);
  const json = (await res.json()) as { error?: { message?: string } };
  if (json.error) {
    throw new Error(`surfnet_setAccount failed: ${json.error.message}`);
  }
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
    usdcMint: args.usdcMint,
  });
  return setup;
}

export interface FreshOrderbookMarketSetup {
  soothMarketPda: PublicKey;
  marketId: Buffer;
  yesMint: PublicKey;
  noMint: PublicKey;
  bookMarketPda: PublicKey;
  marketFeePool: PublicKey;
}

export async function createSeededOrderbookMarketViaAdapter(args: {
  conn: Connection;
  creator: Keypair;
  usdcMint: PublicKey;
  existingSoothMarket?: FreshMarketSetup;
  question?: string;
  initialB?: bigint;
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
      initialB: args.initialB ?? 1n * 10n ** 18n,
      deadline: args.deadline ?? defaultDeadline,
    }));

  const yesMint = deriveYesMintPda(sm.marketId);
  const noMint = deriveNoMintPda(sm.marketId);
  const bookMarketPda = deriveMarketBookPda(sm.marketId);
  const marketFeePool = deriveMarketFeePoolPda(sm.marketId);

  return {
    soothMarketPda: sm.marketPda,
    marketId: sm.marketId,
    yesMint,
    noMint,
    bookMarketPda,
    marketFeePool,
  };
}

export function makeSignerRef(signer: Keypair): SignerRef {
  return {
    publicKey: signer.publicKey.toBase58(),
    signTransaction: async (txBytes: Uint8Array) => {
      const tx = Transaction.from(txBytes);
      tx.partialSign(signer);
      return tx.serialize({
        verifySignatures: false,
        requireAllSignatures: false,
      });
    },
  };
}

export function makeSolanaAdapter(args: {
  conn: Connection;
  usdcMint: PublicKey;
}): SolanaChainAdapter {
  return new SolanaChainAdapter({
    node: {
      id: "demo-e2e",
      chainKind: "solana",
      chainId: "localnet",
      rpcUrl: process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899",
    },
    programIds: {
      soothCore: coreProgramId,
      soothLog: logProgramId,
    },
    usdcMint: args.usdcMint,
    connection: args.conn,
  });
}

export async function forceAmmGraduatedViaSurfpool(args: {
  conn: Connection;
  marketId: Buffer;
}): Promise<void> {
  const ammStatePda = deriveAmmStatePda(args.marketId);
  const info = await args.conn.getAccountInfo(ammStatePda);
  if (!info) throw new Error(`AmmState missing at ${ammStatePda.toBase58()}`);
  const data = Buffer.from(info.data);
  if (data[144] === 1) return;
  data.writeUInt8(1, 144);
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [
        ammStatePda.toBase58(),
        {
          lamports: info.lamports,
          owner: info.owner.toBase58(),
          data: data.toString("hex"),
          executable: info.executable,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`surfnet_setAccount: HTTP ${res.status}`);
  const json = (await res.json()) as { error?: { message?: string } };
  if (json.error) {
    if (json.error.message?.includes("Method not found")) {
      return;
    }
    throw new Error(`surfnet_setAccount failed: ${json.error.message}`);
  }
}

export async function initMarketFeePoolViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  usdcMint: PublicKey;
  marketPda: PublicKey;
  marketId: Buffer;
}): Promise<void> {
  const marketFeePool = deriveMarketFeePoolPda(args.marketId);
  if (await args.conn.getAccountInfo(marketFeePool)) return;
  const ix = new TransactionInstruction({
    programId: coreProgramId,
    keys: [
      { pubkey: args.marketPda, isSigner: false, isWritable: false },
      {
        pubkey: deriveFeePoolAuthorityPda(),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: args.usdcMint, isSigner: false, isWritable: false },
      { pubkey: marketFeePool, isSigner: false, isWritable: true },
      { pubkey: args.signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from("3313fb78ab5b8a73", "hex"),
  });
  // init_market_fee_pool is a sooth_core instruction, so it needs the heap
  // frame like every other one — this transaction is hand-built rather than
  // going through a compute-budget preamble, which is how it was missed.
  await sendAndConfirmTransaction(
    args.conn,
    new Transaction().add(heapFrameIx(), ix),
    [args.signer],
  );
}

export async function placeOrderbookBuyViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  usdcMint: PublicKey;
  marketPda: PublicKey;
  side: 0 | 1;
  tick: number;
  amount: bigint;
  escrow?: boolean;
  matchLimit?: number;
}): Promise<string> {
  const adapter = makeSolanaAdapter({ conn: args.conn, usdcMint: args.usdcMint });
  const req = await adapter.buildOrderbookBuy(`sol:${args.marketPda.toBase58()}`, {
    side: args.side,
    tick: args.tick,
    amount: args.amount,
    escrow: args.escrow ?? false,
    matchLimit: args.matchLimit ?? 3,
    user: `sol:${args.signer.publicKey.toBase58()}`,
  } as never);
  const receipt = await adapter.submit(req, makeSignerRef(args.signer));
  return receipt.txId;
}

export async function cancelOrderbookViaAdapter(args: {
  conn: Connection;
  signer: Keypair;
  usdcMint: PublicKey;
  marketPda: PublicKey;
  side: 0 | 1;
  tick: number;
  byId?: bigint;
}): Promise<string> {
  const adapter = makeSolanaAdapter({ conn: args.conn, usdcMint: args.usdcMint });
  const req = await adapter.buildOrderbookCancel(
    `sol:${args.marketPda.toBase58()}`,
    args.side,
    args.tick,
    {
      user: `sol:${args.signer.publicKey.toBase58()}`,
      byId: args.byId,
    },
  );
  const receipt = await adapter.submit(req, makeSignerRef(args.signer));
  return receipt.txId;
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
    coreProgramId,
  )[0];

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  tx.add(heapFrameIx());
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
      vaultAuthority,
      yesMint,
      noMint,
      lockAuthority,
      usdcMint,
      vault: marketVault,
      lockVault,
      ammState: ammStatePda,
      creator: creator.publicKey,
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
  tx.add(heapFrameIx());
  const ix = await (programs.adjudicator.methods as any)
    .registerAdjudicator(authority)
    .accounts({
      adjudicatorEntry: adjudicatorPda,
      market: marketPda,
      protocolConfig: deriveProtocolConfigPda(),
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
  /** Required since bug B0: seed_lp now transfers the LMSR subsidy. */
  usdcMint: PublicKey;
}): Promise<string> {
  const { conn, creator, marketPda, marketId, initialB, usdcMint } = args;
  const programs = makePrograms(conn, creator);
  const lpMint = deriveLpMintPda(marketId);
  const lpMintAuthority = deriveLpMintAuthorityPda(marketId);
  const lpPosition = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), marketId, creator.publicKey.toBuffer()],
    coreProgramId,
  )[0];
  const protocolConfig = deriveProtocolConfigPda();
  const creatorLpAta = getAssociatedTokenAddressSync(lpMint, creator.publicKey);
  const ammStatePda = deriveAmmStatePda(marketId);
  const lpMintInfo = await conn.getAccountInfo(lpMint);
  if (lpMintInfo) return "already-seeded";

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(heapFrameIx());
  const ix = await (programs.launchpad.methods as any)
    .seedLp({
      lpAmount: bn(initialB / 1_000_000_000_000n),
      // Exactly the LMSR worst-case subsidy seed_lp now requires: b * ln(2).
      seedDepositWad: bn(
        (initialB * 693_147_180_559_945_309n) / 1_000_000_000_000_000_000n,
      ),
    })
    .accounts({
      config: protocolConfig,
      market: marketPda,
      ammState: ammStatePda,
      lpMint,
      lpMintAuthority,
      creatorLpAta,
      lpPosition,
      // seed_lp now transfers the LMSR subsidy into the market vault (bug B0);
      // before the fix it recorded seed_deposit_wad and moved nothing.
      marketVault: getAssociatedTokenAddressSync(
        usdcMint,
        deriveVaultAuthorityPda(marketId),
        true,
      ),
      creatorUsdcAta: getAssociatedTokenAddressSync(
        usdcMint,
        creator.publicKey,
      ),
      usdcMint,
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
  tx.add(heapFrameIx());
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
  tx.add(heapFrameIx());
  const ix = await (programs.adjudicator.methods as any)
    .requestLock()
    .accounts({
      adjudicatorEntry: adjudicatorPda,
      market: marketPda,
      authority: authority.publicKey,
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
  tx.add(heapFrameIx());
  const ix = await (programs.adjudicator.methods as any)
    .attestOutcome(winningOutcome)
    .accounts({
      adjudicatorEntry: adjudicatorPda,
      market: marketPda,
      authority: authority.publicKey,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [authority], {
    commitment: "confirmed",
  });
}

/**
 * Finalize an attested market. Permissionless, so `payer` need not be the
 * adjudicator authority.
 *
 * Resolution is two steps now — `attestOutcome` records the outcome and opens
 * the guardian-veto window, `settle` closes it out — so anything that used to
 * attest-and-redeem must call this in between. The localnet seed sets
 * `veto_period_secs = 2`, hence `waitForVetoWindow` below; devnet uses 300s
 * and mainnet 24h.
 */
export async function settleViaAdapter(args: {
  conn: Connection;
  payer: Keypair;
  marketPda: PublicKey;
}): Promise<string> {
  const { conn, payer, marketPda } = args;
  const programs = makePrograms(conn, payer);
  const adjudicatorPda = deriveAdjudicatorPda(marketPda);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(heapFrameIx());
  const ix = await (programs.adjudicator.methods as any)
    .settle()
    .accounts({
      market: marketPda,
      adjudicatorEntry: adjudicatorPda,
      protocolConfig: deriveProtocolConfigPda(),
      cranker: payer.publicKey,
    })
    .instruction();
  tx.add(ix);
  return sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
  });
}

/**
 * Sleep out the configured veto window. Reads `veto_period_secs` from
 * ProtocolConfig rather than hardcoding it, so a change to the seed script
 * does not silently turn this into a flaky race.
 */
export async function waitForVetoWindow(
  conn: Connection,
  payer: Keypair,
): Promise<void> {
  const programs = makePrograms(conn, payer);
  const cfg = await (programs.adjudicator.account as any).protocolConfig.fetch(
    deriveProtocolConfigPda(),
  );
  const secs = Number(cfg.vetoPeriodSecs.toString());
  // +1s of slack: the on-chain check is `now >= attested_at + veto`, and the
  // validator clock advances in discrete slots.
  await new Promise((r) => setTimeout(r, (secs + 1) * 1000));
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
  tx.add(heapFrameIx());
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
