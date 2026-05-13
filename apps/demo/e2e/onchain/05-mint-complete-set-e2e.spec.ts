// mint-complete-set-e2e — UI-driven via /portfolio CompleteSetPanel.
//
// Flow:
//   1. Capture before-state: user_yes_ata, user_no_ata, user_usdc_ata.
//   2. Navigate to /portfolio, connect the LocalKeypair adapter, wait for
//      the CompleteSetPanel to mount.
//   3. Fill amount = 10, click MINT.
//   4. Poll on-chain until OrderbookPosition yes/no each grew by exactly
//      10·WAD and usdc_ata dropped by 10 USDC.
//
// Verifications:
//   - OrderbookPosition.yes_shares and .no_shares each += 10·WAD
//   - user USDC ATA -= 10·USDC

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection, getTokenBalance } from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import { fetchOrderbookPosition } from "../helpers/sdk-helpers";

const TEN_USDC = 10_000_000n;
const TEN_SHARES_WAD = 10n * 10n ** 18n;

test.describe("mint complete-set (UI-driven)", () => {
  test("MINT 10 USDC via /portfolio: YES+NO ATAs each += 10·USDC; USDC -= 10·USDC", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fixture = loadFixture();
    const conn = makeConnection();
    const TEST_PUBKEY = testPubkey();
    const idBytes = marketIdBytes(fixture);
    const usdcMint = new PublicKey(fixture.usdcMint);

    const positionBefore = await fetchOrderbookPosition({
      conn,
      marketId: idBytes,
      user: TEST_PUBKEY,
    });
    const usdcBefore = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);

    await page.goto(`/portfolio`);
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

    await expect(page.getByTestId("complete-set-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("complete-set-amount").fill("10");
    await page.getByTestId("complete-set-mint").click();

    // Poll on-chain for the yes/no/usdc deltas.
    await expect
      .poll(
        async () =>
          (
            await fetchOrderbookPosition({
              conn,
              marketId: idBytes,
              user: TEST_PUBKEY,
            })
          ).yesShares,
        { timeout: 60_000 },
      )
      .toBe(positionBefore.yesShares + TEN_SHARES_WAD);
    const positionAfter = await fetchOrderbookPosition({
      conn,
      marketId: idBytes,
      user: TEST_PUBKEY,
    });
    const usdcAfter = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(positionAfter.noShares - positionBefore.noShares).toBe(
      TEN_SHARES_WAD,
    );
    expect(usdcBefore - usdcAfter).toBe(TEN_USDC);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
