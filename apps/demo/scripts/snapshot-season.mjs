// Season snapshot: the chain-derived play tape, captured at build time.
//
// A cold browser would otherwise walk every play transaction before the
// leaderboard renders — hundreds of RPC calls on first visit. This script
// does that walk once, at deploy time, and writes the tape into the bundle;
// clients hydrate instantly and fetch only plays newer than each market's
// cursor. Shape matches the client cache exactly (see
// src/features/arena/useSeasonLeaderboard.ts).
//
// Usage: SOLANA_RPC_URL=<rpc> node scripts/snapshot-season.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";
import { SolanaChainAdapter } from "@sooth/sdk-solana";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "src/features/arena/season-snapshot.json");

const env = readFileSync(resolve(ROOT, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
const rpc = process.env.SOLANA_RPC_URL || get("VITE_SOLANA_RPC_URL");
const refs = [get("VITE_DEMO_MARKET_REF"), ...get("VITE_DEMO_EXTRA_MARKET_REFS").split(",")]
  .map((s) => s.trim()).filter(Boolean);

const adapter = new SolanaChainAdapter({
  node: { chainKind: "solana" },
  connection: new Connection(rpc, "confirmed"),
});

const markets = {};
for (const ref of refs) {
  const { plays, latestSignature } = await adapter.readMarketPlays(ref);
  markets[ref] = {
    cursor: latestSignature,
    plays: plays.map((p) => ({
      wallet: p.wallet,
      venue: p.venue,
      role: p.role,
      sizeWad: p.sizeWad.toString(),
      costWad: p.costWad === undefined ? undefined : p.costWad.toString(),
      ts: p.ts,
      signature: p.signature,
    })),
  };
  console.log(`${ref}: ${plays.length} plays, cursor=${(latestSignature ?? "").slice(0, 8)}…`);
}
writeFileSync(OUT, JSON.stringify({ version: 1, markets }, null, 0) + "\n");
console.log(`wrote ${OUT}`);
