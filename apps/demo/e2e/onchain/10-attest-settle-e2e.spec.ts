// attest-settle-e2e — UI-driven via /portfolio OperatorActionsPanel.
//
// The OperatorActionsPanel only renders when the connected wallet is the
// per-market `Adjudicator.authority` (set to the creator keypair at
// register_adjudicator time, which fires inside seed-init's createMarket
// composition). The default test wallet is the user, not creator — so we
// use the test bridge's `_connectTestWalletAs(creatorBytes)` to swap the
// active LocalKeypair before driving the panel.
//
// Pre-condition (adapter-direct, signed by the user keypair, NOT under
// test): buy 10 YES so the redeem spec downstream has a position to
// burn. Idempotent against re-runs.
//
// Action under test (UI):
//   1. Navigate to /portfolio, swap-connect as creator.
//   2. Click REQUEST LOCK → Market.lifecycle: Open → Locked.
//   3. Click ATTEST YES → CPIs into sooth_market::settle:
//        Adjudicator.attested_outcome = Some(1)
//        Market.lifecycle: Locked → Settled
//        Market.winning_outcome = 1
//
// Verifications:
//   - Market.lifecycle == 3 (Settled)
//   - Market.winning_outcome == 1 (YES)
//   - Adjudicator.attested_outcome == 1
//
// Cleanup: swap-connect back to the user wallet so spec 11 (redeem) sees
// the standard authority.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { makeConnection, waitForOnChainChange } from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import {
  buyViaAdapter,
  loadTestKeypair,
  loadCreatorKeypair,
  derivePositionPda,
  deriveAdjudicatorPda,
  fetchMarket,
  fetchPosition,
  fetchAdjudicator,
} from "../helpers/sdk-helpers";

const TEN_SHARES_WAD = 10n * 10n ** 18n;
const LIFECYCLE_SETTLED = 3;
const LIFECYCLE_LOCKED = 2;
const WINNING_YES = 1;

function readKeypairBytes(filename: string): number[] {
  const path = resolve(__dirname, "..", "..", ".localnet", filename);
  return JSON.parse(readFileSync(path, "utf8")) as number[];
}

test.describe("attest + settle (UI-driven via OperatorActionsPanel)", () => {
  test("REQUEST LOCK → ATTEST YES via /portfolio: Market settled, winning=YES", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const TEST_PUBKEY = testPubkey();
    const idBytes = marketIdBytes(fixture);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const marketPda = new PublicKey(fixture.marketPda);

    const positionPda = derivePositionPda(idBytes, TEST_PUBKEY);
    const adjudicatorPda = deriveAdjudicatorPda(marketPda);

    // 1. Pre-condition: ensure user has ≥10 YES so spec 11 has shares to
    //    redeem. Adapter-direct, signed by the user keypair.
    const userSigner = loadTestKeypair();
    const posBefore = await fetchPosition(conn, positionPda);
    const yesBeforeBuy = posBefore?.yesShares ?? 0n;
    if (yesBeforeBuy < TEN_SHARES_WAD) {
      await buyViaAdapter({
        conn,
        signer: userSigner,
        marketPda,
        marketId: idBytes,
        usdcMint,
        outcome: 1,
        deltaShares: TEN_SHARES_WAD - yesBeforeBuy,
        maxCostWad: 6n * 10n ** 18n,
      });
      await waitForOnChainChange(
        async () => fetchPosition(conn, positionPda),
        (p) => (p?.yesShares ?? 0n) >= TEN_SHARES_WAD,
        30_000,
        500,
      );
    }

    // 2. Idempotent terminal-state check.
    const marketBefore = await fetchMarket(conn, marketPda);
    if (!marketBefore) throw new Error("market PDA missing on-chain");
    if (marketBefore.lifecycle === LIFECYCLE_SETTLED) {
      console.log(
        `[spec-10] market already Settled (winning=${marketBefore.winningOutcome}); idempotent terminal-state check`,
      );
      expect(marketBefore.winningOutcome).toBe(WINNING_YES);
      const adj = await fetchAdjudicator(conn, adjudicatorPda);
      expect(adj?.attestedOutcome).toBe(WINNING_YES);
      return;
    }

    // 3. Drive the operator panel as creator.
    await page.goto(`/portfolio`);
    await page.waitForLoadState("networkidle");
    const creatorBytes = readKeypairBytes("creator-keypair.json");
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
    }, creatorBytes);

    // OperatorActionsPanel renders only when isAuthority === true. Wait
    // for it before clicking. The wait also covers the auto-register
    // adjudicator hook firing for the creator wallet on connect.
    await expect(page.getByTestId("operator-actions-panel")).toBeVisible({
      timeout: 30_000,
    });

    // request_lock if needed
    const lockBtn = page.getByTestId("operator-request-lock");
    const m1 = await fetchMarket(conn, marketPda);
    if (m1!.lifecycle !== LIFECYCLE_LOCKED) {
      await expect(lockBtn).toBeEnabled({ timeout: 15_000 });
      await lockBtn.click();
      await waitForOnChainChange(
        async () => fetchMarket(conn, marketPda),
        (m) => m?.lifecycle === LIFECYCLE_LOCKED,
        30_000,
        500,
      );
    }

    // attest YES
    const attestBtn = page.getByTestId("operator-attest-yes");
    await expect(attestBtn).toBeEnabled({ timeout: 15_000 });
    await attestBtn.click();

    const marketAfter = await waitForOnChainChange(
      async () => fetchMarket(conn, marketPda),
      (m) => m?.lifecycle === LIFECYCLE_SETTLED,
      60_000,
      500,
    );
    expect(marketAfter!.lifecycle).toBe(LIFECYCLE_SETTLED);
    expect(marketAfter!.winningOutcome).toBe(WINNING_YES);

    const adjAfter = await fetchAdjudicator(conn, adjudicatorPda);
    expect(adjAfter).not.toBeNull();
    expect(adjAfter!.attestedOutcome).toBe(WINNING_YES);

    // Cleanup: swap back to the user wallet so spec 11 sees the
    // standard authority.
    const userBytes = readKeypairBytes("user-keypair.json");
    await page.evaluate(async (bytes) => {
      const w = window as unknown as {
        _connectTestWalletAs?: (b: number[]) => Promise<void>;
      };
      await w._connectTestWalletAs!(bytes);
    }, userBytes);
  });
});
