// LMSR price over time, from archived account state.
//
// This is the case where Alchemy's Account Archive genuinely removes work
// rather than duplicating it. The AMM's price is a pure function of three
// numbers held in `AmmState`:
//
//     p_yes = exp(q_yes/b) / (exp(q_yes/b) + exp(q_no/b))
//
// so the price at any past slot is just that account, read at that slot. No
// events, no index, no reconstruction — and one request per WRITE rather than
// per slot, because `firstUpdateAfterSlot` skips the quiet stretches.
//
// Contrast with trade history, which the archive cannot give: fills are per
// transaction and the archive is per slot, so two transactions in one slot
// collapse into one state and the first fill becomes unobservable. Price is
// different precisely because it is a property of STATE, not of an event.
//
// The log-sum-exp shift matches `lmsr.rs` — subtract the max before
// exponentiating — so a market with large `q/b` gives the same answer here as
// on chain instead of overflowing to Infinity.

import { getAccountAt, walkWrites, type ArchiveAccount, type RpcCall } from "./account-archive.js";

/** Byte offsets into `AmmState`, after the 8-byte Anchor discriminator. */
const OFF_Q_YES = 8 + 32;
const OFF_Q_NO = OFF_Q_YES + 16;
const OFF_B = OFF_Q_NO + 16;
const WAD = 1e18;

export interface PricePoint {
  slot: number;
  qYes: number;
  qNo: number;
  b: number;
  /** YES price in 0..1. */
  price: number;
}

/** Read an i128 little-endian at `offset`. */
function readI128(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

/**
 * The LMSR YES price. Mirrors `lmsr_cost`'s shift so the two agree.
 *
 * Returns 0.5 when `b` is zero — an uninitialised or non-AMM account — rather
 * than NaN, which would propagate into a chart as a gap that looks like data.
 */
export function lmsrPrice(qYes: number, qNo: number, b: number): number {
  if (!Number.isFinite(b) || b <= 0) return 0.5;
  const a = qYes / b;
  const c = qNo / b;
  const m = Math.max(a, c);
  const ea = Math.exp(a - m);
  const ec = Math.exp(c - m);
  return ea / (ea + ec);
}

export function toPricePoint(account: ArchiveAccount): PricePoint | null {
  if (account.data.length < OFF_B + 16) return null;
  const qYes = Number(readI128(account.data, OFF_Q_YES)) / WAD;
  const qNo = Number(readI128(account.data, OFF_Q_NO)) / WAD;
  const b = Number(readI128(account.data, OFF_B)) / WAD;
  return { slot: account.slot ?? 0, qYes, qNo, b, price: lmsrPrice(qYes, qNo, b) };
}

/**
 * Price at a single past slot.
 *
 * `slot` means "the latest write at or before S", so this answers for any
 * slot, not only ones where the market happened to trade.
 */
export async function priceAtSlot(
  rpc: RpcCall,
  ammStateAddress: string,
  slot: number,
): Promise<PricePoint | null> {
  const account = await getAccountAt(rpc, ammStateAddress, { slot });
  return account ? toPricePoint(account) : null;
}

/**
 * Every price the market passed through after `fromSlot`.
 *
 * One request per state CHANGE, so a market that traded 40 times costs 40
 * requests regardless of how many slots it spans — which is what makes a chart
 * over weeks affordable without an index.
 */
export async function priceHistory(
  rpc: RpcCall,
  ammStateAddress: string,
  fromSlot: number,
  maxPoints = 200,
): Promise<PricePoint[]> {
  const writes = await walkWrites(rpc, ammStateAddress, fromSlot, maxPoints);
  return writes
    .map(toPricePoint)
    .filter((p): p is PricePoint => p !== null);
}
