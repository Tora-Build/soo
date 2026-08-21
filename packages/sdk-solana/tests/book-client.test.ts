// The SDK book client, verified against real on-chain bytes.
//
// The decoder mirrors a layout defined in Rust, and a wrong offset does not
// throw — it returns plausible-looking orders at the wrong prices. So every
// assertion here reads an account the program actually wrote, never a fixture
// this file constructed. If `OrderNode` or `BookHeader` changes shape, these
// fail.

import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";

import {
  ONE_SHARE,
  SIDE_ASK,
  SIDE_BID,
  bookLayoutSelfCheck,
  bookPda,
  bookSpace,
  buildBookCancel,
  buildBookGrow,
  buildBookInit,
  buildBookPlace,
  buildBookWithdraw,
  decodeBook,
  ladder,
  seatOf,
} from "../src/book/index.js";
import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import { anchorProgram, enableBook, initMarketFeePool } from "./fixtures/orderbook.js";
import { sendBookTx, trader } from "./fixtures/book.js";

function refs(smoke: SmokeContext) {
  return {
    marketId: smoke.marketId,
    marketPda: smoke.marketPda,
    usdcMint: smoke.usdcMint,
    programs: smoke.programs,
  };
}

async function snapshot(smoke: SmokeContext) {
  const [pda] = bookPda(smoke.marketId, smoke.programs);
  const acct = await smoke.ctx.banksClient.getAccount(pda);
  return decodeBook(Buffer.from(acct!.data));
}

async function boot(capacity = 64): Promise<SmokeContext> {
  const smoke = await bootSmoke();
  await initMarketFeePool(
    smoke.ctx,
    anchorProgram(smoke.ctx, smoke.creator),
    smoke,
    smoke.creator,
  );
  await sendBookTx(
    smoke,
    smoke.creator,
    buildBookInit(refs(smoke), smoke.creator.publicKey, capacity),
  );
  await enableBook(smoke.ctx, smoke);
  return smoke;
}

describe("book client — layout", () => {
  it("self-check passes and the PDA matches the program's", async () => {
    expect(() => bookLayoutSelfCheck()).not.toThrow();
    const smoke = await boot(16);
    // The program created the account at the address the client derives, so
    // the seeds agree. Nothing else in this file would work otherwise.
    const [pda] = bookPda(smoke.marketId, smoke.programs);
    expect(await smoke.ctx.banksClient.getAccount(pda)).not.toBeNull();
  }, 60_000);

  it("bookSpace matches the length the program allocated", async () => {
    const smoke = await boot(32);
    const [pda] = bookPda(smoke.marketId, smoke.programs);
    const acct = await smoke.ctx.banksClient.getAccount(pda);
    expect(acct!.data.length).toBe(bookSpace(32));
    expect(decodeBook(Buffer.from(acct!.data)).capacity).toBe(32);
  }, 60_000);
});

describe("book client — decoding", () => {
  it("decodes an empty book", async () => {
    const smoke = await boot();
    const s = await snapshot(smoke);
    expect(s.market).toBe(smoke.marketPda.toBase58());
    expect(s.orderCount).toBe(0);
    expect(s.bids).toEqual([]);
    expect(s.asks).toEqual([]);
    expect(s.seats).toEqual([]);
  }, 60_000);

  it("reads back the exact order the program wrote", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_ASK,
        limitTick: 437,
        amount: 7n * ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );

    const s = await snapshot(smoke);
    expect(s.orderCount).toBe(1);
    expect(s.asks).toHaveLength(1);
    const o = s.asks[0]!;
    // Every field, because an offset that is wrong by 8 still decodes.
    expect(o.trader).toBe(maker.publicKey.toBase58());
    expect(o.priceTick).toBe(437);
    expect(o.amount).toBe(7n * ONE_SHARE);
    expect(o.side).toBe(SIDE_ASK);
    expect(o.seq).toBe(0n);
  }, 60_000);

  it("returns each side in matching order — best first", async () => {
    const smoke = await boot();
    for (const tick of [500, 300, 400]) {
      const m = await trader(smoke);
      await sendBookTx(
        smoke,
        m,
        buildBookPlace(refs(smoke), m.publicKey, {
          side: SIDE_BID,
          limitTick: tick,
          amount: ONE_SHARE,
          matchLimit: 0,
          postRemainder: true,
        }),
      );
    }
    for (const tick of [700, 900, 800]) {
      const m = await trader(smoke);
      await sendBookTx(
        smoke,
        m,
        buildBookPlace(refs(smoke), m.publicKey, {
          side: SIDE_ASK,
          limitTick: tick,
          amount: ONE_SHARE,
          matchLimit: 0,
          postRemainder: true,
        }),
      );
    }
    const s = await snapshot(smoke);
    expect(s.bids.map((o) => o.priceTick)).toEqual([500, 400, 300]);
    expect(s.asks.map((o) => o.priceTick)).toEqual([700, 800, 900]);
  }, 120_000);

  it("aggregates a ladder and preserves FIFO within a level", async () => {
    const smoke = await boot();
    const seqs: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await trader(smoke);
      await sendBookTx(
        smoke,
        m,
        buildBookPlace(refs(smoke), m.publicKey, {
          side: SIDE_BID,
          limitTick: 500,
          amount: BigInt(i + 1) * ONE_SHARE,
          matchLimit: 0,
          postRemainder: true,
        }),
      );
    }
    const s = await snapshot(smoke);
    for (const o of s.bids) seqs.push(o.seq);
    // Arrival order preserved at equal price.
    expect(seqs).toEqual([...seqs].sort((a, b) => Number(a - b)));
    expect(ladder(s.bids)).toEqual([{ tick: 500, amount: 6n * ONE_SHARE }]);
  }, 120_000);

  it("decodes seats — credit and signed position", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    const taker = await trader(smoke);

    await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_ASK,
        limitTick: 400,
        amount: 10n * ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    await sendBookTx(
      smoke,
      taker,
      buildBookPlace(refs(smoke), taker.publicKey, {
        side: SIDE_BID,
        limitTick: 900,
        amount: 10n * ONE_SHARE,
        matchLimit: 8,
        postRemainder: false,
      }),
    );

    const s = await snapshot(smoke);
    // Mirrored positions: the taker is long YES, the maker long NO.
    expect(seatOf(s, taker.publicKey.toBase58()).net).toBe(10n * ONE_SHARE);
    expect(seatOf(s, maker.publicKey.toBase58()).net).toBe(-10n * ONE_SHARE);
    // A trader who has never touched this market reads as zeroed, not missing.
    const stranger = Keypair.generate().publicKey.toBase58();
    expect(seatOf(s, stranger)).toEqual({ trader: stranger, credit: 0n, net: 0n });
  }, 60_000);

  it("shows cancelled escrow as withdrawable credit", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_ASK,
        limitTick: 400,
        amount: 10n * ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    const seq = (await snapshot(smoke)).asks[0]!.seq;
    await sendBookTx(smoke, maker, buildBookCancel(refs(smoke), maker.publicKey, seq));

    const s = await snapshot(smoke);
    expect(s.orderCount).toBe(0);
    // An ask at 0.40 escrows 0.60/share.
    expect(seatOf(s, maker.publicKey.toBase58()).credit).toBe(6n * ONE_SHARE);

    await sendBookTx(smoke, maker, buildBookWithdraw(refs(smoke), maker.publicKey));
    expect(seatOf(await snapshot(smoke), maker.publicKey.toBase58()).credit).toBe(0n);
  }, 60_000);

  it("tracks capacity growth", async () => {
    const smoke = await boot(16);
    expect((await snapshot(smoke)).capacity).toBe(16);
    await sendBookTx(
      smoke,
      smoke.creator,
      buildBookGrow(refs(smoke), smoke.creator.publicKey, 128),
    );
    expect((await snapshot(smoke)).capacity).toBe(128);
  }, 60_000);
});

describe("book client — argument validation", () => {
  it("rejects out-of-range ticks before they reach the chain", async () => {
    const smoke = await boot();
    const r = refs(smoke);
    const who = smoke.creator.publicKey;
    const args = { side: SIDE_BID, amount: ONE_SHARE, matchLimit: 0, postRemainder: true };
    // 0 is free and 1000 is certain; neither is tradeable, and failing here is
    // cheaper than a reverted transaction.
    expect(() => buildBookPlace(r, who, { ...args, limitTick: 0 })).toThrow();
    expect(() => buildBookPlace(r, who, { ...args, limitTick: 1000 })).toThrow();
    expect(() => buildBookPlace(r, who, { ...args, limitTick: 1 })).not.toThrow();
    expect(() => buildBookPlace(r, who, { ...args, limitTick: 999 })).not.toThrow();
  }, 60_000);

  it("rejects an invalid side", async () => {
    const smoke = await boot();
    expect(() =>
      buildBookPlace(refs(smoke), smoke.creator.publicKey, {
        side: 2,
        limitTick: 500,
        amount: ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    ).toThrow();
  }, 60_000);
});

describe("book client — corrupt input", () => {
  it("refuses a truncated account rather than reading past the end", () => {
    expect(() => decodeBook(Buffer.alloc(64))).toThrow(/too small/);
  }, 10_000);

  it("refuses a list that points past block_count", async () => {
    // This runs in an indexer and a browser, so a corrupt account must be an
    // error rather than an unbounded walk.
    const smoke = await boot();
    const maker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_BID,
        limitTick: 500,
        amount: ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    const [pda] = bookPda(smoke.marketId, smoke.programs);
    const acct = await smoke.ctx.banksClient.getAccount(pda);
    const data = Buffer.from(acct!.data);
    data.writeUInt32LE(9_999, 8 + 44); // bids_head → nonsense
    expect(() => decodeBook(data)).toThrow(/past block_count/);
  }, 60_000);
});

describe("adapter book surface", () => {
  // The demo's chain-shim submits through adapter builders, so these must
  // return the same TradeRequest shape as every other path — otherwise the
  // book needs a special case in the shim, which is exactly the kind of
  // divergence that leaves one code path untested.
  async function adapterFor(smoke: SmokeContext) {
    const { SolanaChainAdapter } = await import("../src/adapter.js");
    const { LiteSvmConnection } = await import("./fixtures/svm.js");
    return new SolanaChainAdapter({
      node: {
        id: "book-adapter",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      bookMint: smoke.usdcMint,
      ammMint: smoke.ammMint,
      connection: new LiteSvmConnection(smoke.ctx),
    });
  }

  it("buildBookPlace returns a submittable TradeRequest", async () => {
    const smoke = await boot();
    const adapter = await adapterFor(smoke);
    const { encodePubkeyRef } = await import("../src/refs.js");
    const req = await adapter.buildBookPlace(
      encodePubkeyRef(smoke.marketPda),
      {
        user: encodePubkeyRef(smoke.creator.publicKey),
        side: SIDE_BID,
        limitTick: 500,
        amount: ONE_SHARE,
        matchLimit: 4,
        postRemainder: true,
      },
    );
    expect(req.kind).toBe("trade");
    expect((req.meta as { operation?: string }).operation).toBe("bookPlace");
    // Flat account list — no per-fill bundles, which is what retires H1.
    expect(req.accounts!.length).toBe(11);
  }, 60_000);

  it("buildBookCancel and buildBookWithdraw round-trip too", async () => {
    const smoke = await boot();
    const adapter = await adapterFor(smoke);
    const { encodePubkeyRef } = await import("../src/refs.js");
    const marketRef = encodePubkeyRef(smoke.marketPda);
    const user = encodePubkeyRef(smoke.creator.publicKey);

    const cancel = await adapter.buildBookCancel(marketRef, { user, orderSeq: 7n });
    expect((cancel.meta as { operation?: string }).operation).toBe("bookCancel");

    const withdraw = await adapter.buildBookWithdraw(marketRef, { user });
    expect((withdraw.meta as { operation?: string }).operation).toBe("bookWithdraw");
  }, 60_000);

  it("readBook decodes the live account in one fetch", async () => {
    // The whole ladder in a single getAccountInfo — the book is one account,
    // not one account per price level.
    const smoke = await boot();
    const adapter = await adapterFor(smoke);
    const { encodePubkeyRef } = await import("../src/refs.js");
    const maker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      buildBookPlace(refs(smoke), maker.publicKey, {
        side: SIDE_ASK,
        limitTick: 620,
        amount: 3n * ONE_SHARE,
        matchLimit: 0,
        postRemainder: true,
      }),
    );
    const snap = await adapter.readBook(encodePubkeyRef(smoke.marketPda));
    expect(snap.asks).toHaveLength(1);
    expect(snap.asks[0]!.priceTick).toBe(620);
  }, 60_000);

  it("readBook fails loudly when the book was never created", async () => {
    const smoke = await bootSmoke();
    const adapter = await adapterFor(smoke);
    const { encodePubkeyRef } = await import("../src/refs.js");
    await expect(
      adapter.readBook(encodePubkeyRef(smoke.marketPda)),
    ).rejects.toThrow(/book account not found/);
  }, 60_000);
});
