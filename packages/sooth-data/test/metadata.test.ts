import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/index.js";
import { loadMarketMeta, upsertMarketMeta } from "../src/metadata.js";

describe("market metadata", () => {
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
        address: "0xh3gk2v6vkjbs9f6is7sk2i5meufcrdqhieydcggbuxxr",
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
