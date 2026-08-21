// redeem-yes-wins-e2e — UI-driven via /portfolio CompleteSetPanel REDEEM.
//
// Pre-conditions (adapter-direct, NOT under test):
//   1. Market settled with winning=YES (spec 10 should have done this;
//      we re-attempt as no-op-on-already-settled for ordering robustness).
//   2. User holds ≥10·USDC of YES outcome tokens — mint complete-set if
//      missing AND market still Open. If market is Settled and YES
//      balance is 0, the spec degrades to a smoke test that redeem
//      doesn't crash on empty positions.
//
// Action under test (UI):
//   Navigate to /portfolio, fill the REDEEM amount, click REDEEM. The
//   panel routes through the chain-shim's `redeem` dispatcher to
//   sooth_core::redeem (1:1 winner payout for YES holders, NO tokens
//   untouched per redeem_amm_position.rs).
//
// Verifications:
//   - User's YES outcome ATA → 0 (winning side fully burned)
//   - User's NO outcome ATA: unchanged
//   - User's USDC ATA: += original YES balance (1:1 payout)

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { makeConnection } from "../helpers/onchain";
import { isSurfpool } from "../helpers/surfpool";
import { loadFixture, marketIdBytes } from "../helpers/fixture";
import {
  loadTestKeypair,
  loadCreatorKeypair,
  mintCompleteSetViaAdapter,
  requestLockViaAdapter,
  attestOutcomeViaAdapter,
  settleViaAdapter,
  waitForVetoWindow,
  deriveYesMintPda,
  deriveNoMintPda,
  fetchMarket,
} from "../helpers/sdk-helpers";

const MINT_AMOUNT = 10_000_000n; // 10 USDC base units
const LIFECYCLE_SETTLED = 3;

test.describe("Redeem (YES wins) — UI-driven", () => {
  // Surfpool-gated, like 08/09/15/16. `request_lock` requires
  // `now >= market.deadline` (request_lock.rs:45) and the seed writes a
  // deadline 7 days out, so this chain only runs once the clock has been moved
  // past it — which needs surfnet_timeTravel.
  //
  // These two specs never time-travelled themselves; they relied on
  // 09-trading-window's time travel persisting in the shared ledger. That
  // implicit ordering dependency was invisible on Surfpool (where 09 runs) and
  // made them fail on solana-test-validator (where 09 skips, so the clock never
  // advances). Stating the requirement explicitly is the honest fix; making
  // them self-sufficient would mean each one time-travelling, which changes the
  // shared clock for everything after.
  test.beforeAll(async () => {
    test.skip(
      !(await isSurfpool()),
      "requires Surfpool (surfnet_timeTravel to pass market.deadline)",
    );
  });

  test("REDEEM via /portfolio: USDC restored 1:1 from YES; NO unchanged", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const fx = loadFixture();
    const conn = makeConnection();
    const user = loadTestKeypair();
    const creator = loadCreatorKeypair();
    const marketPda = new PublicKey(fx.marketPda);
    const usdcMint = new PublicKey(fx.usdcMint);
    const idBytes = marketIdBytes(fx);

    const yesMint = deriveYesMintPda(idBytes);
    const noMint = deriveNoMintPda(idBytes);
    const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey);
    const userYesAta = getAssociatedTokenAddressSync(yesMint, user.publicKey);
    const userNoAta = getAssociatedTokenAddressSync(noMint, user.publicKey);

    // Pre-condition 1: mint complete-set if market still Open.
    try {
      await mintCompleteSetViaAdapter({
        conn,
        signer: user,
        marketPda,
        marketId: idBytes,
        usdcMint,
        amount: MINT_AMOUNT,
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!msg.includes("MarketNotOpen") && !msg.includes("0x1770")) throw e;
    }

    // Pre-condition 2: settle the market with outcome=YES (idempotent).
    const swallow = (e: unknown) => {
      const msg = (e as Error).message ?? String(e);
      if (
        !msg.includes("MarketAlreadySettled") &&
        !msg.includes("AlreadyAttested") &&
        !msg.includes("MarketNotOpen") &&
        !msg.includes("custom program error")
      ) {
        throw e;
      }
    };
    try {
      await requestLockViaAdapter({ conn, authority: creator, marketPda });
    } catch (e) {
      swallow(e);
    }
    try {
      await attestOutcomeViaAdapter({
        conn,
        authority: creator,
        marketPda,
        winningOutcome: 1,
      });
      // attest_outcome does not settle; it opens the guardian-veto window.
      // The market stays Locked until settle is cranked after the window, so
      // the LIFECYCLE_SETTLED assertion below needs both steps.
      await waitForVetoWindow(conn, creator);
      await settleViaAdapter({ conn, payer: creator, marketPda });
    } catch (e) {
      swallow(e);
    }

    const m = await fetchMarket(conn, marketPda);
    expect(m?.lifecycle).toBe(LIFECYCLE_SETTLED);

    const yesBefore = (await getAccount(conn, userYesAta)).amount;
    const noBefore = (await getAccount(conn, userNoAta)).amount;
    const usdcBefore = (await getAccount(conn, userUsdcAta)).amount;
    console.log(
      `[spec-11] pre-redeem yes=${yesBefore} no=${noBefore} usdc=${usdcBefore}`,
    );

    // Drive REDEEM via the UI.
    await page.goto(`/portfolio`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      await w._connectTestWallet!();
    });

    await expect(page.getByTestId("complete-set-panel")).toBeVisible({
      timeout: 15_000,
    });
    // The amount input is shared mint/merge — redeem ignores it (the on-
    // chain ix uses the user's full YES balance) but Playwright doesn't
    // know that, so set a non-empty value to satisfy any UI gate.
    await page.getByTestId("complete-set-amount").fill("10");
    const redeemBtn = page.getByTestId("complete-set-redeem");
    await expect(redeemBtn).toBeEnabled({ timeout: 10_000 });
    await redeemBtn.click();

    // Poll for the burn.
    await expect
      .poll(
        async () => {
          try {
            return (await getAccount(conn, userYesAta)).amount;
          } catch {
            return -1n;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(0n);

    const noAfter = (await getAccount(conn, userNoAta)).amount;
    const usdcAfter = (await getAccount(conn, userUsdcAta)).amount;
    console.log(`[spec-11] post-redeem yes=0 no=${noAfter} usdc=${usdcAfter}`);

    // YES winner: only the winning side is burned + paid 1:1; NO untouched.
    expect(noAfter).toBe(noBefore);
    expect(usdcAfter - usdcBefore).toBe(yesBefore);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
