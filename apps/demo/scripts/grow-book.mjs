// Grow a market's book arena.
//
// The book is one account with a fixed block count, and every resting order AND
// every trader's seat takes a block. Once it is full, `book_place` fails with
// `MatchFailed` and there is no way out through the UI — nothing calls
// `book_grow`, so a market that fills up is simply stuck.
//
// Growth is one realloc step per call because Solana caps an account's growth
// at MAX_PERMITTED_DATA_INCREASE (10,240 bytes) per INSTRUCTION, which at 64
// bytes a block is 160 blocks. This loops until it reaches the target.
//
// Usage: node scripts/grow-book.mjs <marketPubkey> [capacity]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  BOOK_INIT_HEAP_BYTES,
  SolanaChainAdapter,
  buildBookGrow,
  soothCoreIdl,
} from "@sooth/sdk-solana";

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const log = (...a) => console.log("[grow-book]", ...a);

const marketArg = process.argv[2];
const target = Number(process.argv[3] ?? 256);
if (!marketArg) {
  console.error("usage: node scripts/grow-book.mjs <marketPubkey> [capacity]");
  process.exit(1);
}

const env = readFileSync(resolve(DEMO_ROOT, ".env.local"), "utf8");
const ev = (k) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();

const connection = new Connection(RPC, "confirmed");
const soothCore = new PublicKey(ev("VITE_SOOTH_CORE_ID"));
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(resolve(DEMO_ROOT, ".localnet/creator-keypair.json"), "utf8")),
  ),
);

const adapter = new SolanaChainAdapter({
  node: {
    id: "solana-localnet",
    chainKind: "solana",
    chainId: "solana:localnet",
    cluster: "localnet",
    rpcUrl: RPC,
    programs: { soothCore: soothCore.toBase58(), usdcMint: ev("VITE_USDC_MINT") },
  },
  connection,
});

const marketPda = new PublicKey(marketArg);
const coder = new anchor.BorshAccountsCoder(soothCoreIdl);
const info = await connection.getAccountInfo(marketPda);
if (!info) throw new Error(`no market at ${marketArg}`);
const decoded = coder.decode("Market", info.data);
const marketId = Buffer.from(decoded.marketId ?? decoded.market_id);
const refs = { marketPda, marketId, programs: { soothCore } };

const marketRef = `sol:${marketArg}`;
let book = await adapter.readBook(marketRef);
log(`before: ${book.orderCount} orders, ${book.blockCount}/${book.capacity} blocks`);

while (book.capacity < target) {
  const tx = new Transaction()
    // The 256 KB allocator's caller contract — same as book_init.
    .add(ComputeBudgetProgram.requestHeapFrame({ bytes: BOOK_INIT_HEAP_BYTES }))
    .add(buildBookGrow(refs, payer.publicKey, target));
  await sendAndConfirmTransaction(connection, tx, [payer]);
  const next = await adapter.readBook(marketRef);
  if (next.capacity === book.capacity) {
    log(`capacity stopped advancing at ${next.capacity}; giving up`);
    break;
  }
  book = next;
  log(`  grew to ${book.capacity}`);
}

log(`after:  ${book.orderCount} orders, ${book.blockCount}/${book.capacity} blocks`);
