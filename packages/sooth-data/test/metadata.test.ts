import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/index.js";
import { loadMarketMeta, upsertMarketMeta } from "../src/metadata.js";

describe("market metadata", () => {
  it("keeps the wrapped address decodable back to its pubkey", async () => {
    // Base58 is case-sensitive. Folding case here would produce a key no
    // consumer can turn back into a pubkey, which is why the wrapper only
    // adds the prefix.
    const { toLaunchpadMarkets } = await import("../src/metadata.js");
    const pubkey = "H3Gk2v6vKJbS9f6is7Sk2i5mEuFCRdqHiEyDcGGBuXxR";
    const [row] = toLaunchpadMarkets({
      [pubkey]: {
        questionHash: "aabbcc",
        question: "q",
        createdAt: 1,
        deadline: 2,
      },
    } as never);
    expect(row.address.slice(2)).toBe(pubkey);
  });


  it("maps stored market metadata to launchpad-markets response shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sooth-data-meta-"));
    const metadataPath = join(dir, "market-meta.json");
    await writeFile(
      metadataPath,
      JSON.stringify({
        H3Gk2v6vKJbS9f6is7Sk2i5mEuFCRdqHiEyDcGGBuXxR: {
          questionHash: "aabbcc",
          question: "Will SOL close above 200?",
          event: "SOL close",
          category: "crypto",
          rule: "Close price source",
          createdAt: 1_716_000_000,
          deadline: 1_716_086_400,
        },
      }),
      "utf8",
    );
    const app = createApp({
      connection: { getSlot: async () => 0 },
      metadataPath,
    });

    const resp = await app.request("/launchpad-markets/902");

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual([
      {
        address: "0xH3Gk2v6vKJbS9f6is7Sk2i5mEuFCRdqHiEyDcGGBuXxR",
        name: "Will SOL close above 200?",
        createdAt: 1_716_000_000,
        deadline: 1_716_086_400,
      },
    ]);
  });

  it("upserts a market metadata record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sooth-data-meta-"));
    const metadataPath = join(dir, "market-meta.json");

    await upsertMarketMeta(
      "H3Gk2v6vKJbS9f6is7Sk2i5mEuFCRdqHiEyDcGGBuXxR",
      {
        questionHash: "001122",
        question: "Will Jito volume rise?",
        event: "Jito volume",
        category: "crypto",
        rule: "Official source",
        createdAt: 1_716_000_100,
        deadline: 1_716_086_500,
      },
      metadataPath,
    );

    await expect(loadMarketMeta(metadataPath)).resolves.toEqual({
      H3Gk2v6vKJbS9f6is7Sk2i5mEuFCRdqHiEyDcGGBuXxR: {
        questionHash: "001122",
        question: "Will Jito volume rise?",
        event: "Jito volume",
        category: "crypto",
        rule: "Official source",
        createdAt: 1_716_000_100,
        deadline: 1_716_086_500,
      },
    });
  });
});
