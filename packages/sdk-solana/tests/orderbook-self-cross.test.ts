// Self-cross — one wallet crossing its own resting order.
//
// ⚠️  THIS IS A CHARACTERIZATION TEST. It documents what `develop` does today,
//     not what it should do. The policy question is open (see below), and
//     whichever way it is decided, this file is the thing that must change.
//
// Background — why this differs from EVM and from origin/main:
//
//   EVM   SoothBook.sol just writes the same storage mapping twice. A taker
//         crossing its own order is unremarkable.
//
//   main  sooth_market::fill_order declared taker_position and maker_position
//         as two separate `init_if_needed` accounts. When taker == maker both
//         resolve to the same PDA and Anchor fails with error 3002
//         (AccountDiscriminatorMismatch). Rather than restructure the fund
//         flow, commit 7943778 rejects the case outright at the matcher:
//           require_keys_neq!(maker, accounts.taker.key(), SelfCrossNotSupported)
//         (sooth_book/src/matching.rs:149-153, error 6019). Audit finding H2.
//
//   develop  The 5→1 merge replaced those two Anchor handles with raw
//         AccountInfo plus a hand-rolled loader, and mutate_position_shares
//         re-reads the account per call. Both legs therefore land correctly on
//         the single shared PDA and the 3002 collision is architecturally
//         unreachable. There is no guard anywhere in sooth-core — verified by
//         grep for SelfCross / require_keys_neq across the program.
//
// So the crash H2 worked around does not exist here. What was lost with it is
// the deliberate self-trade-prevention *policy* and its typed error.
//
// OPEN DECISION: allow self-cross (status quo, asserted below) or port main's
// rejection. That is a product call — wash trading / fake volume — not a bug
// fix, because as the second test shows no value can be extracted.
//
// If the decision is to reject: delete the first test, invert the second, and
// add SelfCrossNotSupported to the error enum + CLOB_ERROR in the fixture.

import { describe, expect, it } from "vitest";

import { orderbookPositionPda } from "../src/pdas.js";

import { bootSmoke } from "./fixtures/setup.js";
import {
  BASE_UNIT_WAD,
  SHARES,
  anchorProgram,
  buyTx,
  fetchBookSide,
  fetchPosition,
  fillBundle,
  initMarketFeePool,
  liveAmount,
  sendTx,
  usdcBalance,
} from "./fixtures/orderbook.js";

const MAKER_SIDE = 1;
const MAKER_TICK = 900;
const TAKER_SIDE = 0;
const TAKER_TICK = 999;

/** A YES+NO pair always redeems for one collateral unit, whatever the outcome,
 *  so SHARES of each is worth exactly this many USDC base units. */
const COMPLETE_SET_VALUE = SHARES / BASE_UNIT_WAD;

describe("orderbook self-cross (on-chain)", () => {
  it("currently succeeds, leaving the wallet holding a complete set", async () => {
    const smoke = await bootSmoke();
    const { ctx, marketId, programs } = smoke;
    const wallet = smoke.user; // same key acts as maker AND taker

    const program = anchorProgram(ctx, wallet);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    await sendTx(
      ctx,
      [wallet],
      await buyTx(program, smoke, {
        signer: wallet,
        side: MAKER_SIDE,
        tick: MAKER_TICK,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      }),
    );

    // The maker position and the taker position are the same PDA — this is the
    // collision main's H2 guard exists to avoid.
    const bundle = fillBundle(
      smoke,
      MAKER_SIDE,
      MAKER_TICK,
      wallet.publicKey,
    );
    const [positionPda] = orderbookPositionPda(
      marketId,
      wallet.publicKey,
      programs,
    );
    expect(bundle[1]!.toBase58()).toBe(positionPda.toBase58());

    await sendTx(
      ctx,
      [wallet],
      await buyTx(program, smoke, {
        signer: wallet,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: SHARES,
        matchLimit: 1,
        remaining: bundle,
      }),
    );

    // Both legs landed on the one position: the maker leg credited
    // taker_side ^ 1 (yes) and the taker leg credited taker_side (no).
    // Neither overwrote the other — mutate_position_shares re-reads the
    // account between calls.
    const position = await fetchPosition(program, positionPda);
    expect(position.yesShares.toString()).toBe(SHARES.toString());
    expect(position.noShares.toString()).toBe(SHARES.toString());

    // The resting order was consumed like any other.
    expect(liveAmount(await fetchBookSide(program, bundle[0]!))).toBe(0n);
  });

  it("extracts no value — the round trip costs at least the complete set is worth", async () => {
    // This is the assertion that actually matters for safety. Self-cross being
    // permitted is only acceptable while it stays unprofitable; a fee or
    // rounding regression that let a wallet mint a complete set for less than
    // its redemption value would be a live drain on the market vault. If this
    // test ever fails, the policy question stops being a product call.
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const wallet = smoke.user;

    const program = anchorProgram(ctx, wallet);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const usdcBefore = await usdcBalance(ctx, wallet.publicKey, smoke);

    await sendTx(
      ctx,
      [wallet],
      await buyTx(program, smoke, {
        signer: wallet,
        side: MAKER_SIDE,
        tick: MAKER_TICK,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      }),
    );
    await sendTx(
      ctx,
      [wallet],
      await buyTx(program, smoke, {
        signer: wallet,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: SHARES,
        matchLimit: 1,
        remaining: fillBundle(
          smoke,
          MAKER_SIDE,
          MAKER_TICK,
          wallet.publicKey,
        ),
      }),
    );

    const usdcAfter = await usdcBalance(ctx, wallet.publicKey, smoke);
    const spent = usdcBefore - usdcAfter;

    // Strictly more than the set is worth: the difference is the protocol fee.
    // Self-crossing is therefore a worse way to obtain a complete set than
    // mint_complete_set, which charges no fee.
    expect(spent).toBeGreaterThan(COMPLETE_SET_VALUE);
  });
});
