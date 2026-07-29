import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  anchorEventDiscriminator,
  decodeOrdersFilledInstructionData,
  decodeOrdersFilledFromTransaction,
  ORDERS_FILLED_DISCRIMINATOR,
} from "../src/decode-ordersfilled.js";
import { BUY_DISCRIMINATOR, PROGRAM_IDS } from "../src/config.js";

const fixturePath = join(
  import.meta.dirname,
  "fixtures",
  "ordersfilled.bin",
);

describe("OrdersFilled decoder", () => {
  it("uses the Anchor OrdersFilled event discriminator", () => {
    expect(Array.from(anchorEventDiscriminator("OrdersFilled"))).toEqual(
      Array.from(ORDERS_FILLED_DISCRIMINATOR),
    );
    expect(Buffer.from(ORDERS_FILLED_DISCRIMINATOR).toString("hex")).toBe(
      "4706ce2cc1dc9455",
    );
  });

  it("decodes the real captured sooth_log inner instruction fixture", async () => {
    const fixture = new Uint8Array(await readFile(fixturePath));

    expect(Buffer.from(fixture.slice(12, 20)).toString("hex")).toBe(
      "4706ce2cc1dc9455",
    );

    const decoded = decodeOrdersFilledInstructionData(fixture);

    expect(decoded).not.toBeNull();
    expect(decoded?.fills).toHaveLength(1);
    const [fill] = decoded!.fills;
    expect(fill.yes_tick).toBeGreaterThanOrEqual(1);
    expect(fill.yes_tick).toBeLessThanOrEqual(999);
    expect(fill.yes_tick).toBe(950);
    expect(fill.no_tick).toBe(900);
    expect(fill.amount).toBeGreaterThan(0n);
    expect(fill.ts).toBeGreaterThan(0n);
  });

  // The transaction must carry the top-level `sooth_core::buy` the record
  // descends from. main's fixture had no outer instructions at all, because its
  // decoder never looked at the parent — see test/authenticity.test.ts.
  function txAroundFixture(
    fixture: Uint8Array,
    parentData: Uint8Array,
    parentProgram: string = PROGRAM_IDS.SOOTH_CORE,
  ) {
    return {
      transaction: {
        message: {
          instructions: [
            { programId: parentProgram, data: Buffer.from(parentData) },
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
                programId: PROGRAM_IDS.SOOTH_LOG,
                data: [Buffer.from(fixture).toString("base64"), "base64"],
              },
            ],
          },
        ],
      },
    };
  }

  it("finds the sooth_log inner instruction inside a transaction response", async () => {
    const fixture = new Uint8Array(await readFile(fixturePath));
    const events = decodeOrdersFilledFromTransaction(
      txAroundFixture(fixture, BUY_DISCRIMINATOR),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.fills).toHaveLength(1);
  });

  it("ignores the same inner instruction when the parent is not buy", async () => {
    // Same bytes, same program, only the parent differs — which is the entire
    // difference between a real fill and a forged one.
    const fixture = new Uint8Array(await readFile(fixturePath));
    expect(
      decodeOrdersFilledFromTransaction(
        txAroundFixture(fixture, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])),
      ),
    ).toHaveLength(0);
  });
});
