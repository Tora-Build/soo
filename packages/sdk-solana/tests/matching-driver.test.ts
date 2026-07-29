import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  submitOrderbookBuyMultiTx,
  simulateMatch,
  FILL_BUNDLE_LEN,
  type BookSideSnapshot,
  type MarketBookSnapshot,
  type SoothSolanaClient,
} from "../src/orderbook/matching-driver.js";
import {
  SOOTH_CORE_PROGRAM_ID,
} from "../src/pdas.js";

const MARKET_ID = new Uint8Array([
  0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x01, 0x23, 0x45, 0x67, 0x89,
  0xab, 0xcd, 0xef,
]);
const MARKET = "sol:7J6eKSPiYyxsvvCzUL2gG8DDZ9yZ1FiU2z1yvK6ykvFe";
const USDC_MINT = new PublicKey("8B4qNf3sTsF9eUE7VyZq2vXwFM6Gp6SmSGbkqdtE1uJH");

function maker(n: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(n));
}

function bitmap(...ticks: number[]): [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] {
  const words = Array.from({ length: 16 }, () => 0n) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  for (const tick of ticks) {
    const word = tick >> 6;
    const bit = tick & 63;
    words[word] |= 1n << BigInt(bit);
  }
  return words;
}

function sideWithOrders(
  tick: number,
  amounts: bigint[],
  offset = 1,
): BookSideSnapshot {
  return {
    side: 0,
    tick,
    headIndex: 0,
    orders: amounts.map((amount, i) => ({
      id: (BigInt(tick) << 40n) | BigInt(i + offset),
      maker: maker(tick + i + offset),
      amount,
      escrow: false,
    })),
  };
}

function mockClient(args: {
  marketBook: () => MarketBookSnapshot;
  bookSides: Record<number, BookSideSnapshot | undefined>;
}): SoothSolanaClient {
  return {
    programIds: {
      soothCore: SOOTH_CORE_PROGRAM_ID,
    },
    usdcMint: USDC_MINT,
    resolveOrderbookMarket: async () => ({
      marketPda: new PublicKey(MARKET.replace(/^sol:/, "")),
      marketId: MARKET_ID,
    }),
    fetchMarketBook: async () => args.marketBook(),
    fetchBookSide: async (_market, _side, tick) => args.bookSides[tick] ?? null,
    buildOrderbookBuyTx: async (_market, _taker, bundles) => [
      new TransactionInstruction({
        programId: SOOTH_CORE_PROGRAM_ID,
        keys: bundles,
        data: Buffer.from([bundles.length]),
      }),
    ],
  };
}

describe("matching driver", () => {
  it("simulate_match_walks_bitmap_in_correct_order", async () => {
    const client = mockClient({
      marketBook: () => ({
        bitmapFor: bitmap(),
        bitmapAgainst: bitmap(100, 500, 800),
      }),
      bookSides: {
        100: sideWithOrders(100, [10n]),
        500: sideWithOrders(500, [10n]),
        800: sideWithOrders(800, [10n]),
      },
    });

    const sim = await simulateMatch(client, MARKET, {
      side: 1,
      tick: 1000,
      amount: 30n,
      escrow: false,
    });

    expect(sim.predictedFills.map((f) => f.makerTick)).toEqual([800, 500, 100]);
  });

  it("simulate_match_respects_min_opp_tick_boundary", async () => {
    const client = mockClient({
      marketBook: () => ({
        bitmapFor: bitmap(),
        bitmapAgainst: bitmap(200, 500, 800),
      }),
      bookSides: {
        200: sideWithOrders(200, [10n]),
        500: sideWithOrders(500, [10n]),
        800: sideWithOrders(800, [10n]),
      },
    });

    const sim = await simulateMatch(client, MARKET, {
      side: 1,
      tick: 600,
      amount: 30n,
      escrow: false,
    });

    expect(sim.predictedFills.map((f) => f.makerTick)).toEqual([800, 500]);
  });

  it("submit_multi_tx_splits_at_match_limit_per_tx", async () => {
    const client = mockClient({
      marketBook: () => ({
        bitmapFor: bitmap(),
        bitmapAgainst: bitmap(900),
      }),
      bookSides: { 900: sideWithOrders(900, Array(7).fill(1n)) },
    });

    const submitted: TransactionInstruction[][] = [];
    const { batchesSubmitted } = await submitOrderbookBuyMultiTx(
      client,
      MARKET,
      {
        side: 1,
        tick: 1000,
        amount: 7n,
        escrow: false,
        matchLimitPerTx: 3,
      },
      async (ixs) => {
        submitted.push(ixs);
      },
    );

    expect(batchesSubmitted).toBe(3);
    expect(submitted.map((tx) => tx[0].keys.length / FILL_BUNDLE_LEN)).toEqual([
      3, 3, 1,
    ]);
    // Arity must divide exactly, or the program rejects with WrongBundleArity.
    for (const tx of submitted) {
      expect(tx[0].keys.length % FILL_BUNDLE_LEN).toBe(0);
    }
  });

  it("submit_multi_tx_zero_fills_for_no_cross_order", async () => {
    const client = mockClient({
      marketBook: () => ({
        bitmapFor: bitmap(),
        bitmapAgainst: bitmap(),
      }),
      bookSides: {},
    });

    const sim = await simulateMatch(client, MARKET, {
      side: 1,
      tick: 1000,
      amount: 7n,
      escrow: false,
    });
    const submitted: TransactionInstruction[][] = [];
    const { batchesSubmitted } = await submitOrderbookBuyMultiTx(
      client,
      MARKET,
      {
        side: 1,
        tick: 1000,
        amount: 7n,
        escrow: false,
        matchLimitPerTx: 3,
      },
      async (ixs) => {
        submitted.push(ixs);
      },
    );

    expect(sim.bundlesNeeded).toBe(0);
    expect(batchesSubmitted).toBe(0);
    expect(submitted).toEqual([]);
  });

  it("submit_multi_tx_re_reads_bitmap_between_txs", async () => {
    let reads = 0;
    const client = mockClient({
      marketBook: () => {
        reads += 1;
        return {
          bitmapFor: bitmap(),
          bitmapAgainst: reads === 1 ? bitmap(900) : bitmap(700),
        };
      },
      bookSides: {
        900: sideWithOrders(900, [1n, 1n, 1n]),
        700: sideWithOrders(700, [1n], 10),
      },
    });

    const txs: TransactionInstruction[][] = [];
    await submitOrderbookBuyMultiTx(
      client,
      MARKET,
      {
        side: 1,
        tick: 1000,
        amount: 4n,
        escrow: false,
        matchLimitPerTx: 3,
      },
      async (ixs) => {
        txs.push(ixs);
      },
    );

    expect(txs).toHaveLength(2);
    expect(txs[0]![0]!.keys[0]!.pubkey.equals(txs[1]![0]!.keys[0]!.pubkey)).toBe(
      false,
    );
    expect(reads).toBe(2);
    // Second tx carries exactly one fill bundle, rebuilt from the re-read bitmap.
    expect(txs[1]![0]!.keys).toHaveLength(FILL_BUNDLE_LEN);
  });

  // H1 regression (audit W9). The bug was that every batch was planned before
  // anything was submitted, so BookSide.head_index never advanced and each
  // batch selected the same makers — batch 2+ then died on-chain with
  // MakerAccountMismatch. Ordering, not just output, is the contract here:
  // each read must be preceded by every earlier batch's submit.
  it("submit_multi_tx_calls_submit_before_re_reading_state_h1_regression", async () => {
    const events: string[] = [];
    const client = mockClient({
      marketBook: () => {
        events.push("read");
        return { bitmapFor: bitmap(), bitmapAgainst: bitmap(900) };
      },
      bookSides: { 900: sideWithOrders(900, Array(7).fill(1n)) },
    });

    const { batchesSubmitted } = await submitOrderbookBuyMultiTx(
      client,
      MARKET,
      {
        side: 1,
        tick: 1000,
        amount: 7n,
        escrow: false,
        matchLimitPerTx: 3,
      },
      async () => {
        events.push("submit");
      },
    );

    expect(batchesSubmitted).toBe(3);
    // Strict alternation. A prebuild-then-submit implementation produces
    // read,read,read,submit,submit,submit and fails here.
    expect(events).toEqual([
      "read",
      "submit",
      "read",
      "submit",
      "read",
      "submit",
    ]);
  });
});
