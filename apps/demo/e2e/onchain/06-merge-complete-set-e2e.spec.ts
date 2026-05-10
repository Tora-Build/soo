// merge-complete-set-e2e — UI-driven via /portfolio CompleteSetPanel.
//
// Inverse of 05-mint-complete-set, also UI-driven now. Pre-condition is
// adapter-direct (mint 10 USDC of complete-set so YES+NO ATAs each
// carry ≥10·USDC base units before merge — keeps the spec stable
// regardless of order with prior specs).
//
// Verifications:
//   - user_yes_ata / user_no_ata each -= 10·USDC
//   - user USDC ATA += 10·USDC

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { makeConnection, getTokenBalance } from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import {
  deriveYesMintPda,
  deriveNoMintPda,
  loadTestKeypair,
  mintCompleteSetViaAdapter,
} from "../helpers/sdk-helpers";

const TEN_USDC = 10_000_000n;

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

    // Pre-condition: ensure enough YES + NO to merge. Adapter-direct so
    // the UI walkthrough only captures the merge action, not the setup.
    const signer = loadTestKeypair();
    await mintCompleteSetViaAdapter({
      conn,
      signer,
      marketPda,
      marketId: idBytes,
      usdcMint,
      amount: TEN_USDC,
    });

    const yesBefore = await readOutcome(yesMint);
    const noBefore = await readOutcome(noMint);
    const usdcBefore = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(yesBefore).toBeGreaterThanOrEqual(TEN_USDC);
    expect(noBefore).toBeGreaterThanOrEqual(TEN_USDC);

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
      .poll(async () => await readOutcome(yesMint), { timeout: 60_000 })
      .toBe(yesBefore - TEN_USDC);
    const noAfter = await readOutcome(noMint);
    const usdcAfter = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    expect(noBefore - noAfter).toBe(TEN_USDC);
    expect(usdcAfter - usdcBefore).toBe(TEN_USDC);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
