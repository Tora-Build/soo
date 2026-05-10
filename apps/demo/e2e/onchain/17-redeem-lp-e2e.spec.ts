// redeem-lp-e2e — UI-driven via /portfolio RedeemLpPanel.
//
// Setup graduates a fresh market, mints USDC directly into the singleton
// lp_yield_vault, then swaps the test wallet to the creator LP holder. The
// action under test is REDEEM LP from the portfolio panel.

import { test, expect } from "@playwright/test";
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  deriveLpYieldAuthorityPda,
  fetchAmmState,
  loadCreatorKeypair,
  loadMintAuthorityKeypair,
  loadTestKeypair,
} from "../helpers/sdk-helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAD = 10n ** 18n;

function keypairBytes(filename: string): number[] {
  return JSON.parse(
    readFileSync(resolve(__dirname, "..", "..", ".localnet", filename), "utf8"),
  ) as number[];
}

test.describe("redeem LP (UI-driven)", () => {
  test("creator redeems half LP balance for pro-rata USDC yield", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const user = loadTestKeypair();
    const mintAuthority = loadMintAuthorityKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);
    const now = await readOnchainClock(conn);
    // Tiny b: see comment in 14-trade-to-graduate-e2e — keeps the
    // graduation loop under the LMSR's i128 saturation point.
    const fresh = await createSeededMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      question: `Will T64 LP redemption work ${Date.now()}?`,
      initialB: 1n * WAD,
      startTime: now,
      deadline: now + 7n * 24n * 60n * 60n,
    });
    const ammStatePda = deriveAmmStatePda(fresh.marketId);

    for (let i = 0; i < 30; i += 1) {
      const state = await fetchAmmState(conn, ammStatePda);
      if (state?.isGraduated) break;
      const beforeQYes = state?.qYes ?? 0n;
      await buyViaAdapter({
        conn,
        signer: user,
        marketPda: fresh.marketPda,
        marketId: fresh.marketId,
        usdcMint,
        outcome: 1,
        deltaShares: 10n * WAD,
        maxCostWad: 50n * WAD,
      });
      await waitForOnChainChange(
        () => fetchAmmState(conn, ammStatePda),
        (next) => Boolean(next?.isGraduated || (next?.qYes ?? 0n) > beforeQYes),
        60_000,
      );
    }
    expect((await fetchAmmState(conn, ammStatePda))?.isGraduated).toBe(true);

    const lpBefore = (await getAccount(conn, fresh.creatorLpAta)).amount;
    expect(lpBefore).toBeGreaterThan(0n);
    const lpMintSupplyBefore = (await getMint(conn, fresh.lpMint)).supply;
    const burnAmount = lpBefore / 2n;

    const lpYieldAuthority = deriveLpYieldAuthorityPda();
    const lpYieldVault = getAssociatedTokenAddressSync(
      usdcMint,
      lpYieldAuthority,
      true,
    );
    const yieldAmount = 2_000_000n;
    const fundYieldVaultTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        mintAuthority.publicKey,
        lpYieldVault,
        lpYieldAuthority,
        usdcMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createMintToInstruction(
        usdcMint,
        lpYieldVault,
        mintAuthority.publicKey,
        yieldAmount,
      ),
    );
    await sendAndConfirmTransaction(conn, fundYieldVaultTx, [mintAuthority], {
      commitment: "confirmed",
    });
    // The creator's USDC ATA may not exist yet — the launchpad flow doesn't
    // pre-create one for the market creator. Idempotent-create it (paid by
    // mint-authority) so the redeem ix's CPI transfer + the post-redeem
    // assertion both have a real account to read.
    const creatorUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      creator.publicKey,
    );
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          mintAuthority.publicKey,
          creatorUsdcAta,
          creator.publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      ),
      [mintAuthority],
      { commitment: "confirmed" },
    );
    const creatorUsdcBefore = (await getAccount(conn, creatorUsdcAta)).amount;
    // Snapshot the vault balance HERE (post-funding, pre-redeem). The
    // lp_yield_authority is a singleton across markets, so the vault may
    // already hold residue from earlier suite runs — using `yieldAmount`
    // here would assert against an inflated denominator. The redeem ix
    // computes `payout = vault.amount * lp_amount / lp_supply` against
    // the live balance, so the test mirrors that.
    void yieldAmount;
    const lpYieldVaultBefore = (await getAccount(conn, lpYieldVault)).amount;
    const expectedPayout =
      (lpYieldVaultBefore * burnAmount) / lpMintSupplyBefore;

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

    const amountInput = page.getByTestId("redeem-lp-amount");
    await expect(amountInput).toBeVisible({ timeout: 30_000 });
    await amountInput.fill((Number(burnAmount) / 1_000_000).toString());
    const redeemButton = page.getByTestId("redeem-lp-button");
    await expect(redeemButton).toBeEnabled({ timeout: 30_000 });
    await redeemButton.click();

    await expect
      .poll(async () => (await getAccount(conn, fresh.creatorLpAta)).amount, {
        timeout: 60_000,
      })
      .toBe(lpBefore - burnAmount);
    // Use poll for the vault and creator USDC too — the redeem ix lands
    // in a single tx alongside the LP burn, but RPC commitment can lag a
    // beat between those two reads.
    await expect
      .poll(async () => (await getAccount(conn, lpYieldVault)).amount, {
        timeout: 30_000,
      })
      .toBe(lpYieldVaultBefore - expectedPayout);
    await expect
      .poll(
        async () =>
          (await getAccount(conn, creatorUsdcAta)).amount - creatorUsdcBefore,
        { timeout: 30_000 },
      )
      .toBe(expectedPayout);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
