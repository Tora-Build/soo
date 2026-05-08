// trading-window-e2e — post-deadline guard, gated on Surfpool.
//
// Sequencing:
//   1. Read Market.deadline from the seeded market PDA.
//   2. Time-travel past `deadline + 1`.
//   3. Try to buy via the adapter — assert the ix fails with the
//      `TradingClosed` error from sooth_amm/src/error.rs:40
//      ("Trading window has closed (now >= deadline)").
//
// On stock test-validator the `isSurfpool()` probe returns false and the
// describe block self-skips. The cargo unit tests at
// `packages/programs-core/programs/sooth_amm/src/instructions/
// trade_positions.rs` cover both halves of the C1 guard with synthetic
// Clock sysvars; this spec adds the runtime-against-canonical-.so layer.

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection } from "../helpers/onchain";
import { loadFixture, marketIdBytes } from "../helpers/fixture";
import {
  buyViaAdapter,
  loadTestKeypair,
  fetchMarket,
} from "../helpers/sdk-helpers";
import { isSurfpool, timeTravelToTimestamp } from "../helpers/surfpool";

const ONE_SHARE_WAD = 10n ** 18n;

test.describe("AMM trading-window guard (Surfpool-gated)", () => {
  test.beforeAll(async () => {
    test.skip(
      !(await isSurfpool()),
      "requires Surfpool (surfnet_timeTravel cheatcode). Boot via `pnpm -F @sooth/demo dev:surfpool` and re-run, or trust the cargo coverage at programs-core/programs/sooth_amm/src/instructions/trade_positions.rs.",
    );
  });

  test("buy past Market.deadline rejects with TradingClosed", async () => {
    test.setTimeout(120_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const signer = loadTestKeypair();
    const idBytes = marketIdBytes(fixture);
    const marketPda = new PublicKey(fixture.marketPda);
    const usdcMint = new PublicKey(fixture.usdcMint);

    const market = await fetchMarket(conn, marketPda);
    if (!market) throw new Error("Market PDA missing in fixture");

    // Jump the on-chain Clock to deadline+1 (absolute UNIX seconds).
    // surfnet_timeTravel rejects past targets, so the spec only works
    // when the on-chain clock is at-or-before deadline. Spec 08 advances
    // by 24h+1s, which still leaves us ~6 days before deadline (deadline
    // = startTime + 7d), so this jump is forward-only either way.
    await timeTravelToTimestamp(Number(market.deadline) + 1);

    let failed = false;
    let errMsg = "";
    try {
      await buyViaAdapter({
        conn,
        signer,
        marketPda,
        marketId: idBytes,
        usdcMint,
        outcome: 0,
        deltaShares: ONE_SHARE_WAD,
        maxCostWad: 5n * 10n ** 18n, // generous ceiling — we expect rejection on time
      });
    } catch (e) {
      failed = true;
      errMsg = (e as Error).message ?? String(e);
    }
    expect(failed).toBe(true);
    // sooth_amm error.rs `TradingClosed` is the variant; Anchor surfaces
    // it in the program log as "Trading window has closed" plus the
    // numeric error code. Either substring is sufficient signal.
    expect(
      errMsg.includes("TradingClosed") ||
        errMsg.includes("Trading window has closed"),
    ).toBe(true);
  });
});
