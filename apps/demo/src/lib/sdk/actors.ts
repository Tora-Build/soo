// Actor wallets — burner keypairs the Geek terminal signs with directly.
//
// The problem they solve is popups: a wallet extension confirms every
// transaction, so a 20-step simulation is 20 interruptions and the demo of
// "how fast can this market move" spends its time clicking. An actor signs
// in-page, so the ONLY confirmation in the whole flow is the one SOL
// transfer that funds the fleet — which is also the one transaction that
// spends anything the user actually owns.
//
// Custody, stated plainly: actor secret keys live in localStorage, in the
// clear. That is the design, not an oversight — these are throwaway DEVNET
// wallets holding faucet tokens and a few cents of test SOL, generated to be
// burned, and persistence is what stops a page reload from stranding the SOL
// already sent to them. Anything a browser extension can read can read them.
// `actors export` prints a key precisely so a wallet the user decides to
// keep can be moved into Phantom and out of this store.

import { Keypair, PublicKey } from "@solana/web3.js";

const STORE_KEY = "__soothGeekActors";

/** In-memory fallback so a storage-less environment (tests, SSR) still works. */
let memoryStore: number[][] | null = null;

function readStore(): number[][] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (
      Array.isArray(parsed) &&
      parsed.every((k) => Array.isArray(k) && k.length === 64)
    ) {
      return parsed as number[][];
    }
    return [];
  } catch {
    return memoryStore ?? [];
  }
}

function writeStore(keys: number[][]): void {
  memoryStore = keys;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(keys));
  } catch {
    // Memory fallback already holds them.
  }
}

/** The fleet, as live keypairs. Order is stable: index n is always the same actor. */
export function loadActors(): Keypair[] {
  return readStore().map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
}

/** Generates `n` new actors and appends them to the fleet. */
export function createActors(n: number): Keypair[] {
  const existing = readStore();
  const fresh = Array.from({ length: n }, () => Keypair.generate());
  writeStore([...existing, ...fresh.map((k) => Array.from(k.secretKey))]);
  return fresh;
}

/** Forgets the whole fleet. Unexported keys are unrecoverable afterwards. */
export function clearActors(): void {
  memoryStore = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing persisted, nothing to remove.
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58, inline.
 *
 * Phantom's "Import Private Key" takes the 64-byte secret in base58; web3.js
 * uses bs58 internally but does not re-export it, and adding a dependency to
 * encode twenty bytes once would be the heavier ask.
 */
export function toBase58(bytes: Uint8Array): string {
  let x = 0n;
  for (const b of bytes) x = x * 256n + BigInt(b);
  let out = "";
  while (x > 0n) {
    out = B58[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export { PublicKey };
