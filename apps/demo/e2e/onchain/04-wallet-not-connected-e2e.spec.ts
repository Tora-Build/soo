// wallet-not-connected-e2e — load /amm/<market> WITHOUT connecting the
// wallet. The CTA must read "Connect Wallet" and no tx must fire.

import { test, expect, type Page } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { loadFixture } from "../helpers/fixture";

async function installTxCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type W = Record<string, unknown>;
    (window as unknown as W).__lastSig = null;
    const origFetch = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const init = args[1];
      const body = typeof init?.body === "string" ? init.body : "";
      const isSendTx = body.includes('"sendTransaction"');
      const res = await origFetch(...args);
      if (isSendTx) {
        try {
          const clone = res.clone();
          const json = (await clone.json()) as { result?: string };
          if (json.result) (window as unknown as W).__lastSig = json.result;
        } catch {
          /* ignore */
        }
      }
      return res;
    };
  });
}

test.describe("AMM page without wallet connect", () => {
  test("CTA reads 'Connect Wallet'; clicking it does not fire a tx", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const fixture = loadFixture();
    const marketPda = new PublicKey(fixture.marketPda);

    await installTxCapture(page);
    await page.goto(`/amm/${marketPda.toBase58()}`);
    await page.waitForLoadState("networkidle");

    // Trading panel renders even without a wallet.
    await expect(page.getByTestId("trading-panel")).toBeVisible({
      timeout: 15_000,
    });

    // The buy/sell button is hidden when not connected; SimpleTradingPanel
    // renders a separate "Connect Wallet" Button in its place. Assert the
    // text is present somewhere in the panel and that buy-button has not
    // mounted (or, if it has, it is disabled).
    const panel = page.getByTestId("trading-panel");
    await expect(
      panel.getByRole("button", { name: /connect wallet/i }).first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    // buy-button should not be present (the panel branches on isConnected).
    const buyButtonCount = await page.getByTestId("buy-button").count();
    expect(buyButtonCount).toBe(0);

    // Click the Connect Wallet CTA — without _connectTestWallet being
    // invoked, the wallet-adapter modal should open (or no-op in test
    // mode). The critical invariant is that no tx is sent.
    await panel
      .getByRole("button", { name: /connect wallet/i })
      .first()
      .click();
    await page.waitForTimeout(2000);

    const lastSig = await page.evaluate(
      () => (window as unknown as { __lastSig: string | null }).__lastSig,
    );
    expect(lastSig).toBeNull();
  });
});
