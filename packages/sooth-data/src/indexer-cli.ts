// Run the indexer.
//
//   cp .env.example .env    # then fill in ALCHEMY_API_KEY and SOOTH_MARKETS
//   pnpm --filter @sooth/sooth-data indexer
//
// Separate entry point from the HTTP service on purpose: in any real
// deployment they are separate processes, so an RPC outage in the ingester does
// not take the API down with it, and either can be restarted alone.

import { Connection, PublicKey } from "@solana/web3.js";

import {
  HAS_ACCOUNT_ARCHIVE,
  PROGRAM_IDS,
  RPC_URL,
  SOOTH_DATA_CHAIN,
} from "./config.js";
import { startIndexer } from "./indexer-run.js";

const dbPath = process.env.SOOTH_INDEX_DB || "./sooth-index.db";
const markets = (process.env.SOOTH_MARKETS || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

if (markets.length === 0) {
  console.error(
    "SOOTH_MARKETS is empty — nothing to index.\n" +
      "Set it to a comma-separated list of market PDAs (see .env.example).",
  );
  process.exit(1);
}

const programId = process.env.SOOTH_CORE_PROGRAM_ID || PROGRAM_IDS.SOOTH_CORE;
const connection = new Connection(RPC_URL, "confirmed");

// The book PDA is derived from `market_id`, which lives INSIDE the market
// account — so this has to read each market once before it can index it.
const pairs: Array<{ market: string; book: string }> = [];
for (const market of markets) {
  const info = await connection.getAccountInfo(new PublicKey(market));
  if (!info) {
    console.warn(`[indexer] no account at ${market} — skipping`);
    continue;
  }
  // `market_id` is the first field after the 8-byte discriminator and is 16
  // bytes. Read at its offset rather than decoding the whole account, so a
  // market written by an older program layout still indexes.
  const marketId = info.data.subarray(8, 24);
  const [book] = PublicKey.findProgramAddressSync(
    [Buffer.from("book"), marketId],
    new PublicKey(programId),
  );
  pairs.push({ market, book: book.toBase58() });
}

console.log(
  `[indexer] chain=${SOOTH_DATA_CHAIN} rpc=${RPC_URL.replace(/\/v2\/.*/, "/v2/***")} ` +
    `archive=${HAS_ACCOUNT_ARCHIVE ? "yes" : "no"} db=${dbPath} markets=${pairs.length}`,
);

const handle = startIndexer({
  rpcUrl: RPC_URL,
  dbPath,
  programId,
  markets: pairs,
  pollMs: Number(process.env.SOOTH_INDEX_POLL_MS || 5_000),
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("\n[indexer] stopping");
    handle.stop();
    process.exit(0);
  });
}
