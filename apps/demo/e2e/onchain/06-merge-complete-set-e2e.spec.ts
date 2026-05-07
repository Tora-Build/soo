// merge-complete-set-e2e — adapter-direct.
//
// Inverse of 05-mint-complete-set. Same UI rationale: MintMergePanel is
// EVM-wired (uses chain-shim's useWriteContract → SoothBook contract path
// with no Solana branch), so the demo never surfaces this ix on Solana.
// Drive `sooth_market::merge_complete_set` directly to prove the protocol
// path.
//
// Pre-condition: mint 10 USDC worth of complete-set so YES + NO ATAs
// each carry 10·USDC base units before merge.
//
// Verifications:
//   1. user_yes_ata.amount drops to 0 (or back to its pre-mint baseline).
//   2. user_no_ata.amount drops to 0 (or back to its pre-mint baseline).
//   3. user USDC ATA balance increases by exactly 10·USDC.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { makeConnection, getTokenBalance } from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import {
  deriveYesMintPda,
  deriveNoMintPda,
  loadTestKeypair,
  mintCompleteSetViaAdapter,
  mergeCompleteSetViaAdapter,
} from "../helpers/sdk-helpers";

const TEN_USDC = 10_000_000n; // 10 USDC, 6 decimals

test.describe("merge complete-set (adapter-direct)", () => {
  test("merge 10 USDC: YES+NO outcome ATAs -= 10·USDC; USDC ATA += 10·USDC", async () => {
    test.setTimeout(60_000);
    const fixture = loadFixture();
    const conn = makeConnection();
    const TEST_PUBKEY = testPubkey();
    const idBytes = marketIdBytes(fixture);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const marketPda = new PublicKey(fixture.marketPda);

    const yesMint = deriveYesMintPda(idBytes);
    const noMint = deriveNoMintPda(idBytes);

    async function readOutcome(mint: PublicKey): Promise<bigint> {
      const ata = getAssociatedTokenAddressSync(mint, TEST_PUBKEY);
      try {
        const acc = await getAccount(conn, ata);
        return acc.amount;
      } catch {
        return 0n;
      }
    }

    // Pre-condition: mint 10 USDC of complete-set so we have YES+NO to
    // burn. Idempotent against re-runs that already left a balance.
    const signer = loadTestKeypair();
    await mintCompleteSetViaAdapter({
      conn,
      signer,
      marketPda,
      marketId: idBytes,
      usdcMint,
      amount: TEN_USDC,
    });

    const yesBefore = await readOutcome(yesMint);
    const noBefore = await readOutcome(noMint);
    const usdcBefore = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);
    // Sanity: pre-condition produced enough YES + NO to merge.
    expect(yesBefore).toBeGreaterThanOrEqual(TEN_USDC);
    expect(noBefore).toBeGreaterThanOrEqual(TEN_USDC);

    const sig = await mergeCompleteSetViaAdapter({
      conn,
      signer,
      marketPda,
      marketId: idBytes,
      usdcMint,
      amount: TEN_USDC,
    });
    expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,88}$/);

    const yesAfter = await readOutcome(yesMint);
    const noAfter = await readOutcome(noMint);
    const usdcAfter = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);

    expect(yesBefore - yesAfter).toBe(TEN_USDC);
    expect(noBefore - noAfter).toBe(TEN_USDC);
    expect(usdcAfter - usdcBefore).toBe(TEN_USDC);
  });
});
