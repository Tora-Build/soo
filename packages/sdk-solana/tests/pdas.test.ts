// PDA seed and encoding goldens.
//
// These pin the SEEDS and their byte encoding — the tick's endianness in
// particular, where a wrong choice derives a valid-looking address for the
// wrong price level and fails only at simulation.
//
// The program id is pinned to a FIXED test value rather than taken from the
// deployed one. A PDA is a function of (seeds, program id), so goldens built
// against the live id break on every redeploy — which is a deployment event,
// not a regression, and the four failures it produced said nothing about the
// thing this file exists to protect. Pinning it means a changed seed still
// fails loudly and a new program id does not.

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  bookSidePda,
  marketBookPda,
  marketFeePoolPda,
  orderbookPositionPda,
} from "../src/pdas.js";

/** Arbitrary and fixed. Never point this at the deployed program. */
const PROGRAM = {
  soothCore: new PublicKey("SoothTeSt1111111111111111111111111111111111"),
};

const MARKET_ID = Uint8Array.from([
  0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x01, 0x23, 0x45, 0x67,
  0x89, 0xab, 0xcd, 0xef,
]);
const USER = new PublicKey(Uint8Array.from(Array(32).fill(0x42)));

describe("SoothBook PDA derivation parity", () => {
  it("market_book_pda_derives_correctly", () => {
    const [pda] = marketBookPda(MARKET_ID, PROGRAM);
    expect(pda.toBase58()).toBe("67yEtkmjdjjjPjVdpTBb534xtHXZPUagiRVNKWy37fhf");
  });

  it("book_side_pda_tick_endianness", () => {
    const [pda] = bookSidePda(MARKET_ID, 1, 500, PROGRAM);
    expect(pda.toBase58()).toBe("9MfAwgHs6TdwEi1sdhaHKhHbyK3rACqy2o5Z4CdX2UBN");

    // The endianness assertion only means something if a different tick
    // actually lands somewhere else.
    const [other] = bookSidePda(MARKET_ID, 1, 0x01f4_00 & 0xffff, PROGRAM);
    expect(other.toBase58()).not.toBe(pda.toBase58());
  });

  it("orderbook_position_pda_derives_correctly", () => {
    const [pda] = orderbookPositionPda(MARKET_ID, USER, PROGRAM);
    expect(pda.toBase58()).toBe("GfWyc3KRrNSfkfSX5Ld1fVzNcSRaaj4kU19gt2xov6zA");
  });

  it("market_fee_pool_pda_derives_correctly", () => {
    const [pda] = marketFeePoolPda(MARKET_ID, PROGRAM);
    expect(pda.toBase58()).toBe("G1KpTbfvm1U9njdQ22AHJBRBWtbkh2DFXrGtrQT2bbiQ");
  });
});
