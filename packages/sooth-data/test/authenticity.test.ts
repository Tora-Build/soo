// Fill authenticity.
//
// `sooth_log::log` takes no accounts and no signer, so ANY wallet can invoke it
// with a hand-crafted OrdersFilled payload naming any market. The only thing
// separating a real fill from a fabricated one is the PARENT: a record is
// trustworthy exactly when it is a direct child of a successful top-level
// `sooth_core::buy`.
//
// main's decoder checked only that the inner instruction targeted the sooth_log
// program — it never read `group.index`, so the parent was never identified.
// Anyone could append a `sooth_log::log` call to their own transaction and have
// invented trades served as real ones, driving the demo's price chart and trade
// history off attacker-supplied data.
//
// These tests build both shapes and assert only the genuine one survives.

import { describe, expect, it } from "vitest";

import { BUY_DISCRIMINATOR, PROGRAM_IDS } from "../src/config.js";
import {
  ORDERS_FILLED_DISCRIMINATOR,
  decodeOrdersFilledFromTransaction,
  isBuyParent,
} from "../src/decode-ordersfilled.js";
import { decodeBase58, encodeBase58 } from "../src/base58.js";

const MARKET = "7J6eKSPiYyxsvvCzUL2gG8DDZ9yZ1FiU2z1yvK6ykvFe";
const TAKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MAKER = "3nSDpX3xQ5jFVfXcqsu9pjNqSZzZfKcRLcMzYvKvJHrY";

/** `[8-byte log disc][u32 len][8-byte event disc][borsh OrdersFilled]` — the
 *  exact framing sooth_core produces, asserted from the producing side in
 *  packages/sdk-solana/tests/orders-filled-event.test.ts. */
function buildLogIxData(market: string, fills = 1): Uint8Array {
  const event: number[] = [];
  event.push(...ORDERS_FILLED_DISCRIMINATOR);
  event.push(...decodeBase58(market));
  event.push(...decodeBase58(TAKER));
  event.push(0); // taker_side
  const len = Buffer.alloc(4);
  len.writeUInt32LE(fills, 0);
  event.push(...len);
  for (let i = 0; i < fills; i += 1) {
    event.push(...decodeBase58(MAKER));
    event.push(...Buffer.alloc(8)); // maker_order_id
    const yes = Buffer.alloc(2);
    yes.writeUInt16LE(950, 0);
    event.push(...yes);
    const no = Buffer.alloc(2);
    no.writeUInt16LE(900, 0);
    event.push(...no);
    const amount = Buffer.alloc(16);
    amount.writeBigUInt64LE(1_000n, 0);
    event.push(...amount);
    event.push(...Buffer.alloc(16)); // surplus
    const ts = Buffer.alloc(8);
    ts.writeBigInt64LE(1_700_000_000n, 0);
    event.push(...ts);
  }

  const payload = Uint8Array.from(event);
  // Anchor's self-CPI event tag. Unlike the old sooth_log framing this is a
  // FIXED constant the decoder checks, so a stand-in value no longer works —
  // which is a small improvement: the framing is now self-identifying rather
  // than relying entirely on the program id.
  const cpiTag = Uint8Array.from([228, 69, 165, 46, 81, 203, 154, 29]);
  return Uint8Array.from([...cpiTag, ...payload]);
}

/** A transaction whose top-level instruction `parentProgram`/`parentData` owns
 *  one self-CPI event inner instruction. */
function buildTx(opts: {
  parentProgram: string;
  parentData: Uint8Array;
  market?: string;
  /** Report the inner group under a different parent index than exists. */
  groupIndex?: number;
  omitGroupIndex?: boolean;
  err?: unknown;
}) {
  const accountKeys = [TAKER, opts.parentProgram, PROGRAM_IDS.SOOTH_CORE];
  return {
    transaction: {
      message: {
        accountKeys,
        instructions: [
          {
            programIdIndex: 1,
            data: encodeBase58(opts.parentData),
            accounts: [],
          },
        ],
      },
    },
    meta: {
      err: opts.err ?? null,
      innerInstructions: [
        {
          ...(opts.omitGroupIndex ? {} : { index: opts.groupIndex ?? 0 }),
          instructions: [
            {
              programIdIndex: 2,
              data: encodeBase58(buildLogIxData(opts.market ?? MARKET)),
              accounts: [],
            },
          ],
        },
      ],
    },
  };
}

describe("OrdersFilled authenticity", () => {
  it("accepts a record whose parent is sooth_core::buy", () => {
    const tx = buildTx({
      parentProgram: PROGRAM_IDS.SOOTH_CORE,
      parentData: Uint8Array.from([...BUY_DISCRIMINATOR, 1, 2, 3]),
    });
    const events = decodeOrdersFilledFromTransaction(tx);
    expect(events).toHaveLength(1);
    expect(events[0]!.market).toBe(MARKET);
    expect(events[0]!.fills).toHaveLength(1);
    expect(events[0]!.fills[0]!.yes_tick).toBe(950);
  });

  it("REJECTS a record injected under an unrelated parent program", () => {
    // The attack: invoke sooth_log directly from your own transaction. Under
    // main's decoder this was indistinguishable from a real fill.
    const tx = buildTx({
      parentProgram: "11111111111111111111111111111111",
      parentData: Uint8Array.from([0, 0, 0, 0]),
    });
    expect(decodeOrdersFilledFromTransaction(tx)).toHaveLength(0);
  });

  it("REJECTS a record whose parent is sooth_core but not `buy`", () => {
    // Right program, wrong instruction — e.g. a cancel with a log call bolted
    // on. Checking the program id alone is not enough.
    const tx = buildTx({
      parentProgram: PROGRAM_IDS.SOOTH_CORE,
      parentData: Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]),
    });
    expect(decodeOrdersFilledFromTransaction(tx)).toHaveLength(0);
  });

  it("REJECTS when the parent index is absent", () => {
    // Without an index the parent is unknowable, so the record cannot be
    // trusted. Failing closed is the only safe default.
    const tx = buildTx({
      parentProgram: PROGRAM_IDS.SOOTH_CORE,
      parentData: Uint8Array.from([...BUY_DISCRIMINATOR]),
      omitGroupIndex: true,
    });
    expect(decodeOrdersFilledFromTransaction(tx)).toHaveLength(0);
  });

  it("REJECTS when the parent index points outside the instruction list", () => {
    const tx = buildTx({
      parentProgram: PROGRAM_IDS.SOOTH_CORE,
      parentData: Uint8Array.from([...BUY_DISCRIMINATOR]),
      groupIndex: 7,
    });
    expect(decodeOrdersFilledFromTransaction(tx)).toHaveLength(0);
  });

  it("REJECTS records from a reverted transaction", () => {
    // Some RPC shapes still report innerInstructions for failed transactions;
    // nothing inside a reverted transaction happened.
    const tx = buildTx({
      parentProgram: PROGRAM_IDS.SOOTH_CORE,
      parentData: Uint8Array.from([...BUY_DISCRIMINATOR]),
      err: { InstructionError: [0, { Custom: 6054 }] },
    });
    expect(decodeOrdersFilledFromTransaction(tx)).toHaveLength(0);
  });

  it("the escape hatch exists but is opt-in", () => {
    // Proves the rejections above come from the parent check and not from a
    // malformed fixture: the same forged transaction decodes when the check is
    // explicitly disabled.
    const tx = buildTx({
      parentProgram: "11111111111111111111111111111111",
      parentData: Uint8Array.from([0, 0, 0, 0]),
    });
    expect(
      decodeOrdersFilledFromTransaction(tx, PROGRAM_IDS.SOOTH_CORE, {
        trustUnverifiedParents: true,
      }),
    ).toHaveLength(1);
  });
});

describe("isBuyParent", () => {
  it("distinguishes buy from other sooth_core instructions", () => {
    const buyTx = buildTx({
      parentProgram: PROGRAM_IDS.SOOTH_CORE,
      parentData: Uint8Array.from([...BUY_DISCRIMINATOR]),
    });
    expect(isBuyParent(buyTx, 0)).toBe(true);
    expect(isBuyParent(buyTx, 1)).toBe(false);

    const otherTx = buildTx({
      parentProgram: PROGRAM_IDS.SOOTH_CORE,
      parentData: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]),
    });
    expect(isBuyParent(otherTx, 0)).toBe(false);
  });
});
