import { upsertMarketMeta, type MarketMetaEntry } from "./metadata.js";

type SeedMetaArg = MarketMetaEntry & {
  address: string;
};

function parseSeedArg(raw: string | undefined): SeedMetaArg {
  if (!raw) {
    throw new Error(
      'usage: pnpm --filter @sooth/sooth-data seed:meta \'{"address":"...","questionHash":"...","question":"...","event":"...","category":"...","rule":"...","createdAt":1716000000,"deadline":1716086400}\'',
    );
  }
  const parsed = JSON.parse(raw) as SeedMetaArg;
  if (!parsed.address) {
    throw new Error("seed metadata JSON must include address");
  }
  return parsed;
}

try {
  const { address, ...entry } = parseSeedArg(process.argv[2]);
  await upsertMarketMeta(address, entry);
  console.log(JSON.stringify({ ok: true, address }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
