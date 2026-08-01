import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { BUY_DISCRIMINATOR, PROGRAM_IDS } from "../src/config.js";
import { decodeOrdersFilledInstructionData } from "../src/decode-ordersfilled.js";
import { createApp } from "../src/index.js";
import { encodeBase58 } from "../src/base58.js";
import { deriveMarketKey } from "../src/market-key.js";

const fixturePath = join(
  import.meta.dirname,
  "fixtures",
  "ordersfilled.bin",
);

describe("fills endpoint", () => {
  it("resolves a marketKey and returns the IndexedFill shape", async () => {
    const fixture = new Uint8Array(await readFile(fixturePath));
    const decoded = decodeOrdersFilledInstructionData(fixture);
    const market = decoded!.market;
    const marketKey = deriveMarketKey(market);
    const dir = await mkdtemp(join(tmpdir(), "sooth-data-fills-"));
    const metadataPath = join(dir, "market-meta.json");
    await writeFile(
      metadataPath,
      JSON.stringify({
        [market]: {
          questionHash: "fixture",
          question: "Fixture market",
          event: "Fixture",
          category: "test",
          rule: "fixture",
          createdAt: 1,
          deadline: 2,
        },
      }),
      "utf8",
    );

    const calls: unknown[] = [];
    const app = createApp({
      metadataPath,
      connection: {
        getSlot: async () => 0,
        getSignaturesForAddress: async (address, options) => {
          calls.push({ address: address.toBase58(), options });
          return [{ signature: "fixture-signature", err: null }];
        },
        getTransaction: async (_signature, config) => {
          calls.push({ config });
          return {
            // The decoder requires the record's parent to be
            // sooth_core::buy — see test/authenticity.test.ts. A mock without
            // the outer instruction now correctly yields no fills.
            transaction: {
              message: {
                instructions: [
                  {
                    programId: new PublicKey(PROGRAM_IDS.SOOTH_CORE),
                    data: Buffer.from(BUY_DISCRIMINATOR),
                  },
                ],
              },
            },
            meta: {
              err: null,
              innerInstructions: [
                {
                  index: 0,
                  instructions: [
                    {
                      programId: new PublicKey(PROGRAM_IDS.SOOTH_CORE),
                      data: encodeBase58(fixture),
                    },
                  ],
                },
              ],
            },
          };
        },
      },
    });

    const resp = await app.request(`/v12/fills/902/${marketKey}?limit=5`);

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual([
      {
        yesTick: 950,
        amount: decoded!.fills[0]!.amount.toString(),
        timestamp: decoded!.fills[0]!.ts.toString(),
      },
    ]);
    expect(calls).toContainEqual({
      address: market,
      options: { limit: 5 },
    });
    expect(calls).toContainEqual({
      config: { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    });
  });

  it("resolves any valid marketKey without metadata, and 404s malformed ones", async () => {
    const app = createApp({
      connection: {
        getSlot: async () => 0,
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null,
      },
    });

    // A well-formed 32-byte key now resolves even though no metadata entry
    // exists for it. main returned 404 here, because keys could only be
    // resolved through an alias map built from the hand-edited
    // data/market-meta.json — so a market created after the last edit was
    // invisible until someone remembered to add it.
    const wellFormed = await app.request(
      `/v12/fills/902/0x${"00".repeat(32)}?limit=1`,
    );
    expect(wellFormed.status).toBe(200);
    expect(await wellFormed.json()).toEqual([]);

    // A raw base58 pubkey still works.
    const raw = await app.request(
      "/v12/fills/902/11111111111111111111111111111111?limit=1",
    );
    expect(raw.status).toBe(200);
    expect(await raw.json()).toEqual([]);

    // Genuinely unresolvable input still 404s: wrong length, not base58, and
    // not a known alias.
    const malformed = await app.request("/v12/fills/902/0xdeadbeef?limit=1");
    expect(malformed.status).toBe(404);
  });
});
