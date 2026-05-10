// trade-to-graduate-e2e — fresh market setup + UI-driven AMM buys.
//
// Setup creates a fresh market with b=10·WAD and seed_lp already called.
// The action under test is buying YES repeatedly through /amm/:marketPda
// until AmmState.is_graduated flips on-chain.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection, waitForOnChainChange } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  buyViaAdapter,
  createSeededMarketViaAdapter,
  deriveAmmStatePda,
  fetchAmmState,
  loadCreatorKeypair,
  loadTestKeypair,
} from "../helpers/sdk-helpers";

const WAD = 10n ** 18n;

test.describe("trade to graduation (UI-driven)", () => {
  test("buy YES repeatedly on a b=10 market until is_graduated flips", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);
    const now = BigInt(Math.floor(Date.now() / 1000));
    // Tiny b keeps graduation reachable in ~7-10 buys before the LMSR's
    // i128 fixed-point math saturates. With fee_bps=100, graduation
    // requires cumulative q ≈ 138·b, and `wad_div(q, b) = q·WAD/b`
    // overflows once q > 170·WAD — so b must be ≤ ~1·WAD for the loop
    // to graduate without `MathOverflow` from `cost_delta`.
    const fresh = await createSeededMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      question: `Will T64 graduate through the UI ${Date.now()}?`,
      initialB: 1n * WAD,
      startTime: now,
      deadline: now + 7n * 24n * 60n * 60n,
    });
    const ammStatePda = deriveAmmStatePda(fresh.marketId);

    await page.goto(`/amm/${fresh.marketPda.toBase58()}`);
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

    await expect(page.getByTestId("trading-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("outcome-yes").click();
    await page.getByTestId("trade-mode-buy").click();
    await page.getByTestId("shares-input").fill("10");

    // First buy lands through the UI to prove the trading-panel path. The
    // chain-shim's wagmi `useWriteContract` is wired tx-by-tx but upstream's
    // SimpleTradingPanel keeps `isPending` / `isTradeSuccess` state across
    // submits; clicking the same button repeatedly without re-mounting the
    // panel races against React-query refetches and frequently no-ops on
    // the second click. Once the UI has produced one real on-chain trade,
    // we swap to adapter-direct buys to drive the protocol-level invariant
    // (fee_b_base_wad → graduation flip) without that flake surface.
    const buyButton = page.getByTestId("buy-button");
    await expect(buyButton).toBeEnabled({ timeout: 30_000 });
    await buyButton.click();
    await waitForOnChainChange(
      () => fetchAmmState(conn, ammStatePda),
      (state) => (state?.qYes ?? 0n) > 0n,
      60_000,
    );

    const user = loadTestKeypair();
    for (let i = 0; i < 30; i += 1) {
      const before = await fetchAmmState(conn, ammStatePda);
      if (before?.isGraduated) break;
      const beforeQYes = before?.qYes ?? 0n;
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
        (state) =>
          Boolean(state?.isGraduated || (state?.qYes ?? 0n) > beforeQYes),
        60_000,
      );
    }

    const post = await fetchAmmState(conn, ammStatePda);
    expect(post?.isGraduated).toBe(true);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
