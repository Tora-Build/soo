// `book_init` cannot run without a heap-frame request.
//
// The program's bump allocator starts at the TOP of a 256 KiB heap, but the
// runtime maps only 32 KiB unless the transaction asks for more. Anchor's
// `Box<Account<Market>>` allocates before the handler body runs, so the very
// first allocation writes ~200 bytes below 0x300040000 and traps:
//
//   Program ... consumed 215 of 200000 compute units
//   Program ... failed: Access violation in heap section at 0x30003ff38
//
// 215 CU is the tell — the program never reached its own code. There is no
// Anchor error code and no program log, so a caller who drops the heap frame
// gets a failure with nothing in it to diagnose. Hence a test rather than a
// comment.

import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";

import {
  BOOK_INIT_HEAP_BYTES,
  buildBookInit,
  buildBookInitIxs,
} from "../src/book/index.js";

const PROGRAM_ID = new PublicKey("BgcooFgTuDQdoQkjLrZNRM6zM4Bu9bnAEenqdKjjR25W");
const PAYER = Keypair.generate().publicKey;

function refs() {
  return {
    marketId: new Uint8Array(16).fill(7),
    marketPda: Keypair.generate().publicKey,
    usdcMint: Keypair.generate().publicKey,
    programs: { soothCore: PROGRAM_ID },
  } as never;
}

describe("buildBookInitIxs", () => {
  it("prepends a heap-frame request ahead of book_init", () => {
    const ixs = buildBookInitIxs(refs(), PAYER, 64);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ixs[1]!.programId.equals(PROGRAM_ID)).toBe(true);
  });

  it("requests the full 256 KiB the allocator assumes", () => {
    // Anything smaller still leaves the allocator's starting pointer outside
    // the mapped region — a partial bump does not partially work.
    expect(BOOK_INIT_HEAP_BYTES).toBe(256 * 1024);
    const [heapIx] = buildBookInitIxs(refs(), PAYER, 64);
    // Layout: u8 discriminator (1 = RequestHeapFrame) then a LE u32.
    expect(heapIx!.data[0]).toBe(1);
    expect(heapIx!.data.readUInt32LE(1)).toBe(BOOK_INIT_HEAP_BYTES);
  });

  it("wraps the bare instruction without altering it", () => {
    // The helper must stay a pure wrapper: callers that assemble their own
    // transaction from `buildBookInit` have to get the same instruction that
    // was tested here.
    const r = refs();
    const bare = buildBookInit(r, PAYER, 64);
    const [, wrapped] = buildBookInitIxs(r, PAYER, 64);
    expect(wrapped!.data).toEqual(bare.data);
    expect(wrapped!.keys).toEqual(bare.keys);
    expect(wrapped!.programId).toEqual(bare.programId);
  });
});
