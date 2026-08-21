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

// Discovery beats configuration: every Market account on the program,
// filtered to the current venue mint — markets holding a different
// token cannot trade, so they stay out.
// This is how a market created in one browser reaches every other one:
// the snapshot bakes the full list at build time.
const USDC_MINT = "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX";
const A58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex")), out = "";
  while (n > 0n) { out = A58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out;
}
async function discoverMarketRefs(connection) {
  const { PublicKey } = await import("@solana/web3.js");
  const pid = new PublicKey("EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw");
  const disc = Buffer.from([219, 190, 213, 55, 0, 227, 198, 154]);
  const accounts = await connection.getProgramAccounts(pid, {
    filters: [{ memcmp: { offset: 0, bytes: b58(disc) } }],
  });
  // Market layout: 8 disc + 16 market_id + 32 creator + 32 adjudicator +
  // 32 question_hash + 32 vault_book + 32 vault_amm … — one batched vault
  // read instead of a request per market, or the public RPC rate-limits.
  const vaults = accounts.map(
    ({ account }) => new PublicKey(account.data.subarray(152, 184)),
  );
  const infos = [];
  for (let i = 0; i < vaults.length; i += 100) {
    infos.push(...(await connection.getMultipleAccountsInfo(vaults.slice(i, i + 100))));
  }
  const refs = [];
  accounts.forEach(({ pubkey }, i) => {
    const vault = infos[i];
    if (!vault) return;
    const mint = new PublicKey(vault.data.subarray(0, 32)).toBase58();
    if (mint === USDC_MINT) refs.push(`sol:${pubkey.toBase58()}`);
  });
  return refs.sort();
}

const envRefs = [get("VITE_DEMO_MARKET_REF"), ...get("VITE_DEMO_EXTRA_MARKET_REFS").split(",")]
  .map((s) => s.trim()).filter(Boolean);

const adapter = new SolanaChainAdapter({
  node: { chainKind: "solana" },
  connection: new Connection(rpc, "confirmed"),
});

const { Connection: DiscoveryConnection } = await import("@solana/web3.js");
const discovered = await discoverMarketRefs(
  new DiscoveryConnection(
    process.env.DISCOVERY_RPC_URL || "https://api.devnet.solana.com",
    "confirmed",
  ),
);
const refs = [...new Set([...envRefs, ...discovered])];
console.log(`markets: ${refs.length} (${discovered.length} discovered on-chain)`);

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
