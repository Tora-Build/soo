// orderbook-gated-state-e2e — direct /orderbook route on the Solana fork.
//
// No wallet is required. The Solana deployment intentionally has no
// sooth_book address, so SoothBookTerminal renders its unavailable state.

import { test, expect } from "@playwright/test";
import { loadFixture } from "../helpers/fixture";

test.describe("orderbook gated state", () => {
  test("plain /orderbook/:marketPda renders SoothBook unavailable copy", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const fixture = loadFixture();
    await page.goto(`/orderbook/${fixture.marketPda}`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByText("Orderbook not available on this chain"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("sooth_book")).toBeVisible();
  });
});
