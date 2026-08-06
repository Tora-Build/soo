// Initialise the redesigned orderbook for a graduated market and rest a
// two-sided ladder on it.
//
// Without this a graduated market shows an empty book, which is
// indistinguishable from a broken one — and it leaves nothing for a taker to
// cross, so the fill path cannot be exercised through the UI at all.
//
// The orders are placed by the creator keypair, so a trader connecting their
// own wallet sees someone else's liquidity to trade against, and their own
// orders show up separately in the open-orders panel.
//
// Usage: node scripts/seed-book.mjs <marketPubkey>

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  SolanaChainAdapter,
  buildBookInitIxs,
  soothCoreIdl,
} from "@sooth/sdk-solana";

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALNET_DIR = resolve(DEMO_ROOT, ".localnet");
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const ONE_SHARE = 1_000_000n; // USDC base units — the book's unit

const log = (...a) => console.log("[seed-book]", ...a);

const marketArg = process.argv[2];
if (!marketArg) {
  console.error("usage: node scripts/seed-book.mjs <marketPubkey>");
  process.exit(1);
}
const marketRef = marketArg.startsWith("sol:") ? marketArg : `sol:${marketArg}`;

const connection = new Connection(RPC, "confirmed");
const trader = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(resolve(LOCALNET_DIR, "creator-keypair.json"), "utf8")),
  ),
);

const envFile = readFileSync(resolve(DEMO_ROOT, ".env.local"), "utf8");
const envVar = (key) => envFile.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();

const adapter = new SolanaChainAdapter({
  node: {
    id: "solana-localnet",
    chainKind: "solana",
    chainId: "solana:localnet",
    cluster: "localnet",
    rpcUrl: RPC,
    programs: {
      soothCore: envVar("VITE_SOOTH_CORE_ID"),
      usdcMint: envVar("VITE_USDC_MINT"),
    },
  },
  connection,
});

// `submit` speaks the browser-wallet shape: serialized bytes in, signed bytes
// out. A local keypair signs the same way.
const signer = {
  publicKey: trader.publicKey.toBase58(),
  async signTransaction(bytes) {
    const tx = Transaction.from(bytes);
    tx.partialSign(trader);
    return tx.serialize();
  },
};
const traderRef = `sol:${trader.publicKey.toBase58()}`;

// A book account must exist before anything can rest on it.
//
// The adapter has no `buildBookInit` — it exposes place/cancel/withdraw only,
// because in production a book is created once by whoever graduates the
// market, not by a trader. So this reaches for the low-level ix builder.
const soothCore = new PublicKey(envVar("VITE_SOOTH_CORE_ID"));
const marketPda = new PublicKey(marketArg);
const coder = new anchor.BorshAccountsCoder(soothCoreIdl);
const marketAcc = await connection.getAccountInfo(marketPda);
if (!marketAcc) throw new Error(`no market account at ${marketArg}`);
const marketId = Buffer.from(
  coder.decode("Market", marketAcc.data).marketId ??
    coder.decode("Market", marketAcc.data).market_id,
);

try {
  const existing = await adapter.readBook(marketRef);
  log(`book already initialised (${existing.orderCount} orders resting)`);
} catch {
  log("initialising book...");
  const INITIAL_CAPACITY = 64;
  // `buildBookInitIxs`, not `buildBookInit` — the bare instruction always
  // fails. See BOOK_INIT_HEAP_BYTES in the SDK for why.
  const ixs = buildBookInitIxs(
    { marketPda, marketId, programs: { soothCore } },
    trader.publicKey,
    INITIAL_CAPACITY,
  );
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  await sendAndConfirmTransaction(connection, tx, [trader]);
  log(`  book_init OK (capacity ${INITIAL_CAPACITY})`);
}

// `--empty` initialises the book and stops. The account must exist before
// anything can rest in it, but the maker ladder is a convenience, not a
// requirement — and a clean book is what you want when testing the matching
// engine from scratch.
if (process.argv.includes("--empty")) {
  const b = await adapter.readBook(marketRef);
  log(`book ready, ${b.orderCount} orders resting (empty by request)`);
  process.exit(0);
}

// A two-sided ladder around 0.50. Bids and asks are quoted on the SAME YES
// axis — a bid at 470 and an ask at 530 are both YES prices, not complements.
const LADDER = [
  { side: 0, tick: 470, shares: 25 },
  { side: 0, tick: 455, shares: 40 },
  { side: 0, tick: 440, shares: 60 },
  { side: 1, tick: 530, shares: 25 },
  { side: 1, tick: 545, shares: 40 },
  { side: 1, tick: 560, shares: 60 },
];

for (const level of LADDER) {
  const req = await adapter.buildBookPlace(marketRef, {
    user: traderRef,
    side: level.side,
    limitTick: level.tick,
    amount: BigInt(level.shares) * ONE_SHARE,
    // Nothing should cross — these are all maker orders on their own side.
    matchLimit: 8,
    postRemainder: true,
  });
  await adapter.submit(req, signer);
  log(
    `  ${level.side === 0 ? "BID" : "ASK"} ${level.shares} @ ${(level.tick / 1000).toFixed(3)}`,
  );
}

const book = await adapter.readBook(marketRef);
log("");
log(`orders resting: ${book.orderCount}`);
log(`  bids: ${book.bids.map((o) => `${Number(o.amount) / 1e6}@${o.priceTick}`).join(", ")}`);
log(`  asks: ${book.asks.map((o) => `${Number(o.amount) / 1e6}@${o.priceTick}`).join(", ")}`);
