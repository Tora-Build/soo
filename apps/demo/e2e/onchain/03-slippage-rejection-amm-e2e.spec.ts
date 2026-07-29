// slippage-rejection-amm-e2e — adapter-direct.
//
// Why adapter-direct: SimpleTradingPanel hard-codes `maxCostWad = quote.cost
// * 105 / 100` (5% buffer) before submitting `tradePositions`; there is no
// UI surface to make the slippage tighter. To exercise the on-chain
// `SlippageExceeded` (Anchor error 6000 — note the brief mentioned 6005 for
// MarketDismissed, the actual SlippageExceeded code is 6000 per the IDL),
// we drive the on-chain ix directly with `max_cost_wad = 1` (effectively
// zero ceiling against the LMSR cost of ~5 USDC for 10 shares).
//
// Verifications:
//   1. The submit promise rejects.
//   2. `getSignatureStatus(sig).value.err.InstructionError = [n, { Custom:
//      6000 }]` — decoded against the loaded IDL.
//   3. Position state is unchanged: `yes_shares` after == `yes_shares`
//      before.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import {
  makeConnection,
  getAccountData,
  readI128LE,
  decodeAnchorError,
} from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import { coreIdl, buyViaAdapter, loadTestKeypair } from "../helpers/sdk-helpers";

const POSITION_YES_SHARES_OFFSET = 72;
const SLIPPAGE_EXCEEDED_CODE = 6000;

test.describe("AMM buy slippage rejection (adapter-direct)", () => {
  test("buy with max_cost_wad=1 fails with SlippageExceeded; Position unchanged", async () => {
    test.setTimeout(60_000);
    const fixture = loadFixture();
    const conn = makeConnection();
    const TEST_PUBKEY = testPubkey();
    const idBytes = marketIdBytes(fixture);
    const ammProgramId = new PublicKey(fixture.soothAmmId);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const marketPda = new PublicKey(fixture.marketPda);

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pos"), idBytes, TEST_PUBKEY.toBuffer()],
      ammProgramId,
    );

    const beforeData = await getAccountData(conn, positionPda);
    const yesBefore = beforeData
      ? readI128LE(beforeData, POSITION_YES_SHARES_OFFSET)
      : 0n;

    const signer = loadTestKeypair();
    let caughtErr: unknown = null;
    let caughtSig: string | null = null;
    try {
      await buyViaAdapter({
        conn,
        signer,
        marketPda,
        marketId: idBytes,
        usdcMint,
        outcome: 1,
        deltaShares: 10n * 10n ** 18n,
        // 1 lamport — fewer than the LMSR cost of 10 shares ever, so the
        // on-chain `cost > max_cost_wad` check trips on the first ix.
        maxCostWad: 1n,
      });
    } catch (err) {
      caughtErr = err;
      // Anchor + web3.js surfaces the failure with `transactionLogs` and
      // sometimes a `signature` field on the inner error. Pull the
      // signature out of the message if present (substring match — same
      // pattern Anchor uses).
      const msg = String((err as Error)?.message ?? "");
      const m = msg.match(/Signature\s+([1-9A-HJ-NP-Za-km-z]{43,88})/);
      caughtSig = m?.[1] ?? null;
    }

    expect(caughtErr, "buyViaAdapter must reject").not.toBeNull();

    // Anchor surfaces `SlippageExceeded` either via:
    //   - simulation: SendTransactionError carrying logs that include
    //     "Error Code: SlippageExceeded" / "Error Number: 6000"
    //   - confirm: the tx lands but with the Custom error in receipt.err
    //
    // Both paths satisfy the spec; assert by the message (fast path) and
    // fall back to fetching the receipt if a sig was extracted.
    const errMsg = String((caughtErr as Error)?.message ?? "");
    const matchedByLogs =
      errMsg.includes("SlippageExceeded") ||
      errMsg.includes("0x1770") /* hex of 6000 */ ||
      errMsg.includes("6000");
    if (!matchedByLogs && caughtSig) {
      const status = await conn.getSignatureStatus(caughtSig, {
        searchTransactionHistory: true,
      });
      const decoded = decodeAnchorError(
        status.value?.err,
        coreIdl.errors as Array<{ code: number; name: string; msg: string }>,
      );
      expect(decoded?.code).toBe(SLIPPAGE_EXCEEDED_CODE);
      expect(decoded?.name).toBe("SlippageExceeded");
    } else {
      expect(
        matchedByLogs,
        `expected SlippageExceeded in error message; got: ${errMsg.slice(0, 400)}`,
      ).toBe(true);
    }

    // Position state must not have moved.
    const afterData = await getAccountData(conn, positionPda);
    const yesAfter = afterData
      ? readI128LE(afterData, POSITION_YES_SHARES_OFFSET)
      : 0n;
    expect(yesAfter).toBe(yesBefore);
  });
});
