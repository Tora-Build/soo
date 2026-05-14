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
      "CvDMGEcrNzGZQkoc5iMWcqHhxzDUSGje1HLVwawrfcJq",
    );
  });

  it("book_side_pda_tick_endianness", () => {
    const [pda] = bookSidePda(MARKET_ID, 1, 500);
    expect(pda.toBase58()).toBe(
      "C742iAc1Xq2y6sUqhcQK6RnLRdm37DtVF1bzAx6FhYmD",
    );
  });

  it("orderbook_position_pda_derives_correctly", () => {
    const [pda] = orderbookPositionPda(MARKET_ID, USER);
    expect(pda.toBase58()).toBe(
      "HviFSKyKgVrijyWtQWScJj7UAznqGE9oCViMjD2TrVDb",
    );
  });

  it("market_fee_pool_pda_derives_correctly", () => {
    const [pda] = marketFeePoolPda(MARKET_ID);
    expect(pda.toBase58()).toBe(
      "FbaCJU5bchEn3JYvEVqJYCp63QXF5jhJFjVW84VAbd8P",
    );
  });
});
