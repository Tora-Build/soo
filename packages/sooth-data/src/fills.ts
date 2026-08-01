import { PublicKey } from "@solana/web3.js";

import { PROGRAM_IDS } from "./config.js";
import {
  decodeOrdersFilledFromTransaction,
  type FillRecord,
} from "./decode-ordersfilled.js";
import {
  BASE_TO_WAD,
  decodeBookEventsFromTransaction,
  type BookFillRecord,
} from "./decode-book-events.js";
import {
  deriveMarketKey,
  marketAddressFromKey,
  normalizeMarketKey,
} from "./market-key.js";
import { loadMarketMeta, type MarketMetaStore } from "./metadata.js";

export type IndexedFill = {
  yesTick: number;
  /** WAD (1e18) shares, for both sources — see `bookFillToIndexed`. */
  amount: string;
  timestamp: string;
  /**
   * Which book produced this fill.
   *
   * `"legacy"` is the per-tick-account book, `"book"` the redesigned single
   * account. Both are served from the same endpoint while they coexist, so a
   * consumer can tell them apart without changing shape.
   */
  source: "legacy" | "book";
};

export type SignatureInfo = {
  signature: string;
  err?: unknown;
};

export type FillsConnection = {
  getSignaturesForAddress(
    address: PublicKey,
    options: { limit: number },
  ): Promise<SignatureInfo[]>;
  getTransaction(
    signature: string,
    config: { commitment: "confirmed"; maxSupportedTransactionVersion: 0 },
  ): Promise<unknown | null>;
};

type CacheEntry = {
  expiresAt: number;
  fills: IndexedFill[];
};

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, CacheEntry>();

// OPERATIONAL NOTE — this service is RPC-heavy by construction.
//
// Every uncached request does one getSignaturesForAddress plus one
// getTransaction PER SIGNATURE (up to `limit`, default 2000). Verified against
// public devnet: a single cold /v12/fills request succeeds in ~2.7s, and a
// second uncached request for a different market immediately returns
// "429 Too Many Requests" from api.devnet.solana.com — web3.js retries four
// times with backoff and then throws, surfacing as a 500.
//
// The 10s in-memory cache hides this for repeat reads of the SAME market
// (subsequent hits return in ~0ms) but does nothing for a market list or a
// cold cache. Anything beyond a demo needs a dedicated RPC with a real quota,
// and ultimately persistence rather than rescanning transactions per request.

function parsePublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

export function buildMarketAliasMap(store: MarketMetaStore): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const address of Object.keys(store)) {
    try {
      aliases.set(normalizeMarketKey(deriveMarketKey(address)), address);
    } catch {
      // A malformed address in the metadata file should not take the whole
      // service down; it just cannot be resolved by key.
    }
  }
  return aliases;
}

/**
 * Resolve a marketKey (or a raw base58 address) to a market address.
 *
 * Because marketKey is now the pubkey's own bytes, this inverts directly and
 * ANY market resolves — main could only serve markets that appeared in the
 * hand-edited `data/market-meta.json`, which meant a newly created market
 * returned 404 until someone remembered to add it. The metadata lookup is
 * kept last for backwards compatibility with keys minted by the old scheme.
 */
export function resolveMarketAddress(
  marketKey: string,
  store: MarketMetaStore,
): string | null {
  const rawPubkey = parsePublicKey(marketKey);
  if (rawPubkey) return rawPubkey.toBase58();

  const decoded = marketAddressFromKey(marketKey);
  if (decoded) {
    const pubkey = parsePublicKey(decoded);
    if (pubkey) return pubkey.toBase58();
  }

  return buildMarketAliasMap(store).get(normalizeMarketKey(marketKey)) ?? null;
}

function parseLimit(value: string | undefined): number {
  if (!value) return 2_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2_000;
  return Math.min(Math.floor(parsed), 2_000);
}

function toIndexedFill(fill: FillRecord): IndexedFill {
  return {
    yesTick: fill.yes_tick,
    amount: fill.amount.toString(),
    timestamp: fill.ts.toString(),
    source: "legacy",
  };
}

/**
 * Map a redesigned-book fill onto the same shape.
 *
 * Two conversions, both deliberate:
 *
 *   - `price_tick` IS the YES price. The unified axis quotes everything on it,
 *     so an ask at tick 400 is "YES at 0.40" and needs no complement flip —
 *     which is exactly the class of error that produced bug B2 in the legacy
 *     book, where the two ticks were emitted swapped.
 *   - `amount` is USDC base units on the new book and WAD on the old one.
 *     Scaling here keeps `IndexedFill.amount` a single unit, so a consumer
 *     charting both does not silently plot one 1e12 times the other.
 */
function bookFillToIndexed(fill: BookFillRecord, ts: bigint): IndexedFill {
  return {
    yesTick: fill.price_tick,
    amount: (fill.amount * BASE_TO_WAD).toString(),
    timestamp: ts.toString(),
    source: "book",
  };
}

async function collectFillsFromSignatures(
  connection: FillsConnection,
  signatures: SignatureInfo[],
  market: string,
  limit: number,
): Promise<IndexedFill[]> {
  const fills: IndexedFill[] = [];
  for (const sig of signatures) {
    if (sig.err) continue;
    const tx = await connection.getTransaction(sig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const txMeta = (tx as { meta?: { err?: unknown } } | null)?.meta;
    if (!tx || txMeta?.err) continue;

    for (const event of decodeOrdersFilledFromTransaction(tx)) {
      if (event.market !== market) continue;
      for (const fill of event.fills) {
        fills.push(toIndexedFill(fill));
        if (fills.length >= limit) return fills;
      }
    }

    // The redesigned book, served from the same endpoint while both exist.
    for (const event of decodeBookEventsFromTransaction(tx)) {
      if (event.kind !== "book_filled" || event.market !== market) continue;
      for (const fill of event.fills) {
        fills.push(bookFillToIndexed(fill, event.ts));
        if (fills.length >= limit) return fills;
      }
    }
  }
  return fills;
}

export async function getFillsForMarketKey(options: {
  chainId: string;
  connection: FillsConnection;
  marketKey: string;
  metadataPath: string;
  limit?: string;
}): Promise<{ status: 200; fills: IndexedFill[] } | { status: 404 }> {
  const limit = parseLimit(options.limit);
  const cacheKey = `${options.chainId}:${normalizeMarketKey(options.marketKey)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { status: 200, fills: cached.fills.slice(0, limit) };
  }

  const store = await loadMarketMeta(options.metadataPath);
  const marketAddress = resolveMarketAddress(options.marketKey, store);
  if (!marketAddress) return { status: 404 };

  const marketPubkey = new PublicKey(marketAddress);
  const signatureLimit = Math.min(limit, 1_000);
  const marketSignatures = await options.connection.getSignaturesForAddress(
    marketPubkey,
    { limit: signatureLimit },
  );
  let fills = await collectFillsFromSignatures(
    options.connection,
    marketSignatures,
    marketAddress,
    limit,
  );

  if (fills.length === 0) {
    const programSignatures = await options.connection.getSignaturesForAddress(
      new PublicKey(PROGRAM_IDS.SOOTH_CORE),
      { limit: signatureLimit },
    );
    fills = await collectFillsFromSignatures(
      options.connection,
      programSignatures,
      marketAddress,
      limit,
    );
  }

  fills.sort((a, b) => Number(BigInt(b.timestamp) - BigInt(a.timestamp)));
  const capped = fills.slice(0, limit);
  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    fills: capped,
  });
  return { status: 200, fills: capped };
}
