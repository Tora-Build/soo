// mint-complete-set-e2e — adapter-direct.
//
// Why adapter-direct: apps/demo/src/components/features/pro/MintMergePanel
// is wired against the EVM SoothBook contract via the chain-shim's
// useReadContracts/useWriteContract — it has no Solana branch. The Solana
// demo therefore exposes no UI for `sooth_market::mint_complete_set`. We
// drive the on-chain ix directly to prove the protocol path.
//
// Verifications:
//   1. user_yes_ata.amount and user_no_ata.amount each grow by 10·USDC
//      base units (10_000_000 with 6 decimals).
//   2. user USDC ATA balance drops by exactly 10·USDC.

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
} from "../helpers/sdk-helpers";

const TEN_USDC = 10_000_000n; // 10 USDC, 6 decimals

test.describe("mint complete-set (adapter-direct)", () => {
  test("mint 10 USDC: YES + NO outcome ATAs each += 10·USDC; USDC ATA -= 10·USDC", async () => {
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

    const yesBefore = await readOutcome(yesMint);
    const noBefore = await readOutcome(noMint);
    const usdcBefore = await getTokenBalance(conn, usdcMint, TEST_PUBKEY);

    const signer = loadTestKeypair();
    const sig = await mintCompleteSetViaAdapter({
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

    expect(yesAfter - yesBefore).toBe(TEN_USDC);
    expect(noAfter - noBefore).toBe(TEN_USDC);
    expect(usdcBefore - usdcAfter).toBe(TEN_USDC);
  });
});
