import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  cancelOrderbookViaAdapter,
  createSeededOrderbookMarketViaAdapter,
  forceAmmGraduatedViaSurfpool,
  initMarketFeePoolViaAdapter,
  loadCreatorKeypair,
  loadTestKeypair,
  makeSolanaAdapter,
  placeOrderbookBuyViaAdapter,
} from "../helpers/sdk-helpers";

const WAD = 10n ** 18n;

test.describe("orderbook roundtrip (W7 BookSide)", () => {
  test("place resting buy → page loads → cancel_by_id clears order", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const purchaser = loadTestKeypair();
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

    const side = 1;
    const tick = 400;
    const amount = 5n * WAD;
    const txId = await placeOrderbookBuyViaAdapter({
      conn,
      signer: purchaser,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side,
      tick,
      amount,
    });
    expect(txId).toMatch(/^sol:[1-9A-HJ-NP-Za-km-z]{40,}$/);

    const adapter = makeSolanaAdapter({ conn, usdcMint });
    const marketRef = `sol:${ob.soothMarketPda.toBase58()}`;
    let orderId: bigint | null = null;
    await expect
      .poll(async () => {
        const bookSide = await adapter.fetchBookSide(marketRef, side, tick);
        const order = bookSide?.orders.find(
          (o) => o.amount > 0n && o.maker.equals(purchaser.publicKey),
        );
        orderId = order?.id ?? null;
        return orderId?.toString() ?? "";
      }, { timeout: 30_000 })
      .not.toBe("");
    await page.goto(`/orderbook/${ob.soothMarketPda.toBase58()}`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("ob-submit-button")).toBeVisible({
      timeout: 30_000,
    });

    const cancelTx = await cancelOrderbookViaAdapter({
      conn,
      signer: purchaser,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side,
      tick,
      byId: orderId!,
    });
    expect(cancelTx).toMatch(/^sol:[1-9A-HJ-NP-Za-km-z]{40,}$/);

    await expect
      .poll(async () => {
        const bookSide = await adapter.fetchBookSide(marketRef, side, tick);
        return (
          bookSide?.orders.filter(
            (o) => o.amount > 0n && o.maker.equals(purchaser.publicKey),
          ).length ?? 0
        );
      }, { timeout: 30_000 })
      .toBe(0);
  });
});
