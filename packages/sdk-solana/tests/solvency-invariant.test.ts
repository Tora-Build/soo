// Market solvency: can the vault cover everything it owes?
//
// This is the one piece of main's `soothcli-sol` worth keeping. The CLI is a
// REPL — the browser-side Geek page already covers that role — but its
// `checkCollateralBacking` assertion has no equivalent anywhere in the test
// suite, and vault solvency is the single property whose violation means real
// user funds are unbacked.
//
// ⚠️ MAIN'S VERSION DOES NOT WORK. It computes
//
//     obligations = (yesMint.supply + noMint.supply) / WAD_TO_USDC_SCALAR
//     passed      = vault.amount >= obligations
//
// Two independent bugs, verified against a live LiteSVM market:
//
//   1. It SUMS both legs. Minting a complete set of 10 USDC creates 10 YES and
//      10 NO, so the sum is 20 — but only the winning side ever redeems, so
//      the true obligation is 10. A correctly-backed market reads as insolvent.
//
//   2. It divides by WAD_TO_USDC_SCALAR (1e12). The outcome mints are already
//      6-decimal, matching USDC, so no rescale is needed. 20_000_000 / 1e12
//      floors to ZERO — which means `vault >= 0` is always true and the whole
//      assertion is VACUOUS. Bug 2 masks bug 1; the check has never failed
//      because it can never fail.
//
// Corrected here: obligations = max(yesSupply, noSupply), no rescale. The last
// test deliberately breaks solvency to prove the assertion actually fires.

import { describe, expect, it } from "vitest";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";

import {
  deriveMarketVaultAta,
  deriveNoMintPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
  orderbookPositionPda,
} from "../src/pdas.js";
import { bootSmoke } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";
import {
  SHARES,
  anchorProgram,
  buyTx,
  createFundedMaker,
  fillBundle,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

const BN = anchorPkg.BN;

/** WAD → 6-decimal base units, matching the program's `wad_to_base` (floor). */
const WAD_TO_BASE = 1_000_000_000_000n;

export interface SolvencyReport {
  vault: bigint;
  /** SPL mint supply only — what main's version looked at. */
  yesSupply: bigint;
  noSupply: bigint;
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
  usdcMint: PublicKey,
  opts: {
    program?: any;
    orderbookPositions?: PublicKey[];
    ammPositions?: PublicKey[];
  } = {},
): Promise<SolvencyReport> {
  const [yesMintPda] = deriveYesMintPda(marketId, programs);
  const [noMintPda] = deriveNoMintPda(marketId, programs);
  const vaultAta = deriveMarketVaultAta(marketId, usdcMint, programs);

  const [vault, yesMint, noMint] = await Promise.all([
    getAccount(conn, vaultAta),
    getMint(conn, yesMintPda),
    getMint(conn, noMintPda),
  ]);

  let yesTotal = yesMint.supply;
  let noTotal = noMint.supply;

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
  await walk(opts.orderbookPositions, "orderbookPosition");
  await walk(opts.ammPositions, "position");

  const obligations = yesTotal > noTotal ? yesTotal : noTotal;
  return {
    vault: vault.amount,
    yesSupply: yesMint.supply,
    noSupply: noMint.supply,
    yesTotal,
    noTotal,
    obligations,
    solvent: vault.amount >= obligations,
  };
}

async function mintCompleteSet(
  smoke: any,
  program: any,
  amountBaseUnits: bigint,
) {
  const { ctx, marketId, programs, usdcMint, user } = smoke;
  const [yesMint] = deriveYesMintPda(marketId, programs);
  const [noMint] = deriveNoMintPda(marketId, programs);
  const [vaultAuthority] = deriveVaultAuthorityPda(marketId, programs);
  const userYes = getAssociatedTokenAddressSync(yesMint, user.publicKey);
  const userNo = getAssociatedTokenAddressSync(noMint, user.publicKey);

  await sendTx(
    ctx,
    [user],
    new Transaction()
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          user.publicKey,
          userYes,
          user.publicKey,
          yesMint,
        ),
      )
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          user.publicKey,
          userNo,
          user.publicKey,
          noMint,
        ),
      )
      .add(
        await (program.methods as any)
          .mintCompleteSet(new BN(amountBaseUnits.toString()))
          .accounts({
            market: smoke.marketPda,
            vaultAuthority,
            yesMint,
            noMint,
            vault: deriveMarketVaultAta(marketId, usdcMint, programs),
            userUsdcAta: deriveUserUsdcAta(user.publicKey, usdcMint),
            userYesAta: userYes,
            userNoAta: userNo,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ),
  );
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

  it("minting a complete set keeps the vault exactly covering obligations", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.user);
    const MINT = 10_000_000n; // 10 USDC
    await mintCompleteSet(smoke, program, MINT);

    const conn = new LiteSvmConnection(smoke.ctx);
    const r = await checkCollateralBacking(
      conn,
      smoke.marketId,
      smoke.programs,
      smoke.usdcMint,
    );

    // 10 USDC in ⇒ 10 YES + 10 NO out. Both legs equal, one redeems.
    expect(r.yesSupply).toBe(MINT);
    expect(r.noSupply).toBe(MINT);
    expect(r.obligations).toBe(MINT);
    // The complete set is backed 1:1, ON TOP of the LMSR subsidy seed_lp
    // posted. The market is over-collateralised, which is the point of the
    // subsidy — see amm-redeem.test.ts.
    expect(r.vault).toBe(LMSR_SUBSIDY + MINT);
    expect(r.solvent).toBe(true);
  }, 60_000);

  it("main's formula would call this exact state insolvent — and is vacuous anyway", async () => {
    // Pins BOTH bugs so the corrected version cannot silently regress into the
    // old one. If someone reinstates the sum, the first assertion fails; if
    // they reinstate the rescale, the second shows the check is meaningless.
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.user);
    const MINT = 10_000_000n;
    await mintCompleteSet(smoke, program, MINT);

    const conn = new LiteSvmConnection(smoke.ctx);
    const r = await checkCollateralBacking(
      conn,
      smoke.marketId,
      smoke.programs,
      smoke.usdcMint,
    );

    // Bug 1: summing both legs double-counts. Only the winning side redeems,
    // so the true exposure is 10 USDC, not 20. Asserted on the numbers rather
    // than on the solvent/insolvent verdict, because the LMSR subsidy now
    // leaves enough headroom that even the wrong figure happens to pass here —
    // which is exactly how an overstated obligation hides until it doesn't.
    const summedLegs = r.yesSupply + r.noSupply;
    expect(summedLegs).toBe(2n * r.obligations);

    // Bug 2: the 1e12 rescale floors a 20 USDC figure to zero, so main's check
    // reduces to `vault >= 0` and can never fail.
    expect(summedLegs / 1_000_000_000_000n).toBe(0n);
  }, 60_000);

  it("holds after a real CLOB cross — and mint supply alone would miss it", async () => {
    // The case main's version cannot see. A crossing buy moves USDC into the
    // vault and credits two OrderbookPositions; no SPL token is minted, so the
    // mint-supply-only view reports zero obligations against a non-zero vault.
    const smoke = await bootSmoke();
    const { ctx, marketId, programs } = smoke;
    const maker = await createFundedMaker(smoke, 10_000n);
    const taker = smoke.user;
    const program = anchorProgram(ctx, maker);
    await initMarketFeePool(ctx, program, smoke, maker);

    await sendTx(
      ctx,
      [maker],
      await buyTx(program, smoke, {
        signer: maker,
        side: 1,
        tick: 900,
        amount: SHARES,
        matchLimit: 0,
        remaining: [],
      }),
    );
    await sendTx(
      ctx,
      [taker],
      await buyTx(program, smoke, {
        signer: taker,
        side: 0,
        tick: 999,
        amount: SHARES,
        matchLimit: 1,
        remaining: fillBundle(smoke, 1, 900, maker.publicKey),
      }),
    );

    const positions = [maker.publicKey, taker.publicKey].map(
      (k) => orderbookPositionPda(marketId, k, programs)[0],
    );
    const conn = new LiteSvmConnection(ctx);
    const r = await checkCollateralBacking(
      conn,
      marketId,
      programs,
      smoke.usdcMint,
      { program, orderbookPositions: positions },
    );

    // Mint supply saw nothing; the share ledgers carry the whole position.
    expect(r.yesSupply).toBe(0n);
    expect(r.noSupply).toBe(0n);
    expect(r.yesTotal).toBeGreaterThan(0n);
    expect(r.noTotal).toBeGreaterThan(0n);
    expect(r.solvent).toBe(true);

    // And the vault has real headroom — the cross funded it above the payout.
    expect(r.vault).toBeGreaterThanOrEqual(r.obligations);
  }, 120_000);

  it("the invariant actually fires when the vault is drained", async () => {
    // A test that can never fail is worse than no test — that is precisely how
    // main's version shipped. Break solvency directly and confirm detection.
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.user);
    const MINT = 10_000_000n;
    await mintCompleteSet(smoke, program, MINT);

    const vaultAta = deriveMarketVaultAta(
      smoke.marketId,
      smoke.usdcMint,
      smoke.programs,
    );
    const conn = new LiteSvmConnection(smoke.ctx);
    const before = await getAccount(conn, vaultAta);

    // Drop the vault one base unit below what is owed — simulating a leak no
    // instruction should ever produce. Halving is no longer enough: the LMSR
    // subsidy leaves so much headroom that a market can lose most of its vault
    // and still cover its obligations.
    const raw = await smoke.ctx.banksClient.getAccount(vaultAta);
    const data = Buffer.from(raw!.data);
    const drained = MINT - 1n;
    data.writeBigUInt64LE(drained, 64); // SPL token account: amount @ 64
    smoke.ctx.setAccount(vaultAta, {
      executable: false,
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      lamports: raw!.lamports,
      data,
    });

    const r = await checkCollateralBacking(
      conn,
      smoke.marketId,
      smoke.programs,
      smoke.usdcMint,
    );
    expect(r.vault).toBe(MINT - 1n);
    expect(r.obligations).toBe(MINT);
    expect(r.solvent).toBe(false);
  }, 60_000);
});
