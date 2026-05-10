// dismiss-market-e2e — UI-driven via /portfolio DismissMarketPanel.
//
// Surfpool is required to fast-forward past the fresh market's short trial
// window. The connected wallet is swapped to the creator keypair because
// dismiss_market is creator-only.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  createSeededMarketViaAdapter,
  deriveAmmStatePda,
  fetchAmmState,
  loadCreatorKeypair,
} from "../helpers/sdk-helpers";
import { isSurfpool, timeTravel } from "../helpers/surfpool";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAD = 10n ** 18n;

function keypairBytes(filename: string): number[] {
  return JSON.parse(
    readFileSync(resolve(__dirname, "..", "..", ".localnet", filename), "utf8"),
  ) as number[];
}

test.describe("dismiss market (UI-driven, Surfpool-gated)", () => {
  test.beforeAll(async () => {
    test.skip(
      !(await isSurfpool()),
      "requires Surfpool (surfnet_timeTravel cheatcode)",
    );
  });

  test("creator clicks DISMISS MARKET after trial_end_at", async ({ page }) => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const fresh = await createSeededMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      question: `Will T64 dismissal work ${Date.now()}?`,
      initialB: 1_000n * WAD,
      startTime: now,
      deadline: now + 10n,
    });
    const ammStatePda = deriveAmmStatePda(fresh.marketId);

    await timeTravel(5);

    await page.goto(`/portfolio?market=${fresh.marketPda.toBase58()}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async (bytes) => {
      const w = window as unknown as {
        _connectTestWalletAs?: (b: number[]) => Promise<void>;
      };
      if (!w._connectTestWalletAs) {
        throw new Error(
          "_connectTestWalletAs not exposed (VITE_TEST_MODE=true?)",
        );
      }
      await w._connectTestWalletAs(bytes);
    }, keypairBytes("creator-keypair.json"));

    const dismissButton = page.getByTestId("dismiss-market-button");
    await expect(dismissButton).toBeVisible({ timeout: 30_000 });
    await expect(dismissButton).toBeEnabled({ timeout: 30_000 });
    await dismissButton.click();

    await expect
      .poll(async () => (await fetchAmmState(conn, ammStatePda))?.isDismissed, {
        timeout: 60_000,
      })
      .toBe(true);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
