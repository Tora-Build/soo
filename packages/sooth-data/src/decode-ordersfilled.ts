import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import { decodeBase58 } from "./base58.js";
import { BUY_DISCRIMINATOR, PROGRAM_IDS } from "./config.js";

export type FillRecord = {
  maker: string;
  maker_order_id: bigint;
  yes_tick: number;
  no_tick: number;
  amount: bigint;
  surplus: bigint;
  ts: bigint;
};

export type OrdersFilledEvent = {
  market: string;
  taker: string;
  taker_side: number;
  fills: FillRecord[];
};

export function anchorEventDiscriminator(eventName: string): Uint8Array {
  return createHash("sha256")
    .update(`event:${eventName}`)
    .digest()
    .subarray(0, 8);
}

// Anchor sha256("event:OrdersFilled")[..8]. Cross-checked against the bytes
// sooth_core actually emits — see
// packages/sdk-solana/tests/orders-filled-event.test.ts, which asserts the
// same constant from the producing side.
export const ORDERS_FILLED_DISCRIMINATOR = Uint8Array.from([
  0x47, 0x06, 0xce, 0x2c, 0xc1, 0xdc, 0x94, 0x55,
]);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

class Reader {
  private offset: number;

  constructor(
    private readonly bytes: Uint8Array,
    offset = 0,
    private readonly end = bytes.length,
  ) {
    this.offset = offset;
  }

  position(): number {
    return this.offset;
  }

  readU8(): number {
    this.ensure(1);
    const value = this.bytes[this.offset]!;
    this.offset += 1;
    return value;
  }

  readU16(): number {
    this.ensure(2);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      2,
    );
    const value = view.getUint16(0, true);
    this.offset += 2;
    return value;
  }

  readU32(): number {
    this.ensure(4);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    );
    const value = view.getUint32(0, true);
    this.offset += 4;
    return value;
  }

  readU64(): bigint {
    this.ensure(8);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    );
    const value = view.getBigUint64(0, true);
    this.offset += 8;
    return value;
  }

  readI64(): bigint {
    this.ensure(8);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    );
    const value = view.getBigInt64(0, true);
    this.offset += 8;
    return value;
  }

  readU128(): bigint {
    this.ensure(16);
    let value = 0n;
    for (let i = 0; i < 16; i += 1) {
      value += BigInt(this.bytes[this.offset + i]!) << BigInt(8 * i);
    }
    this.offset += 16;
    return value;
  }

  readPubkey(): string {
    this.ensure(32);
    const value = new PublicKey(this.bytes.slice(this.offset, this.offset + 32));
    this.offset += 32;
    return value.toBase58();
  }

  private ensure(length: number): void {
    if (this.offset + length > this.end) {
      throw new Error("OrdersFilled payload ended early");
    }
  }
}

export function decodeOrdersFilledInstructionData(
  instructionData: Uint8Array,
): OrdersFilledEvent | null {
  if (instructionData.length < 20) return null;

  const frame = new Reader(instructionData);
  frame.readU64();
  const payloadLength = frame.readU32();
  const payloadStart = frame.position();
  const payloadEnd = payloadStart + payloadLength;
  if (payloadEnd > instructionData.length || payloadLength < 8) {
    return null;
  }

  const discriminator = instructionData.slice(payloadStart, payloadStart + 8);
  if (!bytesEqual(discriminator, ORDERS_FILLED_DISCRIMINATOR)) {
    return null;
  }

  const reader = new Reader(instructionData, payloadStart + 8, payloadEnd);
  const market = reader.readPubkey();
  const taker = reader.readPubkey();
  const taker_side = reader.readU8();
  const fillsLength = reader.readU32();
  const fills: FillRecord[] = [];

  for (let i = 0; i < fillsLength; i += 1) {
    fills.push({
      maker: reader.readPubkey(),
      maker_order_id: reader.readU64(),
      yes_tick: reader.readU16(),
      no_tick: reader.readU16(),
      amount: reader.readU128(),
      surplus: reader.readU128(),
      ts: reader.readI64(),
    });
  }

  if (reader.position() !== payloadEnd) {
    throw new Error("OrdersFilled payload has trailing bytes");
  }

  return {
    market,
    taker,
    taker_side,
    fills,
  };
}

function toProgramId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toBase58" in value &&
    typeof value.toBase58 === "function"
  ) {
    return value.toBase58();
  }
  return null;
}

function accountKeyToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "pubkey" in value) {
    return toProgramId((value as { pubkey: unknown }).pubkey);
  }
  return toProgramId(value);
}

function getAccountKeys(tx: unknown): string[] {
  const transaction = (tx as { transaction?: unknown }).transaction;
  const message = (transaction as { message?: unknown } | undefined)?.message;
  const keys = (message as { accountKeys?: unknown[] } | undefined)
    ?.accountKeys;
  const out = Array.isArray(keys)
    ? keys.flatMap((key) => {
        const parsed = accountKeyToString(key);
        return parsed ? [parsed] : [];
      })
    : [];

  const loaded = (tx as { meta?: { loadedAddresses?: unknown } }).meta
    ?.loadedAddresses as
    | { writable?: unknown[]; readonly?: unknown[] }
    | undefined;
  for (const key of loaded?.writable ?? []) {
    const parsed = accountKeyToString(key);
    if (parsed) out.push(parsed);
  }
  for (const key of loaded?.readonly ?? []) {
    const parsed = accountKeyToString(key);
    if (parsed) out.push(parsed);
  }

  return out;
}

function getInstructionProgramId(ix: unknown, tx: unknown): string | null {
  const direct = toProgramId((ix as { programId?: unknown }).programId);
  if (direct) return direct;

  const programIdIndex = (ix as { programIdIndex?: unknown }).programIdIndex;
  if (typeof programIdIndex !== "number") return null;
  return getAccountKeys(tx)[programIdIndex] ?? null;
}

function getInstructionData(ix: unknown): Uint8Array | null {
  const data = (ix as { data?: unknown }).data;
  if (typeof data === "string") {
    return decodeBase58(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (
    Array.isArray(data) &&
    typeof data[0] === "string" &&
    data[1] === "base64"
  ) {
    return new Uint8Array(Buffer.from(data[0], "base64"));
  }
  return null;
}

/** Top-level instructions of a transaction, in order. */
function getOuterInstructions(tx: unknown): unknown[] {
  const transaction = (tx as { transaction?: unknown }).transaction;
  const message = (transaction as { message?: unknown } | undefined)?.message;
  const ixs = (message as { instructions?: unknown[] } | undefined)
    ?.instructions;
  return Array.isArray(ixs) ? ixs : [];
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Is top-level instruction `index` a call to `sooth_core::buy`?
 *
 * THIS IS THE AUTHENTICITY CHECK, and it is the whole reason this function
 * exists. `sooth_log::log` takes no accounts and no signer, so ANY wallet can
 * invoke it with a hand-crafted OrdersFilled payload naming any market. If a
 * consumer trusts a record merely because it targets the sooth_log program, it
 * can be fed arbitrary fabricated trades — which would drive the demo's price
 * chart and trade history off invented data.
 *
 * A record is only trustworthy as a direct child of a SUCCESSFUL top-level
 * `sooth_core::buy`. That is what the P0.1-A plan declared binding, and what
 * main's decoder never implemented: it iterated the inner groups without ever
 * reading `group.index`, so the parent was never identified at all.
 */
export function isBuyParent(
  tx: unknown,
  index: number,
  soothCoreProgramId: string = PROGRAM_IDS.SOOTH_CORE,
): boolean {
  const outer = getOuterInstructions(tx)[index];
  if (!outer) return false;
  if (getInstructionProgramId(outer, tx) !== soothCoreProgramId) return false;
  const data = getInstructionData(outer);
  return data ? startsWith(data, BUY_DISCRIMINATOR) : false;
}

/**
 * Decode every AUTHENTIC OrdersFilled event in a transaction.
 *
 * Records whose parent is not a successful `sooth_core::buy` are dropped. Pass
 * `{ trustUnverifiedParents: true }` only to inspect what a hostile caller
 * could inject — never on a data path.
 */
export function decodeOrdersFilledFromTransaction(
  tx: unknown,
  soothLogProgramId: string = PROGRAM_IDS.SOOTH_LOG,
  options: {
    soothCoreProgramId?: string;
    trustUnverifiedParents?: boolean;
  } = {},
): OrdersFilledEvent[] {
  // A failed transaction's inner instructions are still reported by some RPC
  // shapes; nothing inside a reverted transaction happened.
  if ((tx as { meta?: { err?: unknown } }).meta?.err) return [];

  const innerGroups = (tx as { meta?: { innerInstructions?: unknown[] } }).meta
    ?.innerInstructions;
  if (!Array.isArray(innerGroups)) return [];

  const events: OrdersFilledEvent[] = [];
  for (const group of innerGroups) {
    const instructions = (group as { instructions?: unknown[] }).instructions;
    if (!Array.isArray(instructions)) continue;

    // `index` identifies the top-level instruction these are children of.
    // Without it there is no way to tell a program-emitted record from one a
    // stranger appended to the same transaction.
    const parentIndex = (group as { index?: unknown }).index;
    if (!options.trustUnverifiedParents) {
      if (typeof parentIndex !== "number") continue;
      if (!isBuyParent(tx, parentIndex, options.soothCoreProgramId)) continue;
    }

    for (const ix of instructions) {
      if (getInstructionProgramId(ix, tx) !== soothLogProgramId) continue;
      const data = getInstructionData(ix);
      if (!data) continue;
      const event = decodeOrdersFilledInstructionData(data);
      if (event) events.push(event);
    }
  }

  return events;
}
