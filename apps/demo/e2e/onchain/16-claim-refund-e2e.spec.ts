// claim-refund-e2e — UI-driven via /portfolio ClaimRefundPanel.
//
// Setup buys YES on a fresh short-trial market, time-travels past the trial,
// and dismisses via the creator. The user then claims the locked-cost refund
// through the UI.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import {
  makeConnection,
  readOnchainClock,
  waitForOnChainChange,
} from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  buyViaAdapter,
  createSeededMarketViaAdapter,
  deriveAmmStatePda,
  derivePositionPda,
  dismissMarketViaAdapter,
  fetchAmmState,
  fetchPosition,
  loadCreatorKeypair,
  loadTestKeypair,
} from "../helpers/sdk-helpers";
import { isSurfpool, timeTravel } from "../helpers/surfpool";

const WAD = 10n ** 18n;

test.describe("claim refund (UI-driven, Surfpool-gated)", () => {
  test.beforeAll(async () => {
    test.skip(
      !(await isSurfpool()),
      "requires Surfpool (surfnet_timeTravel cheatcode)",
    );
  });

  test("dismissed market CLAIM REFUND returns locked_cost and closes Position", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const user = loadTestKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);
    const now = await readOnchainClock(conn);
    const fresh = await createSeededMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      question: `Will T64 refund work ${Date.now()}?`,
      initialB: 1_000n * WAD,
      startTime: now,
      deadline: now + 60n,
    });
    const ammStatePda = deriveAmmStatePda(fresh.marketId);

    await buyViaAdapter({
      conn,
      signer: user,
      marketPda: fresh.marketPda,
      marketId: fresh.marketId,
      usdcMint,
      outcome: 1,
      deltaShares: 5n * WAD,
      maxCostWad: 10n * WAD,
    });

    const positionPda = derivePositionPda(fresh.marketId, user.publicKey);
    const positionBefore = await fetchPosition(conn, positionPda);
    const lockedCost = positionBefore?.lockedCostUsdc ?? 0n;
    expect(lockedCost).toBeGreaterThan(0n);

    const beforeDismiss = await fetchAmmState(conn, ammStatePda);
    const clockBeforeDismiss = await readOnchainClock(conn);
    const secondsToTrialEnd =
      (beforeDismiss?.trialEndAt ?? clockBeforeDismiss) - clockBeforeDismiss;
    if (secondsToTrialEnd >= 0n) {
      await timeTravel(Number(secondsToTrialEnd + 1n));
    }
    await dismissMarketViaAdapter({
      conn,
      creator,
      marketPda: fresh.marketPda,
      marketId: fresh.marketId,
    });
    await waitForOnChainChange(
      () => fetchAmmState(conn, ammStatePda),
      (state) => state?.isDismissed === true,
      60_000,
    );

    const userUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      user.publicKey,
    );
    const userUsdcBefore = (await getAccount(conn, userUsdcAta)).amount;

    await page.goto(`/portfolio?market=${fresh.marketPda.toBase58()}`);
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

    const claimButton = page.getByTestId("claim-refund-button");
    await expect(claimButton).toBeVisible({ timeout: 30_000 });
    await expect(claimButton).toBeEnabled({ timeout: 30_000 });
    await claimButton.click();

    await expect
      .poll(async () => await conn.getAccountInfo(positionPda), {
        timeout: 60_000,
      })
      .toBeNull();
    const userUsdcAfter = (await getAccount(conn, userUsdcAta)).amount;
    expect(userUsdcAfter - userUsdcBefore).toBe(lockedCost);
  });
});
