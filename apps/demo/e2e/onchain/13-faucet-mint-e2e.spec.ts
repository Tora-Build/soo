// faucet-mint-e2e — UI-driven via /faucet.
//
// Faucet.tsx mints 100,000 mUSDC (`parseUnits("100000", 6)`) to the
// connected LocalKeypair wallet through the chain-shim `mint` dispatcher.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection, getTokenBalance } from "../helpers/onchain";
import { loadFixture, testPubkey } from "../helpers/fixture";

const FAUCET_AMOUNT = 100_000_000_000n;

test.describe("faucet mint (UI-driven)", () => {
  test("Request 100,000 mUSDC via /faucet: user USDC ATA grows by faucet amount", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const user = testPubkey();
    const usdcMint = new PublicKey(fixture.usdcMint);
    const before = await getTokenBalance(conn, usdcMint, user);

    await page.goto(`/faucet`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet) {
        throw new Error(
          "_connectTestWallet not exposed (VITE_TEST_MODE=true?)",
        );
      }
      await w._connectTestWallet();
    });

    const mintButton = page.getByTestId("faucet-mint-button");
    await expect(mintButton).toBeEnabled({ timeout: 15_000 });
    await mintButton.click();

    await expect
      .poll(async () => await getTokenBalance(conn, usdcMint, user), {
        timeout: 60_000,
      })
      .toBe(before + FAUCET_AMOUNT);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
