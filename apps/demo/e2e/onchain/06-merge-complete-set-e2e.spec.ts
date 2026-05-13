// merge-complete-set-e2e — UI-driven via /portfolio CompleteSetPanel.
//
// Inverse of 05-mint-complete-set, also UI-driven now. Pre-condition is
// adapter-direct (mint 10 USDC of orderbook complete-set so
// OrderbookPosition YES+NO each carry ≥10·WAD before merge — keeps the spec stable
// regardless of order with prior specs).
//
// Verifications:
//   - OrderbookPosition.yes_shares / .no_shares each -= 10·WAD
//   - user USDC ATA += 10·USDC

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection, getTokenBalance } from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import {
  fetchOrderbookPosition,
  loadTestKeypair,
  mintOrderbookCompleteSetViaAdapter,
} from "../helpers/sdk-helpers";

const TEN_USDC = 10_000_000n;
const TEN_SHARES_WAD = 10n * 10n ** 18n;

test.describe("merge complete-set (UI-driven)", () => {
  test("MERGE 10 USDC via /portfolio: YES+NO -= 10·USDC; USDC += 10·USDC", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fixture = loadFixture();
    const conn = makeConnection();
    const TEST_PUBKEY = testPubkey();
    const idBytes = marketIdBytes(fixture);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const marketPda = new PublicKey(fixture.marketPda);

    // Pre-condition: ensure enough YES + NO to merge. Adapter-direct so
    // the UI walkthrough only captures the merge action, not the setup.
    const signer = loadTestKeypair();
    await mintOrderbookCompleteSetViaAdapter({
      conn,
      signer,
      marketPda,
      usdcMint,
      amount: TEN_USDC,
    });

    const positionBefore = await fetchOrderbookPosition({
      conn,
      marketId: idBytes,
      user: TEST_PUBKEY,
    });
    const usdcBefore = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(positionBefore.yesShares).toBeGreaterThanOrEqual(TEN_SHARES_WAD);
    expect(positionBefore.noShares).toBeGreaterThanOrEqual(TEN_SHARES_WAD);

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
    await page.getByTestId("complete-set-merge").click();

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
      .toBe(positionBefore.yesShares - TEN_SHARES_WAD);
    const positionAfter = await fetchOrderbookPosition({
      conn,
      marketId: idBytes,
      user: TEST_PUBKEY,
    });
    const usdcAfter = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(positionBefore.noShares - positionAfter.noShares).toBe(
      TEN_SHARES_WAD,
    );
    expect(usdcAfter - usdcBefore).toBe(TEN_USDC);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
