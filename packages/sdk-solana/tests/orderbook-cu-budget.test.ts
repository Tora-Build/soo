// Resource budget for a crossing buy: compute units, writable accounts, and
// transaction wire size.
//
// This restores the contract of `sooth_book/tests/cu_measurement.rs`, which
// the 5→1 merge deleted — the only mechanical check on the resource envelope
// the merge was supposed to improve. Ported to the LiteSVM harness rather
// than restored verbatim: the original is 648 lines of Rust wired to five
// hardcoded program IDs that no longer exist.
//
// WHAT THE NUMBERS SAY (measured, escrowed makers = worst case, since each
// fill then also pays a vault → maker SPL transfer):
//
//   fills   CU        writable   bytes
//   1       ~78k      10         778
//   3       ~124k     16         976
//   5       ~199k     22         1174
//   6       —         —          1273  ← rejected, over PACKET_DATA_SIZE
//
// Byte figures include the sooth_log_program account added by the P0.1
// durable-event work (+33 bytes/tx, flat — the OrdersFilled payload itself
// rides in an INNER instruction and does not count against the outer
// transaction). That left 58 bytes of headroom at the 5-fill maximum.
//
// Three conclusions, all of which correct the received picture:
//
// 1. The 256 KB allocator (lib.rs) moved the ceiling from 3 fills to 5. Before
//    it, a 4-fill buy died with "memory allocation failed, out of memory" on
//    the stock 32 KB heap while using only ~16% of the CU budget.
//
// 2. The binding constraint is now TRANSACTION SIZE, not compute and not the
//    writable-account budget. At the 5-fill maximum we are at 14% of the CU
//    budget and 22 writable accounts. Each additional fill costs ~99 bytes
//    (3 accounts × 32, plus index bytes), so the 1232-byte packet limit bites
//    first.
//
// 3. Marginal cost is 3 writable accounts per fill, not the 6 that
//    docs/spec/sooth_book.md §13 Q2 assumes. MarketBook, the taker position
//    and the market vault are shared across fills rather than per-fill. The
//    spec's "~3.7 fills per transaction" figure is derived from that 6 and is
//    therefore wrong in both directions: the mechanism is size, not locks.
//
// CU varies a few percent run to run because bootSmoke randomizes market_id,
// so find_program_address needs a different number of bump iterations. Treat
// logged values as indicative and the ceilings as the contract.

import { describe, expect, it } from "vitest";

import { bootSmoke } from "./fixtures/setup.js";
import {
  BASE_UNIT_WAD,
  MAX_TX_BYTES,
  SHARES,
  anchorProgram,
  buyTx,
  createFundedMaker,
  fillBundle,
  initMarketFeePool,
  mintCompleteSetForOrderbook,
  sendTx,
  sendTxMeasured,
} from "./fixtures/orderbook.js";

// Inherited from the deleted cu_measurement.rs so a regression trips where it
// would have on main.
const CU_CEILING = 800_000;
const WRITABLE_CEILING = 28;

/** Deepest cross that fits in one transaction. */
const MAX_FILLS_PER_TX = 5;

const MAKER_SIDE = 1;
const TAKER_SIDE = 0;
const TAKER_TICK = 950;

/** Collateral each maker deposits to hold shares for an escrowed order. */
const MAKER_SET_BASE_UNITS = SHARES / BASE_UNIT_WAD;

/** Rest `count` escrowed makers on descending ticks and return their fill
 *  bundles in bitmap-consumption order. */
async function restEscrowedMakers(smoke: any, program: any, count: number) {
  const { ctx } = smoke;
  const makers = [];
  for (let i = 0; i < count; i++) {
    const tick = 900 - i * 10;
    const maker = await createFundedMaker(smoke, 100_000n);
    await mintCompleteSetForOrderbook(
      ctx,
      program,
      smoke,
      maker,
      MAKER_SET_BASE_UNITS,
    );
    await sendTx(
      ctx,
      [maker],
      await buyTx(program, smoke, {
        signer: maker,
        side: MAKER_SIDE,
        tick,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
        escrow: true,
      }),
    );
    makers.push({ maker, tick });
  }
  return makers.flatMap(({ maker, tick }) =>
    fillBundle(smoke, MAKER_SIDE, tick, maker.publicKey),
  );
}

describe("orderbook resource budget", () => {
  it("the 5-fill maximum stays inside every ceiling", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const taker = smoke.user;
    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const bundles = await restEscrowedMakers(smoke, program, MAX_FILLS_PER_TX);

    const cost = await sendTxMeasured(
      ctx,
      [taker],
      await buyTx(program, smoke, {
        signer: taker,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: BigInt(MAX_FILLS_PER_TX) * SHARES,
        matchLimit: MAX_FILLS_PER_TX,
        remaining: bundles,
      }),
    );

    console.log(`SOOTH_CORE_5_FILL_CU=${cost.computeUnits}`);
    console.log(`SOOTH_CORE_5_FILL_WRITABLE=${cost.writableAccounts}`);
    console.log(`SOOTH_CORE_5_FILL_BYTES=${cost.serializedBytes}`);

    expect(cost.computeUnits).toBeGreaterThan(0);
    expect(cost.computeUnits).toBeLessThanOrEqual(CU_CEILING);
    expect(cost.writableAccounts).toBeLessThanOrEqual(WRITABLE_CEILING);
    expect(cost.serializedBytes).toBeLessThanOrEqual(MAX_TX_BYTES);
  }, 60_000);

  it("records the 3-fill and single-fill baselines", async () => {
    for (const fills of [1, 3]) {
      const smoke = await bootSmoke();
      const { ctx } = smoke;
      const taker = smoke.user;
      const program = anchorProgram(ctx, taker);
      await initMarketFeePool(ctx, program, smoke, smoke.creator);

      const bundles = await restEscrowedMakers(smoke, program, fills);
      const cost = await sendTxMeasured(
        ctx,
        [taker],
        await buyTx(program, smoke, {
          signer: taker,
          side: TAKER_SIDE,
          tick: TAKER_TICK,
          amount: BigInt(fills) * SHARES,
          matchLimit: fills,
          remaining: bundles,
        }),
      );

      console.log(
        `SOOTH_CORE_${fills}_FILL cu=${cost.computeUnits} writable=${cost.writableAccounts} bytes=${cost.serializedBytes}`,
      );
      expect(cost.computeUnits).toBeLessThanOrEqual(CU_CEILING);
      expect(cost.serializedBytes).toBeLessThanOrEqual(MAX_TX_BYTES);
    }
  }, 60_000);

  // ⚠️ CHARACTERIZATION. Pins WHY the ceiling is 5 so a future change that
  // moves it is deliberate. If this starts failing because 6 fills fit, that
  // is progress — update MAX_FILLS_PER_TX and the table above.
  it("6 fills exceed the 1232-byte packet limit", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const taker = smoke.user;
    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const bundles = await restEscrowedMakers(smoke, program, 6);

    // web3.js enforces PACKET_DATA_SIZE at serialization, which is the same
    // limit the cluster enforces on the wire.
    await expect(
      sendTxMeasured(
        ctx,
        [taker],
        await buyTx(program, smoke, {
          signer: taker,
          side: TAKER_SIDE,
          tick: TAKER_TICK,
          amount: 6n * SHARES,
          matchLimit: 6,
          remaining: bundles,
        }),
      ),
    ).rejects.toThrow(/Transaction too large: \d+ > 1232/);
  }, 60_000);
});
