// Durable fill events (P0.1).
//
// Solana has no cheap equivalent of an EVM `emit`. Anchor's `emit!` writes to
// program logs, which the runtime truncates and RPC providers drop, so it
// cannot back an indexer. `emit_cpi!` is durable but allocates per event, and
// the P0.1 spike showed it OOMs the multi-fill buy path even when batched.
//
// What works: serialize once and `invoke` the no-op `sooth_log` program. The
// payload is then permanently recorded as an INNER INSTRUCTION, which is what
// these tests read back.
//
// The wire format is decoded by hand below rather than through a Borsh helper,
// deliberately — an indexer has to implement exactly this, and a test that
// round-trips through the same library that wrote it would not prove the
// layout is what a third party sees:
//
//   sooth_log::log instruction data
//     [0..8]    log discriminator
//     [8..12]   u32 length of the Vec<u8> argument
//     [12..20]  OrdersFilled event discriminator
//     [20..]    borsh OrdersFilled
//
//   OrdersFilled
//     market      pubkey (32)
//     taker       pubkey (32)
//     taker_side  u8     (1)
//     fills       u32 len + N × FillRecord
//
//   FillRecord (84 bytes)
//     maker(32) order_id(u64) yes_tick(u16) no_tick(u16)
//     amount(u128) surplus(u128) ts(i64)

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { SOOTH_CORE_ID } from "./fixtures/setup.js";
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
  withHeapFrame,
} from "./fixtures/orderbook.js";
import type { SvmContext } from "./fixtures/svm.js";

/** sha256("event:OrdersFilled")[..8]. Hardcoded rather than derived so a
 *  rename of the Rust struct — which would silently break every deployed
 *  indexer — fails here first. Matches the value main's sooth-data pins. */
const ORDERS_FILLED_DISCRIMINATOR = "4706ce2cc1dc9455";

interface FillRecord {
  maker: string;
  makerOrderId: bigint;
  yesTick: number;
  noTick: number;
  amount: bigint;
  surplus: bigint;
  ts: bigint;
}

interface OrdersFilled {
  market: string;
  taker: string;
  takerSide: number;
  fills: FillRecord[];
}

function decodeOrdersFilled(data: Uint8Array): OrdersFilled {
  // emit_cpi! framing: [8-byte Anchor CPI-event tag][8-byte event
  // discriminator][borsh body]. The old sooth_log framing was
  // [8-byte Log ix disc][u32 borsh Vec length][event disc][body] — one fewer
  // indirection now that the program self-invokes instead of calling out.
  const buf = Buffer.from(data);
  const payload = buf.subarray(8);
  expect(payload.subarray(0, 8).toString("hex")).toBe(
    ORDERS_FILLED_DISCRIMINATOR,
  );

  let o = 8;
  const market = new PublicKey(payload.subarray(o, o + 32)).toBase58();
  o += 32;
  const taker = new PublicKey(payload.subarray(o, o + 32)).toBase58();
  o += 32;
  const takerSide = payload.readUInt8(o);
  o += 1;
  const count = payload.readUInt32LE(o);
  o += 4;

  const fills: FillRecord[] = [];
  for (let i = 0; i < count; i++) {
    const maker = new PublicKey(payload.subarray(o, o + 32)).toBase58();
    o += 32;
    const makerOrderId = payload.readBigUInt64LE(o);
    o += 8;
    const yesTick = payload.readUInt16LE(o);
    o += 2;
    const noTick = payload.readUInt16LE(o);
    o += 2;
    const amount = readU128(payload, o);
    o += 16;
    const surplus = readU128(payload, o);
    o += 16;
    const ts = payload.readBigInt64LE(o);
    o += 8;
    fills.push({ maker, makerOrderId, yesTick, noTick, amount, surplus, ts });
  }
  // Whole payload consumed — a layout drift shows up here rather than as
  // silently truncated fills.
  expect(o).toBe(payload.length);
  return { market, taker, takerSide, fills };
}

function readU128(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

/** Every sooth_log inner instruction, with the top-level index it descends
 *  from. That index is load-bearing: `sooth_log::log` takes no accounts and
 *  no signer, so ANYONE can invoke it with fabricated bytes. A consumer must
 *  confirm the record is a direct child of a successful `sooth_core::buy`
 *  before trusting it — checking only the program id is not enough. */
/** Self-CPI event payloads. `buy` used to invoke a separate `sooth_log`
 *  program; it now self-invokes via Anchor's `emit_cpi!`, so the inner
 *  instruction's program is sooth_core itself. */
function soothLogRecords(
  meta: { innerInstructions: Array<{ index: number; programIdIndex: number; data: Uint8Array }> },
  accountKeys: PublicKey[],
) {
  return meta.innerInstructions.filter((ix) =>
    accountKeys[ix.programIdIndex]?.equals(SOOTH_CORE_ID),
  );
}

async function crossAndCapture(
  smoke: { ctx: SvmContext } & Record<string, any>,
  program: any,
  fillCount: number,
) {
  const { ctx } = smoke;
  const taker = smoke.user;

  const makers = [];
  for (let i = 0; i < fillCount; i++) {
    const tick = 900 - i * 10;
    const maker = await createFundedMaker(smoke as any, 100_000n);
    await mintCompleteSetForOrderbook(
      ctx,
      program,
      smoke as any,
      maker,
      SHARES / BASE_UNIT_WAD,
    );
    await sendTx(
      ctx,
      [maker],
      await buyTx(program, smoke as any, {
        signer: maker,
        side: 1,
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
    fillBundle(smoke as any, 1, tick, maker.publicKey),
  );
  const tx = withHeapFrame(
    await buyTx(program, smoke as any, {
      signer: taker,
      side: 0,
      tick: 950,
      amount: BigInt(fillCount) * SHARES,
      matchLimit: fillCount,
      remaining: bundles,
    }),
  );
  const blockhash = await ctx.banksClient.getLatestBlockhash();
  tx.recentBlockhash = blockhash![0];
  tx.feePayer = taker.publicKey;
  tx.sign(taker);

  const res = await ctx.banksClient.tryProcessTransaction(tx);
  expect(res.result).toBeNull();
  const accountKeys = tx.compileMessage().accountKeys;
  return { res, accountKeys, makers, taker };
}

describe("OrdersFilled durable event", () => {
  it("a single fill is recorded as a decodable sooth_log inner instruction", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.user);
    await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);

    const { res, accountKeys, makers, taker } = await crossAndCapture(
      smoke,
      program,
      1,
    );

    const records = soothLogRecords(res.meta!, accountKeys);
    expect(records).toHaveLength(1);

    const event = decodeOrdersFilled(records[0]!.data);
    expect(event.market).toBe(smoke.marketPda.toBase58());
    expect(event.taker).toBe(taker.publicKey.toBase58());
    expect(event.takerSide).toBe(0);
    expect(event.fills).toHaveLength(1);

    const fill = event.fills[0]!;
    expect(fill.maker).toBe(makers[0]!.maker.publicKey.toBase58());
    expect(fill.amount).toBe(SHARES);
    // Ticks are normalized to (yes, no), not (taker, maker). The taker bought
    // side 0 (= NO) at 950 and the maker rested side 1 (= YES) at 900, so the
    // YES leg is the MAKER's 900 and the NO leg is the taker's 950.
    //
    // This assertion used to read (950, 900) — it was pinning bug B2, where
    // matching.rs branched on `taker_side == 0` as if 0 meant YES. Side 1 is
    // YES (see credit_shares), so every FillRecord carried its two ticks the
    // wrong way round and the indexer has been serving them swapped.
    expect(fill.yesTick).toBe(900);
    expect(fill.noTick).toBe(950);
    // yes + no = 1850 > 1000, so the taker is owed the overpay as surplus.
    expect(fill.surplus).toBeGreaterThan(0n);
    expect(fill.ts).toBeGreaterThan(0n);
  }, 60_000);

  it("multiple fills batch into ONE event, in consumption order", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.user);
    await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);

    const { res, accountKeys, makers } = await crossAndCapture(
      smoke,
      program,
      3,
    );

    // One event, not three. Per-fill emission is what OOM'd the 32 KB heap;
    // if this ever becomes 3 the batching regressed.
    const records = soothLogRecords(res.meta!, accountKeys);
    expect(records).toHaveLength(1);

    const event = decodeOrdersFilled(records[0]!.data);
    expect(event.fills).toHaveLength(3);
    expect(event.fills.map((f) => f.maker)).toEqual(
      makers.map((m) => m.maker.publicKey.toBase58()),
    );
    // Descending ticks — the order the bitmap walk consumed them. These are
    // the MAKERs' resting prices, and the makers rest on side 1 (YES), so they
    // land in yesTick. The taker's own 950 is the NO leg on every fill.
    expect(event.fills.map((f) => f.yesTick)).toEqual([900, 890, 880]);
    expect(event.fills.map((f) => f.noTick)).toEqual([950, 950, 950]);
    for (const fill of event.fills) expect(fill.amount).toBe(SHARES);
  }, 60_000);

  it("a buy that rests without crossing emits nothing", async () => {
    const smoke = await bootSmoke();
    const { ctx } = smoke;
    const program = anchorProgram(ctx, smoke.user);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);

    const tx = withHeapFrame(
      await buyTx(program, smoke, {
        signer: smoke.user,
        side: 1,
        tick: 900,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      }),
    );
    const blockhash = await ctx.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash![0];
    tx.feePayer = smoke.user.publicKey;
    tx.sign(smoke.user);

    const res = await ctx.banksClient.tryProcessTransaction(tx);
    expect(res.result).toBeNull();
    expect(
      soothLogRecords(res.meta!, tx.compileMessage().accountKeys),
    ).toHaveLength(0);
  }, 60_000);

  it("the event descends from the buy instruction, not a sibling", async () => {
    // The property an indexer must check. sooth_log is permissionless, so a
    // record is only trustworthy if it is a direct child of a successful
    // sooth_core::buy — identified by the parent index the runtime reports.
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.user);
    await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);

    const { res, accountKeys } = await crossAndCapture(smoke, program, 1);
    const records = soothLogRecords(res.meta!, accountKeys);

    // withHeapFrame prepends setComputeUnitLimit (0) and requestHeapFrame (1),
    // so buy is top-level instruction 2. An indexer resolves the parent the
    // same way and must then confirm its program id and discriminator.
    const BUY_IX_INDEX = 2;
    expect(records[0]!.index).toBe(BUY_IX_INDEX);
  }, 60_000);
});
