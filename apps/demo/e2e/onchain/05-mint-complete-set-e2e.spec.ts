// mint-complete-set-e2e — UI-driven via /portfolio CompleteSetPanel.
//
// Flow:
//   1. Capture before-state: user_yes_ata, user_no_ata, user_usdc_ata.
//   2. Navigate to /portfolio, connect the LocalKeypair adapter, wait for
//      the CompleteSetPanel to mount.
//   3. Fill amount = 10, click MINT.
//   4. Poll on-chain until yes_ata / no_ata each grew by exactly 10·USDC
//      (10_000_000 base units, 6-decimal mint) and usdc_ata dropped by
//      the same.
//
// Verifications:
//   - user_yes_ata.amount and user_no_ata.amount each += 10·USDC
//   - user USDC ATA -= 10·USDC

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { makeConnection, getTokenBalance } from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import { deriveYesMintPda, deriveNoMintPda } from "../helpers/sdk-helpers";

const TEN_USDC = 10_000_000n;

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

    const yesMint = deriveYesMintPda(idBytes);
    const noMint = deriveNoMintPda(idBytes);

    async function readOutcome(mint: PublicKey): Promise<bigint> {
      const ata = getAssociatedTokenAddressSync(mint, TEST_PUBKEY);
      try {
        const acc = await getAccount(conn, ata);
        return acc.amount;
      } catch {
        return 0n;
      }
    }

    const yesBefore = await readOutcome(yesMint);
    const noBefore = await readOutcome(noMint);
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
      .poll(async () => await readOutcome(yesMint), { timeout: 60_000 })
      .toBe(yesBefore + TEN_USDC);
    const noAfter = await readOutcome(noMint);
    const usdcAfter = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(noAfter - noBefore).toBe(TEN_USDC);
    expect(usdcBefore - usdcAfter).toBe(TEN_USDC);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
