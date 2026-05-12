import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { makeConnection } from "../helpers/onchain";
import { loadFixture, marketIdBytes } from "../helpers/fixture";
import {
  createSeededOrderbookMarketViaAdapter,
  deriveAmmStatePda as deriveAmmStatePdaHelper,
  deriveLpMintPda as deriveLpMintPdaHelper,
  forceAmmGraduatedViaSurfpool,
  initMarketFeePoolViaAdapter,
  loadCreatorKeypair,
  loadTestKeypair,
  makeSolanaAdapter,
  type FreshMarketSetup,
} from "../helpers/sdk-helpers";

test.describe("orderbook UI-click round-trip (W7 BookSide)", () => {
  test("fill trade form + submit → BookSide receives resting order", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const purchaser = loadTestKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);
    const fixtureMarketPda = new PublicKey(fixture.marketPda);
    const fixtureMarketId = marketIdBytes(fixture);
    const stubExistingMarket: FreshMarketSetup = {
      marketId: fixtureMarketId,
      marketPda: fixtureMarketPda,
      ammStatePda: deriveAmmStatePdaHelper(fixtureMarketId),
      lpMint: deriveLpMintPdaHelper(fixtureMarketId),
      creatorLpAta: getAssociatedTokenAddressSync(
        deriveLpMintPdaHelper(fixtureMarketId),
        creator.publicKey,
      ),
    };

    const ob = await createSeededOrderbookMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      existingSoothMarket: stubExistingMarket,
    });
    await forceAmmGraduatedViaSurfpool({ conn, marketId: ob.marketId });
    await initMarketFeePoolViaAdapter({
      conn,
      signer: creator,
      usdcMint,
      marketPda: ob.soothMarketPda,
      marketId: ob.marketId,
    });

    await page.goto(`/orderbook/${ob.soothMarketPda.toBase58()}`);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet) {
        throw new Error("_connectTestWallet not exposed");
      }
      await w._connectTestWallet();
    });

    const submitBtn = page.getByTestId("ob-submit-button");
    await expect(submitBtn).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("ob-outcome-yes").click();
    await page.getByTestId("ob-side-buy").click();
    await page.getByTestId("ob-price-input").fill("40");
    await page.getByTestId("ob-shares-input").fill("5");
    await expect(submitBtn).toBeEnabled({ timeout: 30_000 });
    await submitBtn.click();

    const adapter = makeSolanaAdapter({ conn, usdcMint });
    await expect
      .poll(async () => {
        const bookSide = await adapter.fetchBookSide(
          `sol:${ob.soothMarketPda.toBase58()}`,
          1,
          400,
        );
        return (
          bookSide?.orders.filter(
            (o) => o.amount > 0n && o.maker.equals(purchaser.publicKey),
          ).length ?? 0
        );
      }, { timeout: 60_000 })
      .toBeGreaterThan(0);

    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
  });
});
