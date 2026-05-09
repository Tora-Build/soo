// Reference implementation: on-chain reads + pre-condition setup helpers.
//
// Drop into e2e/helpers/onchain.ts. Uses @solana/web3.js + @solana/spl-token
// (already deps of any wallet-adapter dapp).
//
// Conventions:
//   - All amount-like values are bigint (u64 in lamports / SPL base units).
//   - All read functions take a Connection so caller can vary commitment.
//   - waitForOnChainChange polls; default 30s timeout, 1s interval.
//   - Use commitment "confirmed" for assertions; "finalized" only for
//     anti-rollback invariant checks (slow).

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

// ────────────────────────────────────────────────────────────────────────
// Connection
// ────────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const COMMITMENT: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) ?? "confirmed";

export function makeConnection(
  commitment: Commitment = COMMITMENT,
): Connection {
  return new Connection(RPC_URL, commitment);
}

// ────────────────────────────────────────────────────────────────────────
// Account reads
// ────────────────────────────────────────────────────────────────────────

export async function getAccountData(
  conn: Connection,
  pubkey: PublicKey,
): Promise<Buffer | null> {
  const info = await conn.getAccountInfo(pubkey);
  return info?.data ?? null;
}

/** Read a u64 little-endian field from an Anchor account at a known offset.
 *  Skip 8 bytes for the discriminator at the start of the account data. */
export function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

export function readI64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64LE(offset);
}

export function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export function readPubkey(buf: Buffer, offset: number): PublicKey {
  return new PublicKey(buf.subarray(offset, offset + 32));
}

// ────────────────────────────────────────────────────────────────────────
// SPL Token reads
// ────────────────────────────────────────────────────────────────────────

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

export async function getUsdcBalance(
  conn: Connection,
  owner: PublicKey,
  usdcMint: PublicKey,
): Promise<bigint> {
  return getTokenBalance(conn, usdcMint, owner);
}

// ────────────────────────────────────────────────────────────────────────
// Polling
// ────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────
// Pre-condition setup
// ────────────────────────────────────────────────────────────────────────

export async function airdrop(
  conn: Connection,
  pubkey: PublicKey,
  sol: number,
): Promise<void> {
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

/** Mint SPL tokens to a recipient. Requires the mint authority signer. */
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

// ────────────────────────────────────────────────────────────────────────
// Tx receipt verification
// ────────────────────────────────────────────────────────────────────────

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

/** Decode an Anchor `Custom` error code via an IDL's `errors` array. */
export function decodeAnchorError(
  errCode: number,
  idl: { errors?: Array<{ code: number; name: string; msg?: string }> },
): string {
  const e = idl.errors?.find((x) => x.code === errCode);
  return e ? `${e.name}${e.msg ? ` — ${e.msg}` : ""}` : `Unknown(${errCode})`;
}

/** Extract a Custom error code from a Solana TransactionError, if any. */
export function extractCustomErrorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2) return null;
  const inner = ie[1] as { Custom?: number };
  return typeof inner?.Custom === "number" ? inner.Custom : null;
}
