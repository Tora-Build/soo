// create-market-e2e — UI-driven via /launchpad.
//
// Drives the full Launchpad form: question, expiration, adjudicator,
// initial-liquidity slider (default 693 USDC), then LAUNCH. The
// chain-shim's `dispatchCreateMarket` routes to
// `sooth_core::create_market` (composes 4 inner CPIs); on success
// it stashes the new Market PDA at `globalThis.__lastCreatedMarketPda`
// because the EVM-shaped Hash return type can't carry the address
// otherwise (event-log decoding upstream is EVM-only).
//
// Verifications:
//   - globalThis.__lastCreatedMarketPda gets set within 30s.
//   - Market PDA exists on-chain, owned by sooth_core, lifecycle=Open.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection } from "../helpers/onchain";
import { fetchMarket, coreProgramId } from "../helpers/sdk-helpers";

test.describe("create-market (UI-driven via /launchpad)", () => {
  test("LAUNCH a fresh market via /launchpad: PDA created, lifecycle=Open", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const conn = makeConnection();

    await page.goto(`/launchpad`);
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

    // Fill the form. Question must be ≥10 chars per launchpad's
    // canCreateMarket gate (Launchpad.tsx:755).
    await page
      .getByTestId("launchpad-question-input")
      .fill("Will the e2e suite pass before tomorrow at 5pm?");
    await page.getByTestId("launchpad-expiration-30d").click();
    await page.getByTestId("launchpad-adjudicator-manual").click();

    // The chain-shim defaults `adjudicator` to the connected user
    // regardless of which UI option was picked (registry options are
    // EVM-shaped 0x… addresses with no Solana equivalent — see
    // dispatchCreateMarket in chain-shim/amm-bridge.ts). Picking
    // "manual" matches that semantically.

    const launchBtn = page.getByTestId("launchpad-launch-button");
    await expect(launchBtn).toBeEnabled({ timeout: 15_000 });
    await launchBtn.click();

    // The new Market PDA shows up on `globalThis.__lastCreatedMarketPda`
    // once the on-chain ix lands (chain-shim writes it before the submit
    // resolves). Poll the page-side global until it's set.
    const newMarketPdaStr = await page.evaluate(async () => {
      const w = globalThis as unknown as { __lastCreatedMarketPda?: string };
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        if (w.__lastCreatedMarketPda) return w.__lastCreatedMarketPda;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(
        "globalThis.__lastCreatedMarketPda not set within 60s — createMarket dispatch likely failed",
      );
    });

    expect(newMarketPdaStr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const newMarketPda = new PublicKey(newMarketPdaStr);

    // On-chain assertions: the Market account exists, owned by
    // sooth_core, lifecycle = Open (1).
    // The chain-shim stashes the PDA *before* tx confirmation so the
    // dapp UX can navigate immediately. Poll until the on-chain account
    // materializes (typical Surfpool latency is sub-second).
    let market = await fetchMarket(conn, newMarketPda);
    const pollDeadline = Date.now() + 30_000;
    while (market === null && Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      market = await fetchMarket(conn, newMarketPda);
    }
    expect(market).not.toBeNull();
    expect(market!.lifecycle).toBe(1);

    const acc = await conn.getAccountInfo(newMarketPda);
    expect(acc).not.toBeNull();
    expect(acc!.owner.toBase58()).toBe(coreProgramId.toBase58());

    const marketAddressForUi = `0x${newMarketPdaStr}`;
    const shortened = `${marketAddressForUi.slice(0, 6)}…${marketAddressForUi.slice(-4)}`;
    await page.goto(`/markets`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(shortened).first()).toBeVisible({
      timeout: 30_000,
    });

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
