import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { PROGRAM_IDS } from "../src/config.js";
import {
  BASE_TO_WAD,
  decodeBookEventInstructionData,
  type BookFilledEvent,
} from "../src/decode-book-events.js";
import { createApp } from "../src/index.js";
import { encodeBase58 } from "../src/base58.js";
import { deriveMarketKey } from "../src/market-key.js";

const fixturePath = join(import.meta.dirname, "fixtures", "bookfilled.bin");

describe("fills endpoint", () => {
  it("resolves a marketKey and returns the IndexedFill shape", async () => {
    // Bytes captured from a real BookFilled self-CPI, so the endpoint is
    // exercised over the same payload the program emits rather than a shape
    // invented by the test.
    const fixture = new Uint8Array(await readFile(fixturePath));
    const decoded = decodeBookEventInstructionData(fixture) as BookFilledEvent;
    const market = decoded.market;
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

    // An unrelated program's inner instruction, to prove the scan filters on
    // the emitting program rather than taking whatever it finds.
    const OTHER = Keypair.generate().publicKey.toBase58();

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
            transaction: {
              message: { accountKeys: [OTHER, PROGRAM_IDS.SOOTH_CORE] },
            },
            meta: {
              err: null,
              innerInstructions: [
                {
                  index: 0,
                  instructions: [
                    {
                      programIdIndex: 0,
                      data: encodeBase58(fixture),
                    },
                    {
                      programIdIndex: 1,
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
    // One fill per fill in the event — the impostor copy contributes none.
    expect(await resp.json()).toEqual(
      decoded.fills.map((fill) => ({
        yesTick: fill.price_tick,
        // Served in WAD, from base units on the wire: a consumer that plots
        // this alongside an AMM quote must not be off by 1e12.
        amount: (fill.amount * BASE_TO_WAD).toString(),
        timestamp: decoded.ts.toString(),
        source: "book",
      })),
    );
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
