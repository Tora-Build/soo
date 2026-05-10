// claim-unlocked-e2e — UI-driven via /portfolio ClaimUnlockedPanel,
// gated on Surfpool for the wall-clock fast-forward.
//
// Sequencing:
//   1. Adapter-direct buy 10 NO + sell 5 NO to allocate a fresh LockEntry
//      PDA (carries proceeds + unlock_at = now + 86_400). Capture the
//      pre-sell lock_nonce so we know which CLAIM row to drive.
//   2. surfnet_timeTravel(+86_401s) bridges the lock window the bundled
//      solana-test-validator can't (no setClock RPC).
//   3. Navigate to /portfolio, connect the LocalKeypair adapter, wait for
//      the CompleteSet panel + Pending-Unlocks panel to mount.
//   4. Click `pending-unlocks-claim-${nonce}` — the UI closes the
//      LockEntry account and moves USDC.
//   5. Assert user_usdc_ata grew by LockEntry.amount_usdc, lock_vault
//      drained the same, LockEntry account closed.
//
// Gate: self-skips on stock test-validator. Cargo coverage at
// `programs-core/programs/sooth_amm/...` covers the protocol invariants
// (NotYetUnlocked, double-claim) regardless.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { makeConnection, getAccountData } from "../helpers/onchain";
import { loadFixture, marketIdBytes } from "../helpers/fixture";
import {
  buyViaAdapter,
  sellViaAdapter,
  loadTestKeypair,
  derivePositionPda,
  deriveLockAuthorityPda,
  fetchPosition,
  fetchLockEntry,
} from "../helpers/sdk-helpers";
import { isSurfpool, timeTravel } from "../helpers/surfpool";

const TEN_SHARES_WAD = 10n * 10n ** 18n;
const FIVE_SHARES_WAD = 5n * 10n ** 18n;
const LOCK_DURATION_SECS = 86_400;

test.describe("AMM claim_unlocked (UI-driven, Surfpool-gated)", () => {
  test.beforeAll(async () => {
    test.skip(
      !(await isSurfpool()),
      "requires Surfpool (surfnet_timeTravel cheatcode). Boot via `pnpm -F @sooth/demo dev:surfpool` and re-run.",
    );
  });

  test("buy → sell → time-travel 24h+1s → CLAIM via /portfolio drains LockEntry", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const signer = loadTestKeypair();
    const idBytes = marketIdBytes(fixture);
    const marketPda = new PublicKey(fixture.marketPda);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const positionPda = derivePositionPda(idBytes, signer.publicKey);
    const lockAuthority = deriveLockAuthorityPda(idBytes);
    const lockVault = getAssociatedTokenAddressSync(
      usdcMint,
      lockAuthority,
      true,
    );
    const userUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      signer.publicKey,
    );

    // 1) Buy 10 NO so the user has a position to sell.
    await buyViaAdapter({
      conn,
      signer,
      marketPda,
      marketId: idBytes,
      usdcMint,
      outcome: 0,
      deltaShares: TEN_SHARES_WAD,
      maxCostWad: 20n * 10n ** 18n,
    });

    // Capture the lock_nonce that this sell will consume — it becomes
    // the pending-unlocks row testid suffix in the UI.
    const posPreSell = await fetchPosition(conn, positionPda);
    if (!posPreSell) throw new Error("Position missing pre-sell");
    const sellNonce = String(posPreSell.lockNonce);

    // 2) Sell 5 NO — emits a LockEntry at the pre-sell lock_nonce.
    const { lockEntryPda } = await sellViaAdapter({
      conn,
      signer,
      marketPda,
      marketId: idBytes,
      usdcMint,
      outcome: 0,
      deltaShares: FIVE_SHARES_WAD,
    });

    const lockEntryBefore = await fetchLockEntry(conn, lockEntryPda);
    if (!lockEntryBefore) throw new Error("LockEntry missing post-sell");
    const lockedAmount = lockEntryBefore.amountUsdc;
    expect(lockedAmount).toBeGreaterThan(0n);

    const readBalance = (ata: PublicKey) =>
      conn.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount));
    const userUsdcBefore = await readBalance(userUsdcAta);
    const lockVaultBefore = await readBalance(lockVault);

    // 3) Surfpool fast-forward past unlock_at.
    await timeTravel(LOCK_DURATION_SECS + 1);

    // 4) Drive CLAIM via /portfolio's pending-unlocks panel.
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

    const claimBtn = page.getByTestId(`pending-unlocks-claim-${sellNonce}`);
    await expect(claimBtn).toBeVisible({ timeout: 30_000 });
    // Panel polls readPendingUnlocks every ~8s; READY label only renders
    // once the on-chain Clock is past unlock_at. Wait for the button to
    // enable rather than asserting on text.
    await expect(claimBtn).toBeEnabled({ timeout: 30_000 });
    await claimBtn.click();

    // 5) On-chain assertions: LockEntry closed, USDC moved.
    await expect
      .poll(async () => await getAccountData(conn, lockEntryPda), {
        timeout: 60_000,
      })
      .toBeNull();

    const userUsdcAfter = await readBalance(userUsdcAta);
    const lockVaultAfter = await readBalance(lockVault);
    expect(userUsdcAfter - userUsdcBefore).toBe(lockedAmount);
    expect(lockVaultBefore - lockVaultAfter).toBe(lockedAmount);

    // UI health invariants — see PR #3 + memory feedback_e2e_must_assert_ui_health.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);
  });
});
