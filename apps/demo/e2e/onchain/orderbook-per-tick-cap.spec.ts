import { test, expect } from "@playwright/test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { classifyOrderbookError } from "@sooth/sdk-solana";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  createSeededOrderbookMarketViaAdapter,
  forceAmmGraduatedViaSurfpool,
  fundOrderbookTrader,
  initMarketFeePoolViaAdapter,
  loadCreatorKeypair,
  loadMintAuthorityKeypair,
  makeSolanaAdapter,
  placeOrderbookBuyViaAdapter,
} from "../helpers/sdk-helpers";

const WAD = 10n ** 18n;
const SIDE_YES = 1;

test.describe("orderbook per-tick cap (W8)", () => {
  test("50 makers can rest at one level and the 51st is rejected clearly", async () => {
    test.setTimeout(360_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const mintAuthority = loadMintAuthorityKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);

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

    const tick = 400;
    for (let i = 0; i < 50; i += 1) {
      const maker = Keypair.generate();
      await fundOrderbookTrader({
        conn,
        trader: maker,
        mintAuthority,
        usdcMint,
      });
      await placeOrderbookBuyViaAdapter({
        conn,
        signer: maker,
        usdcMint,
        marketPda: ob.soothMarketPda,
        side: SIDE_YES,
        tick,
        amount: WAD,
      });
    }

    const adapter = makeSolanaAdapter({ conn, usdcMint });
    const marketRef = `sol:${ob.soothMarketPda.toBase58()}`;
    const fullSide = await adapter.fetchBookSide(marketRef, SIDE_YES, tick);
    expect(fullSide?.orders.filter((order) => order.amount > 0n)).toHaveLength(
      50,
    );

    const overflowMaker = Keypair.generate();
    await fundOrderbookTrader({
      conn,
      trader: overflowMaker,
      mintAuthority,
      usdcMint,
    });
    let thrown: unknown;
    try {
      await placeOrderbookBuyViaAdapter({
        conn,
        signer: overflowMaker,
        usdcMint,
        marketPda: ob.soothMarketPda,
        side: SIDE_YES,
        tick,
        amount: WAD,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    const classified = classifyOrderbookError(thrown);
    expect(classified.code).toBe("BookSideFull");
    expect(classified.retriable).toBe(false);
    expect(classified.message).toContain("50 orders max");
  });
});
