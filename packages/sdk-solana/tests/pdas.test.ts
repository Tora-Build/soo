import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  bookSidePda,
  marketBookPda,
  marketFeePoolPda,
  orderbookPositionPda,
} from "../src/pdas.js";

const MARKET_ID = Uint8Array.from([
  0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x01, 0x23, 0x45, 0x67,
  0x89, 0xab, 0xcd, 0xef,
]);
const USER = new PublicKey(Uint8Array.from(Array(32).fill(0x42)));

describe("SoothBook PDA derivation parity", () => {
  it("market_book_pda_derives_correctly", () => {
    const [pda] = marketBookPda(MARKET_ID);
    expect(pda.toBase58()).toBe(
      "BzfZpzVXn1MViui2MamX5u1zTLkH5i6a6bYXnUM8NDZD",
    );
  });

  it("book_side_pda_tick_endianness", () => {
    const [pda] = bookSidePda(MARKET_ID, 1, 500);
    expect(pda.toBase58()).toBe(
      "4Ne6sVgcNSfsktHyZAc5uvnHP9kx2upCwd5RJLsX7ggU",
    );
  });

  it("orderbook_position_pda_derives_correctly", () => {
    const [pda] = orderbookPositionPda(MARKET_ID, USER);
    expect(pda.toBase58()).toBe(
      "4TsxBcZbWhcmhjdm2Sd9g5e7taAR8Ksgm98UjxwAxjdE",
    );
  });

  it("market_fee_pool_pda_derives_correctly", () => {
    const [pda] = marketFeePoolPda(MARKET_ID);
    expect(pda.toBase58()).toBe(
      "3iFiddMBgP7YjU65MiCeVUqADSmzF36NMjRhhHA3fmuC",
    );
  });
});
