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
import { isSurfpool, timeTravel } from "../helpers/surfpool";

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

    // Compute the absolute target as seconds since epoch and warp via
    // surfnet_timeTravel directly (the helper computes a delta from
    // wall-clock now; for an absolute we'd want to swap to a slot-based
    // call but the timestamp form is sufficient when we're warping into
    // the future).
    const nowSec = Math.floor(Date.now() / 1000);
    const targetSec = Number(market.deadline) + 1;
    const delta = targetSec - nowSec;
    if (delta <= 0) {
      // Seeded market is already expired (test-validator clock drift, or
      // a rerun after a previous timeTravel). Push a small forward step
      // to force the post-deadline branch.
      await timeTravel(60);
    } else {
      await timeTravel(delta);
    }

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
