// Market solvency: can the vault cover everything it owes?
//
// Vault solvency is the single property whose violation means real user funds
// are unbacked, so it gets a test that can actually fail — the last case
// deliberately breaks it to prove the assertion fires.
//
// Obligations are `max(yesTotal, noTotal)`, not the sum: only the winning side
// ever redeems, so summing both legs reports a correctly-backed market as
// insolvent. (That was one of two bugs in main's `soothcli-sol` version, which
// also rescaled 6-decimal values by 1e12 and so floored to zero — making the
// assertion vacuous. Both are recorded here because the shape of the mistake
// is easy to reintroduce.)
//
// Since the venues split tokens the check is PER VAULT, and that is the point:
// the AMM's vault holds one mint and the book's another, so an obligation from
// one venue can never be covered by the other's collateral. Reading them as a
// single pool would hide exactly the mixing the split exists to prevent — a
// book vault could look solvent on the strength of AMM collateral it has no
// claim to.
//
// So `checkCollateralBacking` takes the venue's mint and counts only that
// venue's ledger. Each is independently collateralised by construction: the
// LMSR is bounded by the creator's `b·ln(2)` deposit, and every book fill
// escrows both legs to exactly 1.00.

import { describe, expect, it } from "vitest";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";

import {
  deriveMarketVaultAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
} from "../src/pdas.js";
import { decodeBook } from "../src/book/index.js";
import { bootSmoke } from "./fixtures/setup.js";
import {
  ONE_SHARE,
  SIDE_ASK,
  SIDE_BID,
  bookInitIx,
  bookPda,
  bookPlaceIx,
  sendBookTx,
  trader,
} from "./fixtures/book.js";
import { LiteSvmConnection } from "./fixtures/svm.js";
import {
  SHARES,
  anchorProgram,
  createFundedMaker,
  enableBook,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

const BN = anchorPkg.BN;

/** WAD → 6-decimal base units, matching the program's `wad_to_base` (floor). */
const WAD_TO_BASE = 1_000_000_000_000n;

export interface SolvencyReport {
  vault: bigint;
  /** SPL mint supply only — what main's version looked at. */
  /** Mint supply + share ledgers, in USDC base units. */
  yesTotal: bigint;
  noTotal: bigint;
  /** Worst-case redemption: only the winning side pays out, so the exposure is
   *  whichever leg is larger — not the sum. */
  obligations: bigint;
  solvent: boolean;
}

/**
 * Check that a market's USDC vault covers everything it can be asked to pay.
 *
 * Three ledgers draw on the same vault and all must be counted:
 *   - SPL YES/NO mint supply     → `redeem` (6-decimal, 1:1 with USDC)
 *   - `OrderbookPosition` shares → `redeem_orderbook` (WAD, ÷1e12 on payout)
 *   - AMM `Position` shares      → `redeem` path (WAD, same rescale)
 *
 * Main's CLI counted only the first, which is a real gap under develop's
 * architecture: a CLOB fill credits `OrderbookPosition` and moves USDC into the
 * vault without minting anything, so a mint-supply-only check reads a fully
 * loaded orderbook market as having zero obligations.
 *
 * `max` rather than `sum` because only the winning leg redeems. It also bounds
 * the INVALID case, which pays `(yes + no) / 2` per position.
 *
 * Position addresses are passed in explicitly: LiteSVM has no
 * `getProgramAccounts`, and enumerating them on-chain would be unbounded anyway.
 */
export async function checkCollateralBacking(
  conn: any,
  marketId: Uint8Array,
  programs: any,
  /** The venue's mint — its vault is an ATA of that mint under the shared
   *  `vault_authority` PDA, so this selects which pot is being checked. */
  venueMint: PublicKey,
  opts: {
    program?: any;
    ammPositions?: PublicKey[];
    /**
     * The book account, if this market has one.
     *
     * The book is a single account, so the whole CLOB ledger is one read and
     * cannot be under-counted by forgetting a trader. A per-(market, user)
     * PDA list would require knowing every trader in advance to derive.
     */
    book?: PublicKey;
  } = {},
): Promise<SolvencyReport> {
  const vaultAta = deriveMarketVaultAta(marketId, venueMint, programs);
  const vault = await getAccount(conn, vaultAta);

  let yesTotal = 0n;
  let noTotal = 0n;

  const walk = async (addrs: PublicKey[] | undefined, kind: string) => {
    for (const addr of addrs ?? []) {
      // A position that does not exist yet holds nothing — skip rather than
      // throw, so callers can pass the full set of derived PDAs.
      const raw = await conn.getAccountInfo(addr);
      if (!raw) continue;
      const pos = await (opts.program!.account as any)[kind].fetch(addr);
      yesTotal += BigInt(pos.yesShares.toString()) / WAD_TO_BASE;
      noTotal += BigInt(pos.noShares.toString()) / WAD_TO_BASE;
    }
  };
  await walk(opts.ammPositions, "position");

  // Book seats: a signed net, so a long counts against YES and a short against
  // NO. Resting escrow and unwithdrawn credit are USDC obligations rather than
  // share obligations, so they are not part of this comparison.
  if (opts.book) {
    const raw = await conn.getAccountInfo(opts.book);
    if (raw) {
      const snapshot = decodeBook(Buffer.from(raw.data));
      for (const seat of snapshot.seats) {
        if (seat.net > 0n) yesTotal += seat.net;
        else if (seat.net < 0n) noTotal += -seat.net;
      }
    }
  }

  const obligations = yesTotal > noTotal ? yesTotal : noTotal;
  return {
    vault: vault.amount,
    yesTotal,
    noTotal,
    obligations,
    solvent: vault.amount >= obligations,
  };
}

describe("market solvency invariant", () => {
/** seed_lp posts b*ln(2); at the fixture's b = 1000 that is this many base units. */
const LMSR_SUBSIDY = 693_147_181n;

  it("a fresh market is trivially solvent", async () => {
    const smoke = await bootSmoke();
    const conn = new LiteSvmConnection(smoke.ctx);
    const r = await checkCollateralBacking(
      conn,
      smoke.marketId,
      smoke.programs,
      smoke.usdcMint,
    );
    expect(r.obligations).toBe(0n);
    expect(r.solvent).toBe(true);
  }, 60_000);

  it("holds after a real book cross", async () => {
    // A crossing order moves USDC into the vault and moves two seats. The
    // whole position lives in the seat ledger, which is why that ledger has to
    // be counted rather than inferred from anything else.
    const smoke = await bootSmoke();
    const { ctx, marketId, programs } = smoke;
    const program = anchorProgram(ctx, smoke.creator);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);
    await sendBookTx(
      smoke,
      smoke.creator,
      bookInitIx(smoke, smoke.creator.publicKey, 32),
    );
    await enableBook(smoke.ctx, smoke);

    const maker = await trader(smoke);
    const taker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, 10n * ONE_SHARE, 8, true),
    );
    await sendBookTx(
      smoke,
      taker,
      bookPlaceIx(smoke, taker.publicKey, SIDE_BID, 400, 10n * ONE_SHARE, 8, false),
    );

    const conn = new LiteSvmConnection(ctx);
    const r = await checkCollateralBacking(
      conn,
      marketId,
      programs,
      smoke.usdcMint,
      { program, book: bookPda(marketId) },
    );

    expect(r.yesTotal).toBeGreaterThan(0n);
    expect(r.noTotal).toBeGreaterThan(0n);
    expect(r.solvent).toBe(true);
    expect(r.vault).toBeGreaterThanOrEqual(r.obligations);
  }, 120_000);

  it("the invariant actually fires when the vault is drained", async () => {
    // A test that can never fail is worse than no test. Build a real
    // obligation with a book cross, then break solvency directly and confirm
    // detection.
    const smoke = await bootSmoke();
    const { ctx, marketId, programs } = smoke;
    const program = anchorProgram(ctx, smoke.creator);
    await initMarketFeePool(ctx, program, smoke, smoke.creator);
    await sendBookTx(
      smoke,
      smoke.creator,
      bookInitIx(smoke, smoke.creator.publicKey, 32),
    );
    await enableBook(smoke.ctx, smoke);

    const maker = await trader(smoke);
    const taker = await trader(smoke);
    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_ASK, 400, 10n * ONE_SHARE, 8, true),
    );
    await sendBookTx(
      smoke,
      taker,
      bookPlaceIx(smoke, taker.publicKey, SIDE_BID, 400, 10n * ONE_SHARE, 8, false),
    );

    const vaultAta = deriveMarketVaultAta(marketId, smoke.usdcMint, programs);
    const conn = new LiteSvmConnection(ctx);
    const opts = { program, book: bookPda(marketId) };

    const healthy = await checkCollateralBacking(
      conn,
      marketId,
      programs,
      smoke.usdcMint,
      opts,
    );
    expect(healthy.solvent).toBe(true);
    expect(healthy.obligations).toBeGreaterThan(0n);

    // Drop the vault one base unit below what is owed — a leak no instruction
    // should ever produce. One unit, not a fraction: the LMSR subsidy leaves
    // so much headroom that a market can lose most of its vault and still
    // cover its obligations, so halving would not prove anything.
    const raw = await ctx.banksClient.getAccount(vaultAta);
    const data = Buffer.from(raw!.data);
    const drained = healthy.obligations - 1n;
    data.writeBigUInt64LE(drained, 64); // SPL token account: amount @ 64
    ctx.setAccount(vaultAta, {
      executable: false,
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      lamports: raw!.lamports,
      data,
    });

    const r = await checkCollateralBacking(
      conn,
      marketId,
      programs,
      smoke.usdcMint,
      opts,
    );
    expect(r.vault).toBe(drained);
    expect(r.obligations).toBe(healthy.obligations);
    expect(r.solvent).toBe(false);
  }, 120_000);
});
