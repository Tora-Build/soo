// The indexer loop.
//
// Backfills each market once, then tails forever. Both phases go through the
// same `ingestOnce`, which decides which it is from the stored cursor — so a
// restart mid-backfill resumes rather than starting over, and a restart during
// normal running picks up where it left off.
//
// ## Operating it
//
//   SOOTH_INDEX_DB=./sooth-index.db \
//   SOLANA_RPC_URL=https://api.devnet.solana.com \
//   SOOTH_MARKETS=<marketPubkey>,<marketPubkey> \
//   node dist/indexer-run.js
//
// It is safe to run alongside the API: SQLite is in WAL mode, so reads do not
// block behind writes.
//
// ## What it does not do yet
//
// It polls. `getSignaturesForAddress` plus one `getTransaction` per signature
// is portable and slow — a cold request measured ~2.7s against public devnet,
// and the second returned 429. Fine for testnet and for a handful of markets.
//
// A busy market wants a stream instead: Geyser/Yellowstone gRPC, or a provider
// webhook. The swap is contained — replace the two calls inside `ingestOnce`
// and the storage, cursor and idempotency all stay as they are. That is why
// the RPC surface is declared as a two-method interface rather than taking a
// `Connection`.

import { Connection, PublicKey } from "@solana/web3.js";

import { BookStore } from "./db.js";
import { ingestOnce, type IngestOptions } from "./ingest.js";

export interface IndexerConfig {
  rpcUrl: string;
  dbPath: string;
  programId: string;
  /** `{ market, book }` pairs — the book PDA is where events are emitted. */
  markets: Array<{ market: string; book: string }>;
  /** Gap between tail passes. Finalization lags ~13s, so faster gains little. */
  pollMs?: number;
}

export interface IndexerHandle {
  stop(): void;
  /** One pass over every market. Exposed so a test can drive it directly. */
  tick(): Promise<void>;
}

export function startIndexer(config: IndexerConfig): IndexerHandle {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const store = new BookStore(config.dbPath);
  const pollMs = config.pollMs ?? 5_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    for (const { market, book } of config.markets) {
      const opts: IngestOptions = {
        bookAddress: new PublicKey(book),
        market,
        programId: config.programId,
        pageSize: 1000,
        // Bounded per pass so one market's backfill cannot starve the others.
        // The cursor makes the next pass resume, so this costs latency on a
        // first sync and nothing afterwards.
        maxPages: 5,
      };
      try {
        const r = await ingestOnce(store, connection, opts);
        if (r.inserted > 0 || r.pending > 0) {
          console.log(
            `[indexer] ${market.slice(0, 8)}… scanned=${r.scanned} ` +
              `decoded=${r.decoded} inserted=${r.inserted} ` +
              `pending=${r.pending} backfilled=${r.backfilled}`,
          );
        }
      } catch (err) {
        // One market's RPC failure must not stop the others or kill the loop.
        // Rate limits are the expected case here, and the next pass retries
        // from the same cursor — nothing is lost by failing.
        console.warn(`[indexer] ${market.slice(0, 8)}… pass failed:`, err);
      }
    }
  };

  const loop = async () => {
    if (stopped) return;
    await tick();
    if (!stopped) timer = setTimeout(loop, pollMs);
  };
  void loop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      store.close();
    },
    tick,
  };
}
