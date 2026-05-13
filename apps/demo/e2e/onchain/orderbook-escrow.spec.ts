import { test, expect } from "@playwright/test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  buildOrderbookFillBundle,
  createSeededOrderbookMarketViaAdapter,
  deriveMarketFeePoolPda,
  fetchOrderbookPosition,
  forceAmmGraduatedViaSurfpool,
  fundOrderbookTrader,
  getTokenAccountAmount,
  initMarketFeePoolViaAdapter,
  loadCreatorKeypair,
  loadMintAuthorityKeypair,
  loadTestKeypair,
  makeSolanaAdapter,
  mintOrderbookCompleteSetViaAdapter,
  placeOrderbookBuyViaAdapter,
  sendOrderbookBuyWithRemainingAccounts,
} from "../helpers/sdk-helpers";

const WAD = 10n ** 18n;
const BASE_UNIT_WAD = 1_000_000_000_000n;
const SIDE_NO = 0;
const SIDE_YES = 1;

function expectedFeeBase(shares: bigint, takerTick: number, feeBps: bigint): bigint {
  const baseCostWad = (shares * BigInt(takerTick)) / 1000n;
  const feeWad = (baseCostWad * feeBps) / 10_000n;
  return (baseCostWad + feeWad) / BASE_UNIT_WAD - baseCostWad / BASE_UNIT_WAD;
}

function wadToBase(wad: bigint): bigint {
  return wad / BASE_UNIT_WAD;
}

function bitmapHasTick(words: readonly (bigint | number)[], tick: number): boolean {
  const word = BigInt(words[Math.floor(tick / 64)] ?? 0);
  return ((word >> BigInt(tick % 64)) & 1n) === 1n;
}

test.describe("orderbook escrow fill (W8)", () => {
  test("escrow maker stays share-debited, receives USDC payout, and taker receives NO", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const mintAuthority = loadMintAuthorityKeypair();
    const maker = loadTestKeypair();
    const taker = Keypair.generate();
    const usdcMint = new PublicKey(fixture.usdcMint);

    await fundOrderbookTrader({
      conn,
      trader: taker,
      mintAuthority,
      usdcMint,
    });

    const ob = await createSeededOrderbookMarketViaAdapter({
      conn,
      creator,
      usdcMint,
    });
    await forceAmmGraduatedViaSurfpool({ conn, marketId: ob.marketId });
    await initMarketFeePoolViaAdapter({
      conn,
      signer: creator,
      usdcMint,
      marketPda: ob.soothMarketPda,
      marketId: ob.marketId,
    });

    const amount = 10n * WAD;
    const makerTick = 300;
    const takerTick = 700;
    await mintOrderbookCompleteSetViaAdapter({
      conn,
      signer: maker,
      usdcMint,
      marketPda: ob.soothMarketPda,
      amount: 10_000_000n,
    });

    const makerAfterMint = await fetchOrderbookPosition({
      conn,
      marketId: ob.marketId,
      user: maker.publicKey,
    });
    expect(makerAfterMint.yesShares).toBe(amount);
    expect(makerAfterMint.noShares).toBe(amount);

    await placeOrderbookBuyViaAdapter({
      conn,
      signer: maker,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side: SIDE_YES,
      tick: makerTick,
      amount,
      escrow: true,
    });

    const makerAfterRest = await fetchOrderbookPosition({
      conn,
      marketId: ob.marketId,
      user: maker.publicKey,
    });
    expect(makerAfterRest.yesShares).toBe(makerAfterMint.yesShares);
    expect(makerAfterRest.noShares).toBe(makerAfterMint.noShares - amount);

    const adapter = makeSolanaAdapter({ conn, usdcMint });
    const marketRef = `sol:${ob.soothMarketPda.toBase58()}`;
    const rested = await adapter.fetchBookSide(marketRef, SIDE_YES, makerTick);
    expect(
      rested?.orders.some(
        (order) =>
          order.maker.equals(maker.publicKey) &&
          order.amount === amount &&
          order.escrow,
      ),
    ).toBe(true);

    await page.goto(`/portfolio?market=${ob.soothMarketPda.toBase58()}`);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet) throw new Error("_connectTestWallet not exposed");
      await w._connectTestWallet();
    });
    await expect(page.getByTestId("portfolio-order-escrow")).toBeVisible({
      timeout: 30_000,
    });

    const makerUsdcAta = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);
    const makerUsdcBefore = await getTokenAccountAmount(conn, makerUsdcAta);
    const feePool = deriveMarketFeePoolPda(ob.marketId);
    const feePoolBefore = await getTokenAccountAmount(conn, feePool);

    await sendOrderbookBuyWithRemainingAccounts({
      conn,
      signer: taker,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side: SIDE_NO,
      tick: takerTick,
      amount,
      remainingAccounts: buildOrderbookFillBundle({
        marketId: ob.marketId,
        usdcMint,
        maker: maker.publicKey,
        makerSide: SIDE_YES,
        makerTick,
      }),
    });

    const makerAfterCross = await fetchOrderbookPosition({
      conn,
      marketId: ob.marketId,
      user: maker.publicKey,
    });
    expect(makerAfterCross.noShares).toBe(makerAfterRest.noShares);
    expect(makerAfterCross.yesShares).toBe(makerAfterRest.yesShares);

    const makerPayout = wadToBase(((1000n - BigInt(makerTick)) * amount) / 1000n);
    await expect
      .poll(async () => getTokenAccountAmount(conn, makerUsdcAta), {
        timeout: 30_000,
      })
      .toBe(makerUsdcBefore + makerPayout);

    const takerAfterCross = await fetchOrderbookPosition({
      conn,
      marketId: ob.marketId,
      user: taker.publicKey,
    });
    expect(takerAfterCross.noShares).toBe(amount);
    expect(takerAfterCross.yesShares).toBe(0n);

    await expect
      .poll(async () => getTokenAccountAmount(conn, feePool), {
        timeout: 30_000,
      })
      .toBe(feePoolBefore + expectedFeeBase(amount, takerTick, 100n));

    const filledSide = await adapter.fetchBookSide(marketRef, SIDE_YES, makerTick);
    expect(filledSide?.orders[0]?.amount).toBe(0n);
    const book = await adapter.fetchMarketBook(marketRef);
    expect(book).not.toBeNull();
    expect(bitmapHasTick(book!.bitmapFor, makerTick)).toBe(false);
  });
});
