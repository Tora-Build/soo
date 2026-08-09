// The measurement the whole orderbook redesign rests on.
//
// docs/design/orderbook-redesign.md projects that consolidating the book into
// one zero-copy account takes a fill from *3 accounts + 99 transaction bytes +
// ~29,510 CU* down to *0 accounts + 0 bytes + an estimated 5,000-10,000 CU*,
// moving the ceiling from 5 fills per transaction to somewhere in the 50-150
// range. That estimate was reasoning, not measurement. This file measures it.
//
// The old numbers, from orderbook-cu-budget.test.ts on the same harness:
//
//   fills │ tx bytes │ writable │ CU
//   ──────┼──────────┼──────────┼─────────
//     1   │   778    │    10    │  66,708
//     3   │   976    │    16    │ 128,661
//     5   │  1174    │    22    │ 184,749
//     6   │  1273 → rejected (PACKET_DATA_SIZE = 1232)
//
// Marginal: 99 bytes, 3 writable accounts, ~29,510 CU per fill.
//
// This measures the FULL path including token movement. `book_place` nets the
// taker's collateral into at most one transfer each way plus one fee transfer,
// regardless of how many orders it crosses — so the SPL cost lands in the fixed
// term, not the marginal one. That netting is the whole reason the seat model
// exists.

import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { bootSmoke, SOOTH_CORE_ID } from "./fixtures/setup.js";
import {
  anchorProgram,
  countWritableAccounts,
  heapFrameIx,
  enableBook,
  initMarketFeePool,
} from "./fixtures/orderbook.js";
import { buildBookInit, buildBookPlace } from "../src/book/index.js";

const NIL = 0xffffffff;
const DISCRIMINATOR = Buffer.from([0x4b, 0x6f, 0x6f, 0x42, 0x00, 0x01, 0x00, 0x00]);
const HEADER_LEN = 128;
const BLOCKS_OFFSET = 8 + HEADER_LEN;
const BLOCK_SIZE = 64;

const SIDE_BID = 0;
const SIDE_ASK = 1;
const ONE_SHARE = 1_000_000n;

function bookPda(marketId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("book"), Buffer.from(marketId)],
    SOOTH_CORE_ID,
  )[0];
}

/** Build through the SDK, so what is measured is the real client path —
 *  including the `emit_cpi!` self-invocation that produces the fill event. */
function placeIx(
  smoke: any,
  _book: PublicKey,
  taker: PublicKey,
  side: number,
  tick: number,
  amount: bigint,
  _feeBps: number,
  matchLimit: number,
  postRemainder: boolean,
): TransactionInstruction {
  return buildBookPlace(
    {
      marketId: smoke.marketId,
      marketPda: smoke.marketPda,
      usdcMint: smoke.usdcMint,
      programs: smoke.programs,
    },
    taker,
    { side, limitTick: tick, amount, matchLimit, postRemainder },
  );
}

interface Measured {
  cu: number;
  bytes: number;
  writable: number;
  accounts: number;
}

async function boot(capacity: number) {
  const smoke = await bootSmoke();
  await initMarketFeePool(
    smoke.ctx,
    anchorProgram(smoke.ctx, smoke.creator),
    smoke,
    smoke.creator,
  );
  // Created by the real instruction, not hand-written, so the measurement runs
  // against an account the program produced.
  const refs = {
    marketId: smoke.marketId,
    marketPda: smoke.marketPda,
    usdcMint: smoke.usdcMint,
    programs: smoke.programs,
  };
  await send(
    smoke,
    smoke.creator,
    buildBookInit(refs, smoke.creator.publicKey, Math.min(capacity, 150)),
  );
  await enableBook(smoke.ctx, smoke);
  return { smoke, book: bookPda(smoke.marketId) };
}

async function send(
  smoke: any,
  signer: Keypair,
  ix: TransactionInstruction,
): Promise<Measured> {
  // The 256 KB heap frame is still mandatory, even though this path allocates
  // nothing: the custom #[global_allocator] is program-wide, so the caller
  // contract binds every instruction until the old borsh book is deleted.
  // Retiring it is one of the things Phase 3 buys.
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(heapFrameIx())
    .add(ix);
  const bh = await smoke.ctx.banksClient.getLatestBlockhash();
  tx.recentBlockhash = bh[0];
  tx.feePayer = signer.publicKey;
  tx.sign(signer);

  const res = await smoke.ctx.banksClient.tryProcessTransaction(tx);
  if (res.result !== null) {
    const logs = (res.meta?.logMessages ?? []).join("\n");
    throw new Error(`book_place failed: ${res.result}\n${logs}`);
  }
  const msg = tx.compileMessage();
  return {
    cu: Number(res.meta?.computeUnitsConsumed ?? 0),
    bytes: tx.serialize({ verifySignatures: false }).length,
    writable: countWritableAccounts(tx),
    accounts: msg.accountKeys.length,
  };
}

/** A keypair with SOL and a funded USDC ATA. */
async function funded(smoke: any): Promise<Keypair> {
  const kp = Keypair.generate();
  smoke.ctx.setAccount(kp.publicKey, {
    executable: false,
    owner: new PublicKey("11111111111111111111111111111111"),
    lamports: 10 * LAMPORTS_PER_SOL,
    data: Buffer.alloc(0),
  });
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: smoke.usdcMint,
      owner: kp.publicKey,
      amount: 1_000_000_000n,
      delegateOption: 0,
      delegate: PublicKey.default,
      delegatedAmount: 0n,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  smoke.ctx.setAccount(
    getAssociatedTokenAddressSync(smoke.usdcMint, kp.publicKey),
    {
      executable: false,
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      lamports: 10 * LAMPORTS_PER_SOL,
      data,
    },
  );
  return kp;
}

/** Rest `n` asks at descending-quality prices, each from a distinct maker. */
async function restMakers(smoke: any, book: PublicKey, n: number) {
  for (let i = 0; i < n; i++) {
    const maker = await funded(smoke);
    await send(
      smoke,
      maker,
      placeIx(smoke, book, maker.publicKey, SIDE_ASK, 400 + i, ONE_SHARE, 0, 0, true),
    );
  }
}

/** Live order count, read straight out of the account bytes. */
async function orderCount(smoke: any, book: PublicKey): Promise<number> {
  const acct = await smoke.ctx.banksClient.getAccount(book);
  return Buffer.from(acct!.data).readUInt32LE(8 + 32 + 8 + 12 + 4);
}

async function crossFills(
  fills: number,
): Promise<Measured & { drained: boolean }> {
  const { smoke, book } = await boot(Math.max(64, fills * 3 + 8));
  await restMakers(smoke, book, fills);
  const before = await orderCount(smoke, book);
  const taker = await funded(smoke);
  const m = await send(
    smoke,
    taker,
    placeIx(
      smoke,
      book,
      taker.publicKey,
      SIDE_BID,
      990,
      BigInt(fills) * ONE_SHARE,
      100,
      fills + 2,
      false,
    ),
  );
  const after = await orderCount(smoke, book);
  return { ...m, drained: before === fills && after === 0 };
}

describe("redesigned book — CU and transaction envelope", () => {
  it("a fill costs zero extra accounts and zero extra transaction bytes", async () => {
    // The structural claim. Everything a fill touches — the maker's order, the
    // maker's seat, the taker's seat — is a block inside the one book account
    // the instruction already holds.
    const one = await crossFills(1);
    const ten = await crossFills(10);

    // Guard against a vacuous pass: if matching silently did nothing, CU would
    // be flat and every assertion below would still hold.
    expect(one.drained).toBe(true);
    expect(ten.drained).toBe(true);

    expect(one.accounts).toBe(ten.accounts);
    expect(one.writable).toBe(ten.writable);
    expect(one.bytes).toBe(ten.bytes);

    // eslint-disable-next-line no-console
    console.log(
      `\n  accounts=${one.accounts} writable=${one.writable} bytes=${one.bytes} (flat, 1 vs 10 fills)`,
    );
    // Today: 10 writable at 1 fill, 22 at 5, +3 per fill.
    expect(one.writable).toBeLessThan(10);
  }, 120_000);

  it("measures marginal CU per fill", async () => {
    const points = [1, 3, 5, 10, 20];
    const rows: Array<[number, Measured]> = [];
    for (const n of points) rows.push([n, await crossFills(n)]);

    // eslint-disable-next-line no-console
    console.log("\n  fills │    CU    │ bytes │ writable");
    for (const [n, m] of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(n).padStart(5)} │ ${String(m.cu).padStart(8)} │ ${String(m.bytes).padStart(5)} │ ${String(m.writable).padStart(8)}`,
      );
    }

    for (const [n, m] of rows) {
      expect(m.drained, `${n} fills did not actually consume the book`).toBe(
        true,
      );
    }

    const first = rows[0]![1].cu;
    const last = rows[rows.length - 1]![1].cu;
    const span = points[points.length - 1]! - points[0]!;
    const marginal = (last - first) / span;
    const fixed = first - marginal;

    // eslint-disable-next-line no-console
    console.log(
      `\n  marginal ≈ ${Math.round(marginal)} CU/fill, fixed ≈ ${Math.round(fixed)} CU`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `  today: 29,510 CU/fill + 3 accounts + 99 bytes → 5 fills/tx (size-bound)`,
    );
    const ceiling = Math.floor((1_400_000 - fixed) / marginal);
    // eslint-disable-next-line no-console
    console.log(`  projected ceiling at 1.4M CU: ~${ceiling} fills/tx`);

    // Segment marginals, reported rather than trend-fitted. `seat_mut` walks
    // the seat list linearly, and this measurement uses a DISTINCT maker per
    // fill — its worst case — so some upward drift is expected. In practice the
    // segments are noisy at this scale because the ~23k fixed cost (two SPL
    // transfers plus account loads) dominates. What matters is that no segment
    // comes close to today's 29,510 CU per fill.
    const early = (rows[2]![1].cu - rows[1]![1].cu) / 2;
    const late = (rows[4]![1].cu - rows[3]![1].cu) / 10;
    // eslint-disable-next-line no-console
    console.log(
      `  marginal 3→5 ≈ ${Math.round(early)} CU, 10→20 ≈ ${Math.round(late)} CU\n`,
    );
    expect(early).toBeLessThan(5_000);
    expect(late).toBeLessThan(5_000);

    // The load-bearing assertion: strictly better than today's per-fill cost.
    expect(marginal).toBeLessThan(29_510);
    // ...and genuinely doing per-fill work. Without this a matcher that no-ops
    // would report a marginal near zero and "pass" spectacularly.
    expect(marginal).toBeGreaterThan(100);
    // And the ceiling must clear the current 5 by a wide margin, or the
    // redesign is not worth its blast radius.
    expect(ceiling).toBeGreaterThan(40);
  }, 300_000);
});
