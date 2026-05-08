// claim-unlocked-e2e — adapter-direct round-trip, gated on Surfpool.
//
// Sequencing:
//   1. Buy 10 YES via the adapter (puts YES shares on the user's Position).
//   2. Sell 5 YES via the adapter (decrements yes_shares, allocates a fresh
//      LockEntry PDA carrying the proceeds + unlock_at = now + 86_400).
//   3. Surfpool `surfnet_timeTravel(+86_401s)` — bridges the lock window the
//      bundled solana-test-validator can't, since it has no setClock RPC.
//   4. Claim via the adapter against the LockEntry: assert user_usdc_ata
//      grew by LockEntry.amount_usdc, lock_vault drained, LockEntry account
//      closed (lamports → 0).
//
// On stock test-validator the `isSurfpool()` probe returns false and the
// describe block self-skips with a pointer to `pnpm dev:surfpool`. The
// program-level invariants (claim before unlock_at → NotYetUnlocked,
// double-claim rejection) are still covered by
// `packages/sdk-solana/tests/claim-flow.test.ts` against bankrun.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { makeConnection, getAccountData } from "../helpers/onchain";
import { loadFixture, marketIdBytes } from "../helpers/fixture";
import {
  buyViaAdapter,
  sellViaAdapter,
  claimUnlockedViaAdapter,
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

test.describe("AMM claim_unlocked (adapter-direct, Surfpool-gated)", () => {
  test.beforeAll(async () => {
    test.skip(
      !(await isSurfpool()),
      "requires Surfpool (surfnet_timeTravel cheatcode). Boot via `pnpm -F @sooth/demo dev:surfpool` and re-run, or trust the bankrun coverage at packages/sdk-solana/tests/claim-flow.test.ts.",
    );
  });

  test("buy → sell → time-travel 24h+1s → claim drains LockEntry", async () => {
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

    // Capture starting position — earlier specs accumulate shares on the
    // same wallet, so absolute-value assertions don't hold. The buy/sell
    // below use `outcome: 0` (NO), so we track noShares.
    const posBefore = await fetchPosition(conn, positionPda);
    const noSharesBefore = posBefore?.noShares ?? 0n;

    // 1) Buy 10 YES so the user has a position to sell. Cost ceiling is
    //    20·WAD — well above the LMSR price for 10 shares at p≈0.5.
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

    // 2) Sell 5 YES — emits a LockEntry at the pre-sell lock_nonce.
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
    expect(lockVaultBefore).toBeGreaterThanOrEqual(lockedAmount);

    // 3) Fast-forward past unlock_at. +1s margin so the program-side
    //    `now >= unlock_at` check is unambiguously true.
    await timeTravel(LOCK_DURATION_SECS + 1);

    // 4) Claim via the adapter — closes LockEntry, moves USDC.
    await claimUnlockedViaAdapter({
      conn,
      signer,
      marketPda,
      marketId: idBytes,
      usdcMint,
      lockEntryPda,
    });

    const lockEntryAfter = await getAccountData(conn, lockEntryPda);
    expect(lockEntryAfter).toBeNull(); // account closed (lamports → 0)

    const userUsdcAfter = await readBalance(userUsdcAta);
    const lockVaultAfter = await readBalance(lockVault);
    expect(userUsdcAfter - userUsdcBefore).toBe(lockedAmount);
    expect(lockVaultBefore - lockVaultAfter).toBe(lockedAmount);

    // Sanity: Position survives — only LockEntry was closed. Net delta
    // from this spec is +10 buy then -5 sell = +5 NO against the prior
    // noShares value.
    const posAfter = await fetchPosition(conn, positionPda);
    if (!posAfter) throw new Error("Position closed unexpectedly");
    expect(posAfter.noShares).toBe(
      noSharesBefore + TEN_SHARES_WAD - FIVE_SHARES_WAD,
    );
  });
});
