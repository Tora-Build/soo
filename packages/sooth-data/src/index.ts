import { serve } from "@hono/node-server";
import { Connection } from "@solana/web3.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { pathToFileURL } from "node:url";

import { ACTIVE_CHAIN, PORT, RPC_URL } from "./config.js";
import { getFillsForMarketKey, type FillsConnection } from "./fills.js";
import {
  DEFAULT_MARKET_META_PATH,
  loadMarketMeta,
  toLaunchpadMarkets,
} from "./metadata.js";

export type AppBindings = {
  Variables: Record<string, never>;
};

export type CreateAppOptions = {
  connection?: Partial<FillsConnection> & {
    getSlot?: (commitment?: "confirmed") => Promise<number>;
  };
  metadataPath?: string;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppBindings>();
  // Browser callers (the demo on http://localhost:5175, or any deployed
  // origin) enforce CORS; without this every fetch from the SPA fails with
  // "No 'Access-Control-Allow-Origin' header" while curl/server-side probes
  // still succeed — a silent browser-only break. This is a public read-only
  // data service, so a permissive policy (any origin, GET/OPTIONS) is
  // correct and matches the integrator contract.
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));
  const fallbackConnection = new Connection(RPC_URL, "confirmed");
  const connection = options.connection ?? fallbackConnection;
  const metadataPath = options.metadataPath ?? DEFAULT_MARKET_META_PATH;

  app.get("/api-health", (c) => c.json({ ok: true }));

  app.get("/status", async (c) => {
    const getSlot =
      connection.getSlot?.bind(connection) ??
      fallbackConnection.getSlot.bind(fallbackConnection);
    const slot = await getSlot("confirmed").catch(() => 1001);
    return c.json({
      [ACTIVE_CHAIN.chainName]: {
        id: ACTIVE_CHAIN.id,
        block: {
          number: slot,
          timestamp: Math.floor(Date.now() / 1000),
        },
      },
    });
  });

  app.get("/launchpad-markets/:chainId", async (c) => {
    const store = await loadMarketMeta(metadataPath);
    return c.json(toLaunchpadMarkets(store));
  });

  app.get("/v12/fills/:chainId/:marketKey", async (c) => {
    const result = await getFillsForMarketKey({
      chainId: c.req.param("chainId"),
      connection: connection as FillsConnection,
      marketKey: c.req.param("marketKey"),
      metadataPath,
      limit: c.req.query("limit"),
    });
    if (result.status === 404) {
      return c.json({ error: "unknown marketKey" }, 404);
    }
    return c.json(result.fills);
  });

  return app;
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  serve({ fetch: createApp().fetch, port: PORT }, (info) => {
    console.log(`sooth-data listening on http://localhost:${info.port}`);
  });
}

// Indexer surface. Kept as named exports rather than started here: the API and
// the ingester are separate processes in any real deployment, and coupling
// them would mean an RPC outage in one taking down the other.
export { BookStore, type BookEventRow, type BookFillRow } from "./db.js";
export { ingestOnce, toRows, type IngestConnection, type IngestOptions, type IngestResult } from "./ingest.js";
export { startIndexer, type IndexerConfig, type IndexerHandle } from "./indexer-run.js";
