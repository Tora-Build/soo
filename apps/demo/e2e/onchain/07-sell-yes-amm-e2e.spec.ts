// sell-yes-amm-e2e — UI-driven sell against a pre-seeded buy.
//
// Pre-condition (adapter-direct, NOT the action under test): buy 10 YES
// shares so the user has a position to sell. The setup path is the same
// `sooth_core::trade_positions` ix the 00-buy spec exercises via the UI;
// driving it here through `buyViaAdapter` keeps this spec focused on the
// sell-side assertions.
//
// UI action: navigate to /amm/<marketPda>, _connectTestWallet, switch to
// SELL mode (`trade-mode-sell`), enter "5", click `sell-button`. The shim
// in apps/demo/src/lib/chain-shim/amm-bridge.ts routes the EVM
// `tradePositions` call with negative deltaShares to `buildSell` →
// `sooth_core::sell_positions` ix, which:
//   - decrements Position.yes_shares by 5·WAD,
//   - allocates a fresh LockEntry PDA at seeds [b"lock_entry", positionPda,
//     position.lock_nonce.to_le_bytes()] under sooth_core::ID, populated
//     with proceeds + unlock_at = now + LOCK_DURATION_SECS (86_400).
//
// Verifications (post-sell):
//   - Position.yes_shares decreased by exactly 5·WAD.
//   - LockEntry PDA at the pre-sell lock_nonce now exists (account size > 0).
//   - LockEntry.amount_usdc > 0 (proceeds were locked, not zero).
//   - lock_vault USDC balance increased by LockEntry.amount_usdc.
//   - market_vault USDC balance decreased by locked proceeds plus market fee.
//   - LockEntry.unlock_at is approximately now + 86_400 seconds (within
//     a 60s tolerance for slot-time skew).

import { test, expect, type Page } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  makeConnection,
  getAccountData,
  getTokenBalance,
  readI128LE,
  waitForOnChainChange,
} from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import {
  buyViaAdapter,
  loadTestKeypair,
  derivePositionPda,
  deriveLockEntryPda,
  deriveVaultAuthorityPda,
  deriveLockAuthorityPda,
  deriveMarketFeePoolPda,
  fetchPosition,
  fetchLockEntry,
} from "../helpers/sdk-helpers";

const POSITION_YES_SHARES_OFFSET = 72;
const TEN_SHARES_WAD = 10n * 10n ** 18n;
const FIVE_SHARES_WAD = 5n * 10n ** 18n;
const LOCK_DURATION_SECS = 86_400n;

async function installTxCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type W = Record<string, unknown>;
    (window as unknown as W).__lastSig = null;
    const origFetch = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const init = args[1];
      const body = typeof init?.body === "string" ? init.body : "";
      const isSendTx = body.includes('"sendTransaction"');
      const res = await origFetch(...args);
      if (isSendTx) {
        try {
          const clone = res.clone();
          const json = (await clone.json()) as { result?: string };
          if (json.result) (window as unknown as W).__lastSig = json.result;
        } catch {
          /* ignore */
        }
      }
      return res;
    };
  });
}

test.describe("AMM sell-yes (UI-driven, adapter-direct buy as setup)", () => {
  test("sell 5 YES via UI: yes_shares -= 5·WAD, LockEntry created, vaults rebalanced", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const TEST_PUBKEY = testPubkey();
    const idBytes = marketIdBytes(fixture);
    const ammProgramId = new PublicKey(fixture.soothAmmId);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const marketPda = new PublicKey(fixture.marketPda);

    const positionPda = derivePositionPda(idBytes, TEST_PUBKEY);
    const vaultAuthority = deriveVaultAuthorityPda(idBytes);
    const lockAuthority = deriveLockAuthorityPda(idBytes);
    const marketVault = getAssociatedTokenAddressSync(
      usdcMint,
      vaultAuthority,
      true,
    );
    const marketFeePool = deriveMarketFeePoolPda(idBytes);
    const lockVault = getAssociatedTokenAddressSync(
      usdcMint,
      lockAuthority,
      true,
    );

    // 1. Pre-condition: buy 10 YES via adapter so there's a position.
    const signer = loadTestKeypair();
    const beforeBuy = await fetchPosition(conn, positionPda);
    const yesBeforeBuy = beforeBuy?.yesShares ?? 0n;
    await buyViaAdapter({
      conn,
      signer,
      marketPda,
      marketId: idBytes,
      usdcMint,
      outcome: 1,
      deltaShares: TEN_SHARES_WAD,
      // Generous max-cost cap (~6 USDC = 6·1e18 WAD) — covers 10 YES at
      // b=1000 USDC + 1% fee under any reasonable starting price.
      maxCostWad: 6n * 10n ** 18n,
    });
    const afterBuy = await waitForOnChainChange(
      async () => fetchPosition(conn, positionPda),
      (p) => (p?.yesShares ?? 0n) >= yesBeforeBuy + TEN_SHARES_WAD,
      30_000,
      500,
    );
    const yesAfterBuy = afterBuy!.yesShares;
    const lockNoncePreSell = afterBuy!.lockNonce;

    // 2. Snapshot vault balances + LockEntry PDA target before sell.
    const lockEntryPda = deriveLockEntryPda(positionPda, lockNoncePreSell);
    const lockEntryInfoBefore = await conn.getAccountInfo(lockEntryPda);
    expect(lockEntryInfoBefore).toBeNull();
    const marketVaultBefore = await conn
      .getTokenAccountBalance(marketVault)
      .then((r) => BigInt(r.value.amount));
    const lockVaultBefore = await conn
      .getTokenAccountBalance(lockVault)
      .then((r) => BigInt(r.value.amount))
      .catch(() => 0n);
    const marketFeePoolBefore = await conn
      .getTokenAccountBalance(marketFeePool)
      .then((r) => BigInt(r.value.amount))
      .catch(() => 0n);

    // 3. Browser instrumentation + navigate.
    await installTxCapture(page);
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.goto(`/amm/${marketPda.toBase58()}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet)
        throw new Error("_connectTestWallet not exposed");
      await w._connectTestWallet();
    });

    await expect(page.getByTestId("trading-panel")).toBeVisible({
      timeout: 15_000,
    });

    // 4. YES outcome (default), then SELL mode.
    await page.getByTestId("outcome-yes").click();
    await page.getByTestId("trade-mode-sell").click();

    // 5. Enter 5 shares, wait for sell quote to populate, then click SELL.
    await page.getByTestId("shares-input").fill("5");
    await expect
      .poll(
        async () => (await page.getByTestId("quote-cost").textContent()) ?? "",
        { timeout: 30_000 },
      )
      .toMatch(/\$\d+\.\d/);

    const sellButton = page.getByTestId("sell-button");
    await expect(sellButton).toBeEnabled({ timeout: 30_000 });
    await sellButton.click();

    // 6. Wait for Position.yes_shares to decrease by exactly 5·WAD.
    const yesAfter = await waitForOnChainChange(
      async () => {
        const data = await getAccountData(conn, positionPda);
        return data ? readI128LE(data, POSITION_YES_SHARES_OFFSET) : 0n;
      },
      (v) => v <= yesAfterBuy - FIVE_SHARES_WAD,
      90_000,
      1500,
    );
    expect(yesAfterBuy - yesAfter).toBe(FIVE_SHARES_WAD);

    // 7. LockEntry PDA was created at lockNoncePreSell.
    const lockEntry = await fetchLockEntry(conn, lockEntryPda);
    expect(lockEntry).not.toBeNull();
    expect(lockEntry!.user.equals(TEST_PUBKEY)).toBe(true);
    expect(lockEntry!.market.equals(marketPda)).toBe(true);
    expect(lockEntry!.amountUsdc).toBeGreaterThan(0n);

    // 8. lock_vault gained, market_vault lost the same amount.
    const marketVaultAfter = await conn
      .getTokenAccountBalance(marketVault)
      .then((r) => BigInt(r.value.amount));
    const lockVaultAfter = await conn
      .getTokenAccountBalance(lockVault)
      .then((r) => BigInt(r.value.amount));
    const marketFeePoolAfter = await conn
      .getTokenAccountBalance(marketFeePool)
      .then((r) => BigInt(r.value.amount));
    const marketFeeDelta = marketFeePoolAfter - marketFeePoolBefore;
    expect(lockVaultAfter - lockVaultBefore).toBe(lockEntry!.amountUsdc);
    expect(marketVaultBefore - marketVaultAfter).toBe(
      lockEntry!.amountUsdc + marketFeeDelta,
    );

    // 9. unlock_at ≈ now + 86_400; allow ±60s for slot-time skew.
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expectedUnlock = nowSec + LOCK_DURATION_SECS;
    const skew =
      lockEntry!.unlockAt > expectedUnlock
        ? lockEntry!.unlockAt - expectedUnlock
        : expectedUnlock - lockEntry!.unlockAt;
    expect(skew).toBeLessThanOrEqual(60n);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);

    // eslint-disable-next-line no-console
    console.log(
      `[spec-07] sold 5 YES; locked=${lockEntry!.amountUsdc} unlock_at=${lockEntry!.unlockAt}` +
        ` consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`,
    );
  });
});
