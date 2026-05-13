import { test, expect } from "@playwright/test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { classifyOrderbookError } from "@sooth/sdk-solana";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  buildOrderbookFillBundle,
  createSeededOrderbookMarketViaAdapter,
  fetchOrderbookPosition,
  forceAmmGraduatedViaSurfpool,
  fundOrderbookTrader,
  initMarketFeePoolViaAdapter,
  loadCreatorKeypair,
  loadMintAuthorityKeypair,
  loadTestKeypair,
  makeSolanaAdapter,
  placeOrderbookBuyViaAdapter,
  sendOrderbookBuyWithRemainingAccounts,
} from "../helpers/sdk-helpers";

const WAD = 10n ** 18n;
const SIDE_NO = 0;
const SIDE_YES = 1;

test.describe("orderbook stale bundle errors (W8)", () => {
  test("wrong crossing BookSide classifies as retriable and fresh matching succeeds", async () => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const mintAuthority = loadMintAuthorityKeypair();
    const maker = Keypair.generate();
    const taker = loadTestKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);

    await fundOrderbookTrader({
      conn,
      trader: maker,
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

    await placeOrderbookBuyViaAdapter({
      conn,
      signer: maker,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side: SIDE_NO,
      tick: 300,
      amount: WAD,
    });

    let thrown: unknown;
    try {
      await sendOrderbookBuyWithRemainingAccounts({
        conn,
        signer: taker,
        usdcMint,
        marketPda: ob.soothMarketPda,
        side: SIDE_YES,
        tick: 700,
        amount: WAD,
        remainingAccounts: buildOrderbookFillBundle({
          marketId: ob.marketId,
          usdcMint,
          maker: maker.publicKey,
          makerSide: SIDE_NO,
          makerTick: 200,
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    const classified = classifyOrderbookError(thrown);
    expect(classified.code).toBe("MissingCrossingBookSide");
    expect(classified.retriable).toBe(true);

    await placeOrderbookBuyViaAdapter({
      conn,
      signer: taker,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side: SIDE_YES,
      tick: 700,
      amount: WAD,
    });

    const takerPosition = await fetchOrderbookPosition({
      conn,
      marketId: ob.marketId,
      user: taker.publicKey,
    });
    expect(takerPosition.yesShares).toBe(WAD);

    const adapter = makeSolanaAdapter({ conn, usdcMint });
    const side = await adapter.fetchBookSide(
      `sol:${ob.soothMarketPda.toBase58()}`,
      SIDE_NO,
      300,
    );
    expect(side?.orders[0]?.amount).toBe(0n);
  });
});
