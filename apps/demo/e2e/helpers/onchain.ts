// On-chain reads + pre-condition setup helpers for the e2e suite.
//
// Uses @solana/web3.js + @solana/spl-token (already deps of the demo).
//
// Conventions:
//   - Amount-like values are bigint (u64 / u128 base units; never Number).
//   - Read functions take a Connection so callers can vary commitment.
//   - waitForOnChainChange polls; callers pass condition + timeout.
//   - Default commitment is "confirmed" — "processed" produces flaky reads,
//     "finalized" wastes ~13s per assertion.

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  type Commitment,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const COMMITMENT: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) ?? "confirmed";

export function makeConnection(
  commitment: Commitment = COMMITMENT,
): Connection {
  return new Connection(RPC_URL, commitment);
}

// ─── Account reads ───────────────────────────────────────────────────────

export async function getAccountData(
  conn: Connection,
  pubkey: PublicKey,
): Promise<Buffer | null> {
  const info = await conn.getAccountInfo(pubkey);
  return info?.data ?? null;
}

export function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

export function readI64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64LE(offset);
}

/** Read an i128 little-endian field (Anchor `i128`). */
export function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export function readPubkey(buf: Buffer, offset: number): PublicKey {
  return new PublicKey(buf.subarray(offset, offset + 32));
}

// ─── SPL Token reads ─────────────────────────────────────────────────────

export async function getTokenBalance(
  conn: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    const acc = await getAccount(conn, ata);
    return acc.amount;
  } catch {
    return 0n;
  }
}

// ─── Polling ─────────────────────────────────────────────────────────────

export async function waitForOnChainChange<T>(
  read: () => Promise<T>,
  condition: (v: T) => boolean,
  timeoutMs = 30_000,
  pollMs = 1000,
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await read();
    if (condition(last)) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `waitForOnChainChange timed out after ${timeoutMs}ms; last value: ${JSON.stringify(
      last,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    )}`,
  );
}

// ─── Pre-condition setup ─────────────────────────────────────────────────

export async function airdrop(
  conn: Connection,
  pubkey: PublicKey,
  sol: number,
): Promise<void> {
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

/** Mint SPL tokens to a recipient (requires the mint authority signer). */
export async function mintTokens(
  conn: Connection,
  mintAuthority: Keypair,
  mint: PublicKey,
  recipient: PublicKey,
  amount: bigint,
): Promise<string> {
  const ata = getAssociatedTokenAddressSync(mint, recipient);
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      mintAuthority.publicKey,
      ata,
      recipient,
      mint,
    ),
    createMintToInstruction(mint, ata, mintAuthority.publicKey, amount),
  );
  return sendAndConfirmTransaction(conn, tx, [mintAuthority]);
}

// ─── Tx receipt helpers ──────────────────────────────────────────────────

export type TxStatus =
  | { kind: "success" }
  | { kind: "failed"; error: string }
  | { kind: "missing" };

export async function getTxStatus(
  conn: Connection,
  signature: string,
): Promise<TxStatus> {
  const status = await conn.getSignatureStatus(signature, {
    searchTransactionHistory: true,
  });
  if (!status?.value) return { kind: "missing" };
  if (status.value.err) {
    return {
      kind: "failed",
      error: JSON.stringify(status.value.err, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    };
  }
  return { kind: "success" };
}

/**
 * Decode an Anchor `Custom: <code>` error from a tx err object against a
 * loaded IDL `errors` array. Returns `{name, msg}` if matched, else null.
 */
export function decodeAnchorError(
  err: unknown,
  errors: Array<{ code: number; name: string; msg: string }>,
): { code: number; name: string; msg: string } | null {
  // err shape (Solana JSON-RPC): { InstructionError: [ixIdx, { Custom: code } | string] }
  const e = err as
    | { InstructionError?: [number, { Custom?: number } | string] }
    | undefined;
  const ix = e?.InstructionError;
  if (!ix || ix.length < 2) return null;
  const inner = ix[1];
  if (typeof inner === "string") return null;
  const code = inner?.Custom;
  if (typeof code !== "number") return null;
  const match = errors.find((x) => x.code === code);
  return match
    ? { code, name: match.name, msg: match.msg }
    : { code, name: "Unknown", msg: `code=${code}` };
}
