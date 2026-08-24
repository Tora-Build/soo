// On-chain discovery of "markets this wallet created".
//
// The registry-less discovery every other surface uses is a build-time
// snapshot filtered to the CURRENT collateral mint — a trading filter, which
// is right for the deck and wrong for the founder's console: a market created
// before the mint changed still needs locking, attesting and settling, and
// the person who created it is the one the program lets do it. Three of the
// reporting founder's six markets — precisely the three whose deadlines had
// passed — were invisible to the very panel built to resolve them.
//
// So the console asks the chain directly: one getProgramAccounts, keyed by
// `Market.creator` (offset 24: an 8-byte discriminator then the 16-byte
// market_id), sized to the Market account so no other account type can
// alias, and sliced to zero data because only the addresses matter.
//
// The app's proxied RPC refuses getProgramAccounts on its free tier, so this
// goes to the public devnet endpoint — the same one the snapshot script
// scans. One call per wallet per session; the result is handed to the
// resolution store, not the global registry, so untradeable old-mint markets
// do not leak into the trading deck.

const DISCOVERY_RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = "EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw";
const MARKET_ACCOUNT_SIZE = 335;
const CREATOR_OFFSET = 24;

const cache = new Map<string, Promise<string[]>>();

export function discoverCreatedMarkets(creatorBase58: string): Promise<string[]> {
  const hit = cache.get(creatorBase58);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(DISCOVERY_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          PROGRAM_ID,
          {
            encoding: "base64",
            dataSlice: { offset: 0, length: 0 },
            filters: [
              { dataSize: MARKET_ACCOUNT_SIZE },
              { memcmp: { offset: CREATOR_OFFSET, bytes: creatorBase58 } },
            ],
          },
        ],
      }),
    });
    const body = (await res.json()) as {
      result?: Array<{ pubkey: string }>;
    };
    return (body.result ?? []).map((r) => `sol:${r.pubkey}`);
  })().catch((): string[] => {
    // A failed discovery must not wedge future attempts on a flaky RPC.
    cache.delete(creatorBase58);
    return [];
  });
  cache.set(creatorBase58, p);
  return p;
}
