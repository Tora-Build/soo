// The hand-rolled book instructions must encode what the program decodes.
//
// `book/index.ts` builds `book_init`, `book_grow`, `book_place`, `book_cancel`
// and `book_withdraw` by hand — literal discriminators, a hand-written account
// list, and `Buffer.write*` for the args — rather than going through Anchor.
// That is deliberate (the `Book` account has no `#[account]` type for Anchor to
// deserialize) but it removes the one thing that would otherwise catch a drift:
// Anchor refuses to build an instruction the IDL does not describe.
//
// So the same three properties are checked against the IDL directly:
//
//   - the discriminator, which decides WHICH handler runs;
//   - the account list — order and writable/signer flags, which decide what the
//     handler is allowed to touch;
//   - the argument encoding, where a swapped field or a wrong width is read as
//     a different order at a different price, with no error anywhere.

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { soothCoreIdl } from "../src/anchor/index.js";
import {
  SIDE_BID,
  buildBookCancel,
  buildBookGrow,
  buildBookInit,
  buildBookPlace,
  buildBookWithdraw,
  bookPda,
  eventAuthorityPda,
  type BookRefs,
} from "../src/book/index.js";
import {
  deriveMarketVaultAta,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  feePoolBookPda,
} from "../src/pdas.js";

const PROGRAMS = {
  soothCore: new PublicKey("SoothTeSt1111111111111111111111111111111111"),
};
const MARKET_ID = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i + 1));
const MARKET_PDA = new PublicKey(Uint8Array.from(Array(32).fill(0x11)));
const USDC_MINT = new PublicKey(Uint8Array.from(Array(32).fill(0x22)));
const USER = new PublicKey(Uint8Array.from(Array(32).fill(0x33)));

const REFS: BookRefs = {
  marketId: MARKET_ID,
  marketPda: MARKET_PDA,
  usdcMint: USDC_MINT,
  programs: PROGRAMS,
};

interface IdlIx {
  name: string;
  discriminator: number[];
  args: Array<{ name: string; type: string }>;
  accounts: Array<{ name: string; writable?: boolean; signer?: boolean }>;
}

const IX_BY_NAME = new Map<string, IdlIx>(
  (soothCoreIdl as unknown as { instructions: IdlIx[] }).instructions.map(
    (ix) => [ix.name, ix],
  ),
);

function idlIx(name: string): IdlIx {
  const ix = IX_BY_NAME.get(name);
  if (!ix) throw new Error(`IDL has no instruction named ${name}`);
  return ix;
}

/** Byte width of each scalar the book instructions actually take. */
const WIDTH: Record<string, number> = { u8: 1, bool: 1, u16: 2, u32: 4, u64: 8 };

const BUILT = {
  book_init: buildBookInit(REFS, USER, 64),
  book_grow: buildBookGrow(REFS, USER, 128),
  book_place: buildBookPlace(REFS, USER, {
    side: SIDE_BID,
    limitTick: 0x0141,
    amount: 0x0102_0304_0506_0708n,
    matchLimit: 0x0a0b_0c0d,
    postRemainder: true,
  }),
  book_cancel: buildBookCancel(REFS, USER, 0x1122_3344_5566_7788n),
  book_withdraw: buildBookWithdraw(REFS, USER),
};

/** What each account slot must hold, keyed by the IDL's own account name. */
const EXPECTED_ACCOUNT: Record<string, PublicKey> = {
  book: bookPda(MARKET_ID, PROGRAMS)[0],
  market: MARKET_PDA,
  payer: USER,
  owner: USER,
  taker: USER,
  user: USER,
  system_program: new PublicKey("11111111111111111111111111111111"),
  token_program: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  vault_authority: deriveVaultAuthorityPda(MARKET_ID, PROGRAMS)[0],
  vault_book: deriveMarketVaultAta(MARKET_ID, USDC_MINT, PROGRAMS),
  taker_usdc_ata: PublicKey.findProgramAddressSync(
    [
      USER.toBuffer(),
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
      USDC_MINT.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  )[0],
  fee_pool_book: feePoolBookPda(MARKET_ID, PROGRAMS)[0],
  protocol_config: deriveProtocolConfigPda(PROGRAMS)[0],
  event_authority: eventAuthorityPda(PROGRAMS)[0],
  program: PROGRAMS.soothCore,
};
EXPECTED_ACCOUNT.user_usdc_ata = EXPECTED_ACCOUNT.taker_usdc_ata!;

describe.each(Object.keys(BUILT))("%s", (name) => {
  const built = BUILT[name as keyof typeof BUILT];
  const idl = idlIx(name);

  it("carries the IDL's discriminator", () => {
    expect([...built.data.subarray(0, 8)]).toEqual(idl.discriminator);
  });

  it("names the IDL's accounts, in order, with the IDL's flags", () => {
    expect(built.keys.length, "account count").toBe(idl.accounts.length);
    idl.accounts.forEach((account, i) => {
      const expected = EXPECTED_ACCOUNT[account.name];
      if (!expected) throw new Error(`no fixture for account ${account.name}`);
      const actual = built.keys[i]!;
      expect(actual.pubkey.toBase58(), `slot ${i} (${account.name})`).toBe(
        expected.toBase58(),
      );
      expect(actual.isWritable, `${account.name}.writable`).toBe(
        account.writable === true,
      );
      expect(actual.isSigner, `${account.name}.signer`).toBe(
        account.signer === true,
      );
    });
  });

  it("encodes exactly the IDL's args, in order, at the IDL's widths", () => {
    // Borsh packs scalars back to back with no padding, so the total length is
    // itself an assertion: a field silently widened or dropped changes it.
    const expectedLen =
      8 + idl.args.reduce((n, arg) => n + (WIDTH[arg.type] ?? NaN), 0);
    expect(Number.isNaN(expectedLen)).toBe(false);
    expect(built.data.length, "instruction data length").toBe(expectedLen);
  });
});

describe("book_place argument encoding", () => {
  it("round-trips every field, little-endian, at the IDL's offsets", () => {
    // Every field is given a distinct, asymmetric value: a byte-swap or a
    // pair of transposed fields has to change at least one of them.
    const idl = idlIx("book_place");
    const data = BUILT.book_place.data;
    let offset = 8;
    const read: Record<string, bigint | boolean> = {};
    for (const arg of idl.args) {
      switch (arg.type) {
        case "u8":
          read[arg.name] = BigInt(data.readUInt8(offset));
          break;
        case "u16":
          read[arg.name] = BigInt(data.readUInt16LE(offset));
          break;
        case "u32":
          read[arg.name] = BigInt(data.readUInt32LE(offset));
          break;
        case "u64":
          read[arg.name] = data.readBigUInt64LE(offset);
          break;
        case "bool":
          read[arg.name] = data.readUInt8(offset) === 1;
          break;
        default:
          throw new Error(`unhandled arg type ${arg.type}`);
      }
      offset += WIDTH[arg.type]!;
    }
    expect(read).toEqual({
      side: BigInt(SIDE_BID),
      limit_tick: 0x0141n,
      amount: 0x0102_0304_0506_0708n,
      match_limit: 0x0a0b_0c0dn,
      post_remainder: true,
    });
  });
});
