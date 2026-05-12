import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  createSeededMarketViaAdapter,
  createSeededOrderbookMarketViaAdapter,
  forceAmmGraduatedViaSurfpool,
  initMarketFeePoolViaAdapter,
  loadCreatorKeypair,
  loadTestKeypair,
  makeSolanaAdapter,
  placeOrderbookBuyViaAdapter,
} from "../helpers/sdk-helpers";

const WAD = 10n ** 18n;

test.describe("dynamic create → graduate → orderbook trade", () => {
  test("fresh market graduates and accepts a W7 orderbook buy", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const purchaser = loadTestKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);

    const fresh = await createSeededMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      question: `W7 orderbook ${Date.now()}`,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
    });
    await forceAmmGraduatedViaSurfpool({ conn, marketId: fresh.marketId });
    const ob = await createSeededOrderbookMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      existingSoothMarket: fresh,
    });
    await initMarketFeePoolViaAdapter({
      conn,
      signer: creator,
      usdcMint,
      marketPda: ob.soothMarketPda,
      marketId: ob.marketId,
    });

    await page.goto(`/orderbook/${ob.soothMarketPda.toBase58()}`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("ob-submit-button")).toBeVisible({
      timeout: 30_000,
    });

    const side = 1;
    const tick = 420;
    await placeOrderbookBuyViaAdapter({
      conn,
      signer: purchaser,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side,
      tick,
      amount: 2n * WAD,
    });

    const adapter = makeSolanaAdapter({ conn, usdcMint });
    await expect
      .poll(async () => {
        const bookSide = await adapter.fetchBookSide(
          `sol:${ob.soothMarketPda.toBase58()}`,
          side,
          tick,
        );
        return (
          bookSide?.orders.filter(
            (o) => o.amount > 0n && o.maker.equals(purchaser.publicKey),
          ).length ?? 0
        );
      }, { timeout: 30_000 })
      .toBeGreaterThan(0);
  });
});
