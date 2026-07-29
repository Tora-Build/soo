// Compute-unit and writable-account budget for a crossing buy.
//
// This restores the contract of `sooth_book/tests/cu_measurement.rs`, which
// the 5→1 merge deleted. It was the ONLY mechanical check on the resource
// envelope the merge was supposed to improve, so without it nobody can say
// whether collapsing the programs bought any headroom — the instrument was
// removed before the reading was taken.
//
// Ported to bankrun rather than restored verbatim: the original is 648 lines
// of LiteSVM wired to five hardcoded program IDs (BOOK/MARKET/AMM/LAUNCHPAD/
// LOG) and hand-written account state. Those IDs no longer exist. The
// assertions are what matter, and they carry over exactly.
//
// Ceilings are inherited from the original so a regression trips at the same
// point it would have on main:
//
//   CU_CEILING = 800_000              against a 1.4M per-tx budget
//   WRITABLE_CEILING = 28             of the ~32 lockable accounts per tx
//
// The writable ceiling is the one that actually binds. Per
// docs/spec/sooth_book.md §13 Q2 a fill costs 6 writable accounts, which is
// what caps matching at ~3.7 fills per transaction and forces the multi-tx
// driver. Compute was never close.
//
// Worst case = escrowed makers. On the escrow path each fill also transfers
// vault → maker USDC (fill_order_internal), so three escrowed makers cost
// three SPL CPIs the non-escrow path does not pay.

import { describe, expect, it } from "vitest";

import { bootSmoke } from "./fixtures/setup.js";
import {
  BASE_UNIT_WAD,
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

const CU_CEILING = 800_000;
const WRITABLE_CEILING = 28;

// Measured on develop @ the 5→1 merge, for reference when judging what the
// event pipeline (sooth_log + batched OrdersFilled) costs once it lands:
//
//   1 fill   ~85-105k CU, 10 writable
//   3 fills  ~165-185k CU, 16 writable
//   4 fills  heap OOM (see the last test)
//
// Marginal cost is ~3 writable accounts per additional fill, not the 6 the
// spec's §13 Q2 arithmetic assumes — MarketBook, the taker position and the
// market vault are shared across fills rather than per-fill.
//
// CU varies ~10% run to run: bootSmoke randomizes market_id, so
// find_program_address needs a different number of bump iterations each time.
// Treat the logged values as indicative and the ceilings as the contract.

const MAKER_SIDE = 1;
const TAKER_SIDE = 0;
const TAKER_TICK = 950;
const MAKER_TICKS = [900, 850, 800];

/** Collateral each maker deposits to hold shares for an escrowed order. */
const MAKER_SET_BASE_UNITS = SHARES / BASE_UNIT_WAD;

describe("orderbook CU + writable-account budget", () => {
  it("3-fill worst case stays inside the CU and writable ceilings", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const taker = smoke.user;
    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    // Three escrowed makers, one per tick — the expensive path.
    const makers = [];
    for (const tick of MAKER_TICKS) {
      const maker = await createFundedMaker(smoke, 10_000n);
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

    // Bundles in bitmap-descending consumption order: 900, 850, 800.
    const bundles = makers.flatMap(({ maker, tick }) =>
      fillBundle(smoke, MAKER_SIDE, tick, maker.publicKey),
    );

    const cost = await sendTxMeasured(
      ctx,
      [taker],
      await buyTx(program, smoke, {
        signer: taker,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: 3n * SHARES,
        matchLimit: 3,
        remaining: bundles,
      }),
    );

    // Recorded so the numbers are visible in CI output, not just the pass/fail.
    // These are the baseline for judging what the event pipeline costs when it
    // lands (sooth_log + batched OrdersFilled).
    console.log(`SOOTH_CORE_3_FILL_WORST_CASE_CU=${cost.computeUnits}`);
    console.log(
      `SOOTH_CORE_3_FILL_WRITABLE_ACCOUNTS=${cost.writableAccounts}`,
    );

    expect(cost.computeUnits).toBeGreaterThan(0);
    expect(cost.computeUnits).toBeLessThanOrEqual(CU_CEILING);
    expect(cost.writableAccounts).toBeLessThanOrEqual(WRITABLE_CEILING);
  });

  it("records the single-fill baseline", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const taker = smoke.user;
    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const maker = await createFundedMaker(smoke, 10_000n);
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
        tick: 900,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
        escrow: true,
      }),
    );

    const cost = await sendTxMeasured(
      ctx,
      [taker],
      await buyTx(program, smoke, {
        signer: taker,
        side: TAKER_SIDE,
        tick: TAKER_TICK,
        amount: SHARES,
        matchLimit: 1,
        remaining: fillBundle(smoke, MAKER_SIDE, 900, maker.publicKey),
      }),
    );

    console.log(`SOOTH_CORE_1_FILL_BASELINE_CU=${cost.computeUnits}`);
    console.log(`SOOTH_CORE_1_FILL_WRITABLE_ACCOUNTS=${cost.writableAccounts}`);

    expect(cost.computeUnits).toBeGreaterThan(0);
    expect(cost.computeUnits).toBeLessThanOrEqual(CU_CEILING);
  });

  // ⚠️ CHARACTERIZATION. Documents the ceiling as it stands, not as it should
  // be. If this test starts failing because 4 fills now succeed, that is
  // progress — update the documented ceiling rather than restoring the limit.
  //
  // Measured: a 4-fill buy dies with "memory allocation failed, out of memory"
  // at ~226k CU (16% of the 1.4M budget) and ~19 writable accounts (of ~32).
  // So neither compute nor the writable budget is what binds on develop today
  // — the 32 KB BPF heap is. Its bump allocator never frees mid-instruction,
  // so per-fill allocations accumulate until the 4th fill exhausts it.
  //
  // main does not have this ceiling: beb6900 installed a 256 KB
  // BumpAllocator256 as #[global_allocator] on sooth_book, which the 5→1 merge
  // dropped. Porting it is therefore not only an event-pipeline prerequisite
  // (P0.1) — it is what currently caps matching depth at 3.
  it("4 fills currently exhaust the 32 KB BPF heap", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const taker = smoke.user;
    const program = anchorProgram(ctx, taker);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const ticks = [900, 875, 850, 825];
    const makers = [];
    for (const tick of ticks) {
      const maker = await createFundedMaker(smoke, 10_000n);
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

    const bundles = makers.flatMap(({ maker, tick }) =>
      fillBundle(smoke, MAKER_SIDE, tick, maker.publicKey),
    );

    await expect(
      sendTxMeasured(
        ctx,
        [taker],
        await buyTx(program, smoke, {
          signer: taker,
          side: TAKER_SIDE,
          tick: TAKER_TICK,
          amount: 4n * SHARES,
          matchLimit: 4,
          remaining: bundles,
        }),
      ),
    ).rejects.toThrow(/memory allocation failed, out of memory/);
  });
});
