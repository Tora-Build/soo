import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type MarketMetaEntry = {
  questionHash: string;
  question: string;
  event: string;
  category: string;
  rule: string;
  createdAt: number;
  deadline: number;
};

export type MarketMetaStore = Record<string, MarketMetaEntry>;

export type LaunchpadMarket = {
  address: string;
  name: string;
  createdAt: number;
  deadline: number;
};

export const DEFAULT_MARKET_META_PATH = fileURLToPath(
  new URL("../data/market-meta.json", import.meta.url),
);

/// Wraps a base58 pubkey in the `0x` prefix the EVM-shaped market list is
/// typed for. Case is preserved: base58 is case-sensitive, so a folded
/// address cannot be decoded back to a pubkey. Consumers that compare these
/// case-insensitively must fold both sides.
function toSyntheticAddress(address: string): string {
  const base58 = address.startsWith("0x") ? address.slice(2) : address;
  return `0x${base58}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiniteUnixSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`market metadata ${field} must be a finite number`);
  }
  return Math.floor(value);
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`market metadata ${field} must be a non-empty string`);
  }
  return value;
}

function parseEntry(value: unknown): MarketMetaEntry {
  if (!isObject(value)) {
    throw new Error("market metadata entry must be an object");
  }
  return {
    questionHash: parseString(value.questionHash, "questionHash"),
    question: parseString(value.question, "question"),
    event: parseString(value.event, "event"),
    category: parseString(value.category, "category"),
    rule: parseString(value.rule, "rule"),
    createdAt: parseFiniteUnixSeconds(value.createdAt, "createdAt"),
    deadline: parseFiniteUnixSeconds(value.deadline, "deadline"),
  };
}

export function parseMarketMetaStore(value: unknown): MarketMetaStore {
  if (!isObject(value)) {
    throw new Error("market metadata store must be an object");
  }
  const store: MarketMetaStore = {};
  for (const [address, entry] of Object.entries(value)) {
    store[parseString(address, "address")] = parseEntry(entry);
  }
  return store;
}

export async function loadMarketMeta(
  metadataPath = DEFAULT_MARKET_META_PATH,
): Promise<MarketMetaStore> {
  try {
    const raw = await readFile(metadataPath, "utf8");
    return parseMarketMetaStore(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function toLaunchpadMarkets(store: MarketMetaStore): LaunchpadMarket[] {
  return Object.entries(store).map(([address, entry]) => ({
    address: toSyntheticAddress(address),
    name: entry.question,
    createdAt: entry.createdAt,
    deadline: entry.deadline,
  }));
}

export async function upsertMarketMeta(
  address: string,
  entry: MarketMetaEntry,
  metadataPath = DEFAULT_MARKET_META_PATH,
): Promise<MarketMetaStore> {
  const next = {
    ...(await loadMarketMeta(metadataPath)),
    [parseString(address, "address")]: parseEntry(entry),
  };
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
