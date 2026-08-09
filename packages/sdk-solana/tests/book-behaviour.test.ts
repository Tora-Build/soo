// Behavioural suite for the redesigned orderbook, on-chain.
//
// The arena, settlement and matcher each have Rust unit tests, but those run
// against in-memory structs. This file drives the real instructions against a
// real account through LiteSVM, so it covers the things unit tests structurally
// cannot: PDA derivation, the zero-copy cast against genuine account data,
// realloc growth, token movement, and signer checks.
//
// It is the new-architecture counterpart to orderbook-crossing-buy,
// orderbook-multi-fill, orderbook-self-cross and orderbook-place-cancel. Those
// still cover the live book and stay until it is deleted.

import { describe, expect, it } from "vitest";

import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import {
  anchorProgram,
  enableBook,
  initMarketFeePool,
  setPaused,
} from "./fixtures/orderbook.js";
import {
  ONE_SHARE,
  SIDE_ASK,
  SIDE_BID,
  bookCancelIx,
  bookGrowIx,
  bookHeader,
  bookInitIx,
  bookPda,
  bookPlaceIx,
  bookWithdrawIx,
  sendBookTx,
  trader,
  usdcOf,
} from "./fixtures/book.js";

/** Boot a market with an initialised book of `capacity` blocks. */
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
    bookInitIx(smoke, smoke.creator.publicKey, capacity),
  );
  await enableBook(smoke.ctx, smoke);
  return smoke;
}

describe("book_init / book_grow", () => {
  it("creates the book at its PDA with the right capacity", async () => {
    const smoke = await boot(32);
    const h = await bookHeader(smoke);
    expect(h.orderCount).toBe(0);
    expect(h.blockCount).toBe(0);
    expect(h.bidsHead).toBe(0xffffffff);
    expect(h.asksHead).toBe(0xffffffff);
    // 8 disc + 128 header + 32 * 64 blocks
    expect(h.len).toBe(8 + 128 + 32 * 64);
  }, 60_000);

  it("refuses an initial capacity beyond the per-instruction realloc cap", async () => {
    // Solana caps a single realloc at 10,240 bytes, so the 256-order maximum
    // cannot be allocated in one call — it has to be grown.
    const smoke = await bootSmoke();
    await expect(
      sendBookTx(smoke, smoke.creator, bookInitIx(smoke, smoke.creator.publicKey, 256)),
    ).rejects.toThrow();
  }, 60_000);

  it("grows toward the cap one realloc step at a time", async () => {
    const smoke = await boot(16);
    const before = (await bookHeader(smoke)).len;

    await sendBookTx(smoke, smoke.creator, bookGrowIx(smoke, smoke.creator.publicKey, 256));
    const mid = (await bookHeader(smoke)).len;
    expect(mid).toBeGreaterThan(before);
    expect(mid - before).toBeLessThanOrEqual(10_240);

    await sendBookTx(smoke, smoke.creator, bookGrowIx(smoke, smoke.creator.publicKey, 256));
    const full = (await bookHeader(smoke)).len;
    expect(full).toBe(8 + 128 + 256 * 64);
  }, 60_000);

  it("growing an already-large-enough book is a no-op, not a failure", async () => {
    // A client that over-asks should cost nothing, not blow up a transaction
    // that also carries a trade.
    const smoke = await boot(64);
    const before = (await bookHeader(smoke)).len;
    await sendBookTx(smoke, smoke.creator, bookGrowIx(smoke, smoke.creator.publicKey, 8));
    expect((await bookHeader(smoke)).len).toBe(before);
  }, 60_000);
});

describe("book_place — resting and crossing", () => {
  it("rests an order and escrows the maker's leg", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    const before = await usdcOf(smoke, maker.publicKey);

    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, 10n * ONE_SHARE, 0, true),
    );

    const h = await bookHeader(smoke);
    expect(h.orderCount).toBe(1);
    // An ask at 0.40 is "buy NO at 0.60", so the escrow is 0.60 * 10 = 6 USDC.
    expect(before - (await usdcOf(smoke, maker.publicKey))).toBe(6n * ONE_SHARE);
  }, 60_000);

  it("a taker fills at the maker's price and keeps the difference", async () => {
    // The "excess goes to whoever fills" rule, end to end. The maker rests an
    // ask at 0.40; the taker is willing to pay 0.90 and must pay 0.40.
    const smoke = await boot();
    const maker = await trader(smoke);
    const taker = await trader(smoke);

    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, 10n * ONE_SHARE, 0, true),
    );

    const before = await usdcOf(smoke, taker.publicKey);
    await sendBookTx(
      smoke,
      taker,
      bookPlaceIx(smoke, taker.publicKey, SIDE_BID, 900, 10n * ONE_SHARE, 8, false),
    );
    const paid = before - (await usdcOf(smoke, taker.publicKey));

    // 0.40 * 10 = 4 USDC, plus 1% of min(0.40, 0.60) * 10 = 0.04 USDC fee.
    expect(paid).toBe(4n * ONE_SHARE + 40_000n);
    expect((await bookHeader(smoke)).orderCount).toBe(0);
  }, 60_000);

  it("the maker's escrow plus the taker's payment fund exactly one per share", async () => {
    // The solvency invariant, observed at the vault rather than in the
    // arithmetic: a complete set is worth 1.00 and must be fully backed.
    const smoke = await boot();
    const maker = await trader(smoke);
    const taker = await trader(smoke);
    const vaultOf = async () => {
      const { deriveMarketVaultAta } = await import("../src/pdas.js");
      const ata = deriveMarketVaultAta(smoke.marketId, smoke.usdcMint, smoke.programs);
      const acct = await smoke.ctx.banksClient.getAccount(ata);
      const { AccountLayout } = await import("@solana/spl-token");
      return AccountLayout.decode(Buffer.from(acct!.data)).amount;
    };

    const v0 = await vaultOf();
    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, 10n * ONE_SHARE, 0, true),
    );
    await sendBookTx(
      smoke,
      taker,
      bookPlaceIx(smoke, taker.publicKey, SIDE_BID, 900, 10n * ONE_SHARE, 8, false),
    );
    const v1 = await vaultOf();

    // 10 shares of open interest ⇒ exactly 10 USDC backing, and the 0.04 fee
    // has already left for the fee pool.
    expect(v1 - v0).toBe(10n * ONE_SHARE);
  }, 60_000);

  it("crosses several makers in one transaction, best price first", async () => {
    const smoke = await boot();
    const makers = [];
    for (let i = 0; i < 4; i++) {
      const m = await trader(smoke);
      makers.push(m);
      await sendBookTx(
        smoke,
        m,
        bookPlaceIx(smoke, m.publicKey, SIDE_ASK, 400 + i * 10, ONE_SHARE, 0, true),
      );
    }
    const taker = await trader(smoke);
    const before = await usdcOf(smoke, taker.publicKey);
    await sendBookTx(
      smoke,
      taker,
      bookPlaceIx(smoke, taker.publicKey, SIDE_BID, 900, 4n * ONE_SHARE, 8, false),
    );

    expect((await bookHeader(smoke)).orderCount).toBe(0);
    // 0.40 + 0.41 + 0.42 + 0.43 = 1.66 USDC of collateral, plus fees.
    const paid = before - (await usdcOf(smoke, taker.publicKey));
    expect(paid).toBeGreaterThan(1_660_000n);
    expect(paid).toBeLessThan(1_700_000n);
  }, 120_000);

  it("match_limit caps the walk and the remainder rests", async () => {
    const smoke = await boot();
    for (let i = 0; i < 4; i++) {
      const m = await trader(smoke);
      await sendBookTx(
        smoke,
        m,
        bookPlaceIx(smoke, m.publicKey, SIDE_ASK, 500, ONE_SHARE, 0, true),
      );
    }
    const taker = await trader(smoke);
    await sendBookTx(
      smoke,
      taker,
      bookPlaceIx(smoke, taker.publicKey, SIDE_BID, 500, 4n * ONE_SHARE, 2, true),
    );
    // 2 asks consumed, 2 left, plus the taker's own resting remainder.
    expect((await bookHeader(smoke)).orderCount).toBe(3);
  }, 120_000);

  it("cancels the trader's own resting order and places the new one", async () => {
    // A seat cannot trade against itself — it holds one signed net, so the two
    // legs would cancel to zero after a full unit had been paid. Something has
    // to give, and the choice matters to whoever is trading:
    //
    //   - resting the incoming order leaves the book CROSSED against its own
    //     owner, free for anyone to lift both legs;
    //   - dropping the incoming order means a trader who quoted one side
    //     cannot then quote the other, and their order silently never appears.
    //
    // Cancelling the RESTING order is neither. It is exact — the order had
    // escrow and no fill, so the refund returns what it cost — and the trader
    // ends holding the order they just placed.
    const smoke = await boot();
    const solo = await trader(smoke);
    await sendBookTx(
      smoke,
      solo,
      bookPlaceIx(smoke, solo.publicKey, SIDE_ASK, 400, ONE_SHARE, 0, true),
    );
    await sendBookTx(
      smoke,
      solo,
      bookPlaceIx(smoke, solo.publicKey, SIDE_BID, 900, ONE_SHARE, 8, true),
    );

    // One order, and it is the new one.
    const h = await bookHeader(smoke);
    expect(h.orderCount).toBe(1);
    expect(h.asksHead, "the crossed ask was cancelled").toBe(0xffffffff);
    expect(h.bidsHead, "the new bid rests").not.toBe(0xffffffff);
  }, 60_000);

  it("is blocked while the protocol is paused", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    await setPaused(
      smoke.ctx,
      anchorProgram(smoke.ctx, smoke.creator),
      smoke,
      smoke.creator,
      true,
    );
    await expect(
      sendBookTx(
        smoke,
        maker,
        bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, ONE_SHARE, 0, true),
      ),
    ).rejects.toThrow();
  }, 60_000);
});

describe("book_cancel / book_withdraw", () => {
  it("cancel refunds escrow to seat credit, and withdraw pays it out", async () => {
    // The two-step exit the seat model implies: a fill or cancel never moves
    // tokens, which is what keeps a fill free of per-fill CPI.
    const smoke = await boot();
    const maker = await trader(smoke);
    const start = await usdcOf(smoke, maker.publicKey);

    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, 10n * ONE_SHARE, 0, true),
    );
    const afterPlace = await usdcOf(smoke, maker.publicKey);
    expect(start - afterPlace).toBe(6n * ONE_SHARE);

    // seq 0 — the first order this book ever issued.
    await sendBookTx(smoke, maker, bookCancelIx(smoke, maker.publicKey, 0n));
    expect((await bookHeader(smoke)).orderCount).toBe(0);
    // Cancel alone moves nothing: the refund is credit, not cash.
    expect(await usdcOf(smoke, maker.publicKey)).toBe(afterPlace);

    await sendBookTx(smoke, maker, bookWithdrawIx(smoke, maker.publicKey));
    expect(await usdcOf(smoke, maker.publicKey)).toBe(start);
  }, 60_000);

  it("cannot cancel someone else's order", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    const thief = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, ONE_SHARE, 0, true),
    );
    await expect(
      sendBookTx(smoke, thief, bookCancelIx(smoke, thief.publicKey, 0n)),
    ).rejects.toThrow();
    expect((await bookHeader(smoke)).orderCount).toBe(1);
  }, 60_000);

  it("cancelling a partially filled order refunds only the remainder", async () => {
    // Escrow is recomputed from what is LEFT on the node, so a partial fill
    // cannot refund the original amount.
    const smoke = await boot();
    const maker = await trader(smoke);
    const taker = await trader(smoke);

    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, 10n * ONE_SHARE, 0, true),
    );
    await sendBookTx(
      smoke,
      taker,
      bookPlaceIx(smoke, taker.publicKey, SIDE_BID, 900, 4n * ONE_SHARE, 8, false),
    );

    const before = await usdcOf(smoke, maker.publicKey);
    await sendBookTx(smoke, maker, bookCancelIx(smoke, maker.publicKey, 0n));
    await sendBookTx(smoke, maker, bookWithdrawIx(smoke, maker.publicKey));
    const refunded = (await usdcOf(smoke, maker.publicKey)) - before;

    // 6 shares left at 0.60 = 3.6 USDC. The 4 filled shares are a position now,
    // not escrow.
    expect(refunded).toBe(3_600_000n);
  }, 60_000);

  it("withdrawing twice pays nothing the second time", async () => {
    const smoke = await boot();
    const maker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, ONE_SHARE, 0, true),
    );
    await sendBookTx(smoke, maker, bookCancelIx(smoke, maker.publicKey, 0n));
    await sendBookTx(smoke, maker, bookWithdrawIx(smoke, maker.publicKey));
    const after = await usdcOf(smoke, maker.publicKey);
    await sendBookTx(smoke, maker, bookWithdrawIx(smoke, maker.publicKey));
    expect(await usdcOf(smoke, maker.publicKey)).toBe(after);
  }, 60_000);
});
