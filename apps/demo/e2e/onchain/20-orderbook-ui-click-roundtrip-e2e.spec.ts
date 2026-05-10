// orderbook-ui-click-roundtrip-e2e — full UI-driven sooth_book round-trip.
//
// Spec 19 placed the order via direct adapter calls (chain-shim orderbook
// dispatch was not yet wired). This spec drives the full SoothBookTerminal
// trade form via clicks: select YES, select Buy, fill price/shares, click
// Submit, then verify the OrderRequestQueue grew on-chain.
//
// Prereqs (mirrored from spec 19):
//   - Surfpool/test-validator running at $SOLANA_RPC_URL with all five
//     sooth_* programs deployed and protocol singletons seeded
//     (sooth_book MarketType + protocol-default PriceLadder).
//   - VITE_TEST_KEYPAIR_BYTES + TEST_PUBKEY env vars exported.
//
// Bridges the URL/marketRef alignment by attaching sooth_book to the
// fixture's seeded sooth_market. Both `ctx.marketRef` (sourced from
// VITE_DEMO_MARKET_REF = sol:<fixture.marketPda>) and the URL
// `/orderbook/<bookMarketPda>` therefore resolve to the same on-chain
// queue, which is what we assert grew.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection } from "../helpers/onchain";
import { loadFixture, marketIdBytes } from "../helpers/fixture";
import {
  createSeededOrderbookMarketViaAdapter,
  loadCreatorKeypair,
  loadTestKeypair,
  makePrograms,
  deriveAmmStatePda as deriveAmmStatePdaHelper,
  deriveLpMintPda as deriveLpMintPdaHelper,
  type FreshMarketSetup,
} from "../helpers/sdk-helpers";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

test.describe("orderbook UI-click round-trip (sooth_book)", () => {
  test("fill trade form + submit → OrderRequestQueue grows on-chain", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // ── 1. Setup: bind sooth_book to the FIXTURE's sooth_market so the
    //    browser's `ctx.marketRef` (= fixture.marketPda via VITE_DEMO_MARKET_REF)
    //    derives the same bookMarketPda we navigate to in the URL.
    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const purchaser = loadTestKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);
    const fixtureMarketPda = new PublicKey(fixture.marketPda);
    const fixtureMarketId = marketIdBytes(fixture);

    // Stub the FreshMarketSetup shape required by
    // createSeededOrderbookMarketViaAdapter. Only `marketId` + `marketPda`
    // are read by the helper; the AMM/LP fields are derived for shape
    // completeness even though the helper never touches them.
    const stubExistingMarket: FreshMarketSetup = {
      marketId: fixtureMarketId,
      marketPda: fixtureMarketPda,
      ammStatePda: deriveAmmStatePdaHelper(fixtureMarketId),
      lpMint: deriveLpMintPdaHelper(fixtureMarketId),
      creatorLpAta: getAssociatedTokenAddressSync(
        deriveLpMintPdaHelper(fixtureMarketId),
        creator.publicKey,
      ),
    };

    const ob = await createSeededOrderbookMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      existingSoothMarket: stubExistingMarket,
    });

    expect(ob.soothMarketPda.toBase58()).toBe(fixture.marketPda);

    const programs = makePrograms(conn, purchaser);

    // ── 2. Snapshot the queue length BEFORE the UI submit.
    const queueBefore =
      await programs.book.account.marketOrderRequestQueue.fetch(
        ob.orderRequestQueue,
      );
    const lenBefore = Number((queueBefore as any).orderRequests.len);

    // ── 3. Navigate to the orderbook page + connect the test wallet.
    await page.goto(`/orderbook/${ob.bookMarketPda.toBase58()}`);
    await page.waitForLoadState("domcontentloaded");

    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet) {
        throw new Error(
          "_connectTestWallet not exposed — TestWalletBridge not mounted (VITE_TEST_MODE not 'true'?)",
        );
      }
      await w._connectTestWallet();
    });

    // ── 4. Wait for the trade form (gate B defeated by chain-shim's
    //    `isMarketRegistered` dispatch). Submit button is the canonical
    //    proof that SoothBookTerminal mounted the active path.
    const submitBtn = page.getByTestId("ob-submit-button");
    await expect(submitBtn).toBeVisible({ timeout: 30_000 });

    // ── 5. Set the form: BUY YES @ 40¢ for 100 shares (= 40 USDC stake).
    //    Mirrors spec 19's PRICE_YES = 400 ticks × 10^15 WAD/tick = 0.4·WAD.
    //    The form's `clampTick` (useOrderbookTrade.ts) maps price=0.40 → tick=400.
    await page.getByTestId("ob-outcome-yes").click();
    await page.getByTestId("ob-side-buy").click();
    const priceInput = page.getByTestId("ob-price-input");
    await priceInput.fill("40");
    const sharesInput = page.getByTestId("ob-shares-input");
    await sharesInput.fill("100");

    // Wait for validation to clear (USDC balance read may take a moment to
    // resolve after wallet connect). The submit button enables once
    // !insufficientBalance && !insufficientShares && !tickOutOfRange.
    await expect(submitBtn).toBeEnabled({ timeout: 30_000 });

    // ── 6. Click submit. The chain-shim's dispatchOrderbookWrite routes
    //    `buyYes` → `adapter.buildOrderbookBuy` → real Solana tx, signed
    //    by LocalKeypairAdapter, confirmed by adapter.submit().
    await submitBtn.click();

    // ── 7. Poll the on-chain OrderRequestQueue until length grows. The
    //    chain-shim's `submitAndSynth` returns once the tx is confirmed,
    //    but useOrderbookTrade's wagmi-shim layer adds its own wait
    //    overhead. Poll directly for determinism.
    const finalLen = await new Promise<number>((resolve, reject) => {
      const deadline = Date.now() + 60_000;
      const tick = async () => {
        try {
          const q = await programs.book.account.marketOrderRequestQueue.fetch(
            ob.orderRequestQueue,
          );
          const n = Number((q as any).orderRequests.len);
          if (n > lenBefore) return resolve(n);
        } catch {
          // queue may briefly fail to fetch during slot transitions; retry
        }
        if (Date.now() > deadline) {
          return reject(
            new Error(
              `OrderRequestQueue did not grow within 60s (still ${lenBefore})`,
            ),
          );
        }
        setTimeout(tick, 500);
      };
      tick();
    });

    expect(finalLen).toBeGreaterThan(lenBefore);
  });
});
