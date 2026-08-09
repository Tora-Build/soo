// AMM post-settlement exit (bug B1).
//
// Before `redeem_amm_position` existed, this whole flow had no ending. A user
// could buy YES on the AMM, the market could settle YES, and there was no
// instruction anywhere that would pay them. Their USDC sat in the vault and
// their shares sat in `Position` with nothing able to read them:
//
//   redeem                   reads SPL outcome-token ATA balances, which an AMM
//                            buyer never receives
//   redeem_orderbook         drains OrderbookPosition, a different ledger
//   redeem_from_program_owned  program-owned complete sets only
//   claim_refund             gated on amm_state.is_dismissed
//   sell_positions           requires market.is_open()
//
// The gap survived because every existing AMM test stops at the buy. Nothing
// carried a position through settlement, so nothing noticed there was no way
// out. That is the shape of bug this file exists to prevent.

import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";

import {
  deriveAdjudicatorEntryPda,
  deriveAmmStatePda,
  deriveLpMintAuthorityPda,
  deriveLpMintPda,
  deriveMarketVaultAta,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
} from "../src/pdas.js";
import { WAD } from "../src/math/lmsr.js";
import { bootSmoke, warpClockTo, type SmokeContext } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";
import {
  anchorProgram,
  customError,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

const BN = anchorPkg.BN;

const OUTCOME_NO = 0;
const OUTCOME_YES = 1;
const OUTCOME_INVALID = 2;
const VETO_PERIOD_SECS = 24n * 60n * 60n;

const ERR = { MarketNotSettled: 6001 } as const;

const SHARES = 10n * WAD;

function accountsFor(smoke: SmokeContext, user: PublicKey) {
  const { marketId, programs, usdcMint, ammMint } = smoke;
  const lpMint = deriveLpMintPda(marketId, programs)[0];
  return {
    position: derivePositionPda(marketId, user, programs)[0],
    lpMint,
    lpMintAuthority: deriveLpMintAuthorityPda(marketId, programs)[0],
    userLpAta: deriveUserLpAta(user, lpMint),
    vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
    marketVault: deriveMarketVaultAta(marketId, ammMint, programs),
    userUsdcAta: deriveUserUsdcAta(user, ammMint),
    marketFeePool: feePoolAmmPda(marketId, programs)[0],
    protocolConfig: deriveProtocolConfigPda(programs)[0],
    ammState: deriveAmmStatePda(marketId, programs)[0],
    adjudicatorEntry: deriveAdjudicatorEntryPda(smoke.marketPda, programs)[0],
  };
}

async function buy(
  smoke: SmokeContext,
  program: any,
  user: Keypair,
  outcome: number,
  shares: bigint,
) {
  const a = accountsFor(smoke, user.publicKey);
  await sendTx(
    smoke.ctx,
    [user],
    new Transaction()
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          user.publicKey,
          a.userLpAta,
          user.publicKey,
          a.lpMint,
        ),
      )
      .add(
        await program.methods
          .tradePositions(
            outcome,
            new BN(shares.toString()),
            new BN((100n * WAD).toString()),
          )
          .accounts({
            market: smoke.marketPda,
            ammState: a.ammState,
            position: a.position,
            vaultAuthority: a.vaultAuthority,
            userAmmAta: a.userUsdcAta,
            marketVault: a.marketVault,
            ammMint: smoke.ammMint,
            protocolConfig: a.protocolConfig,
            marketFeePool: a.marketFeePool,
            lpMint: a.lpMint,
            lpMintAuthority: a.lpMintAuthority,
            userLpAta: a.userLpAta,
            user: user.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .instruction(),
      ),
  );
}

async function redeemTx(smoke: SmokeContext, program: any, user: PublicKey) {
  const a = accountsFor(smoke, user);
  return new Transaction().add(
    await program.methods
      .redeemAmmPosition()
      .accounts({
        market: smoke.marketPda,
        vaultAuthority: a.vaultAuthority,
        position: a.position,
        vault: a.marketVault,
        userAmmAta: a.userUsdcAta,
        user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  );
}

/** Drive the market to Settled with `outcome`, crossing the veto window. */
async function settle(smoke: SmokeContext, program: any, outcome: number) {
  const a = accountsFor(smoke, smoke.creator.publicKey);
  const asCreator = anchorProgram(smoke.ctx, smoke.creator);
  await sendTx(
    smoke.ctx,
    [smoke.creator],
    new Transaction().add(
      await asCreator.methods
        .lockForResolution()
        .accounts({
          market: smoke.marketPda,
          adjudicatorEntry: a.adjudicatorEntry,
          authority: smoke.creator.publicKey,
        })
        .instruction(),
    ),
  );
  await sendTx(
    smoke.ctx,
    [smoke.creator],
    new Transaction().add(
      await asCreator.methods
        .attestOutcome(outcome)
        .accounts({
          adjudicatorEntry: a.adjudicatorEntry,
          market: smoke.marketPda,
          authority: smoke.creator.publicKey,
        })
        .instruction(),
    ),
  );
  const entry = await (asCreator.account as any).adjudicatorEntry.fetch(
    a.adjudicatorEntry,
  );
  warpClockTo(
    smoke.ctx,
    BigInt(entry.attestedAt.toString()) + VETO_PERIOD_SECS,
  );
  await sendTx(
    smoke.ctx,
    [smoke.creator],
    new Transaction().add(
      await asCreator.methods
        .settle()
        .accounts({
          market: smoke.marketPda,
          adjudicatorEntry: a.adjudicatorEntry,
          protocolConfig: a.protocolConfig,
          cranker: smoke.creator.publicKey,
        })
        .instruction(),
    ),
  );
}

async function boot() {
  const smoke = await bootSmoke();
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
  return { smoke, program, user: smoke.user };
}

describe("AMM position redemption after settlement", () => {
  it("pays a winning YES position its full share value", async () => {
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);
    const conn = new LiteSvmConnection(smoke.ctx);

    await buy(smoke, program, user, OUTCOME_YES, SHARES);
    const pos = await (program.account as any).position.fetch(a.position);
    expect(BigInt(pos.yesShares.toString())).toBe(SHARES);

    await settle(smoke, program, OUTCOME_YES);

    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [user],
      await redeemTx(smoke, program, user.publicKey),
    );
    const after = (await getAccount(conn, a.userUsdcAta)).amount;

    // 10 shares of the winning outcome pay 10 USDC (WAD floored to 6dp).
    expect(after - before).toBe(SHARES / 1_000_000_000_000n);

    const post = await (program.account as any).position.fetch(a.position);
    expect(BigInt(post.yesShares.toString())).toBe(0n);
    expect(BigInt(post.noShares.toString())).toBe(0n);
  }, 60_000);

  it("pays a losing position nothing, without failing", async () => {
    // A losing redeem must be a clean no-op, not an error — the UI will call
    // it blindly for every position the user holds.
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);
    const conn = new LiteSvmConnection(smoke.ctx);

    await buy(smoke, program, user, OUTCOME_YES, SHARES);
    await settle(smoke, program, OUTCOME_NO);

    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [user],
      await redeemTx(smoke, program, user.publicKey),
    );
    expect((await getAccount(conn, a.userUsdcAta)).amount).toBe(before);
  }, 60_000);

  it("splits an INVALID outcome down the middle, matching redeem_orderbook", async () => {
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);
    const conn = new LiteSvmConnection(smoke.ctx);

    await buy(smoke, program, user, OUTCOME_YES, SHARES);
    await settle(smoke, program, OUTCOME_INVALID);

    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [user],
      await redeemTx(smoke, program, user.publicKey),
    );
    // (yes + no) / 2 with no = 0 → half the YES leg.
    expect((await getAccount(conn, a.userUsdcAta)).amount - before).toBe(
      SHARES / 2n / 1_000_000_000_000n,
    );
  }, 60_000);

  it("cannot be called twice — the second call pays nothing", async () => {
    // The account deliberately survives redemption (claim_unlocked needs the
    // Position PDA to exist for outstanding LockEntries), so it IS callable
    // again. Zeroing the legs before the transfer is what makes that safe.
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);
    const conn = new LiteSvmConnection(smoke.ctx);

    await buy(smoke, program, user, OUTCOME_YES, SHARES);
    await settle(smoke, program, OUTCOME_YES);

    await sendTx(
      smoke.ctx,
      [user],
      await redeemTx(smoke, program, user.publicKey),
    );
    const afterFirst = (await getAccount(conn, a.userUsdcAta)).amount;

    await sendTx(
      smoke.ctx,
      [user],
      await redeemTx(smoke, program, user.publicKey),
    );
    expect((await getAccount(conn, a.userUsdcAta)).amount).toBe(afterFirst);
  }, 60_000);

  it("refuses before the market settles", async () => {
    const { smoke, program, user } = await boot();
    await buy(smoke, program, user, OUTCOME_YES, SHARES);
    await expect(
      sendTx(smoke.ctx, [user], await redeemTx(smoke, program, user.publicKey)),
    ).rejects.toThrow(customError(ERR.MarketNotSettled));
  }, 60_000);

  it("B0: the vault covers the payout because seed_lp posts the LMSR subsidy", async () => {
    // This test used to assert the opposite, and passed.
    //
    // LMSR is a SUBSIDISED market maker: it deliberately collects less from
    // traders than it owes winners, and that difference — bounded by b*ln(2) —
    // is the liquidity it provides. It has to be posted up front. `seed_lp`
    // took a `seed_deposit_wad` argument, wrote it to LpPosition, and
    // transferred nothing, so a market's vault held only trader deposits and a
    // winning position could not be paid at all: the SPL transfer aborted with
    // InsufficientFunds (0x1).
    //
    // Nobody had hit it because there was no AMM redeem path either (B1).
    // Adding one surfaced this.
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);
    const conn = new LiteSvmConnection(smoke.ctx);

    // The subsidy is in the vault before anyone trades.
    const SUBSIDY = 693_147_181n; // ceil(b * ln2 / 1e12) at b = 1000
    expect((await getAccount(conn, a.marketVault)).amount).toBe(SUBSIDY);

    await buy(smoke, program, user, OUTCOME_YES, SHARES);

    const vault = (await getAccount(conn, a.marketVault)).amount;
    const owed = SHARES / 1_000_000_000_000n; // 10 shares -> 10 USDC on a win

    // The trader paid ~5.01 USDC for something that redeems at 10.00 — the
    // ~4.99 gap is precisely what the subsidy exists to cover.
    const collected = vault - SUBSIDY;
    expect(collected).toBeLessThan(owed);
    expect(vault).toBeGreaterThanOrEqual(owed);

    await settle(smoke, program, OUTCOME_YES);

    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [user],
      await redeemTx(smoke, program, user.publicKey),
    );
    expect((await getAccount(conn, a.userUsdcAta)).amount - before).toBe(owed);

    // The shortfall came out of the subsidy, exactly as designed.
    expect((await getAccount(conn, a.marketVault)).amount).toBe(vault - owed);
  }, 60_000);

  // Everything above hand-builds the instruction with Anchor. That proves the
  // PROGRAM is right and says nothing about the builder the app actually
  // calls — and a builder that derives one account wrong fails at simulation
  // with no hint, which is how `reclaim_subsidy` shipped with invented mint
  // seeds and was caught only by running settlement for real.
  it("the SDK builder pays out the same as the hand-built instruction", async () => {
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);
    const conn = new LiteSvmConnection(smoke.ctx);

    await buy(smoke, program, user, OUTCOME_YES, SHARES);
    await settle(smoke, program, OUTCOME_YES);

    const { SolanaChainAdapter } = await import("../src/adapter.js");
    const { encodePubkeyRef } = await import("../src/refs.js");
    const adapter = new SolanaChainAdapter({
      node: {
        id: "amm-redeem-adapter",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      ammMint: smoke.ammMint,
      connection: conn,
    } as never);

    const req = await adapter.buildRedeemAmmPosition(
      encodePubkeyRef(smoke.marketPda),
      { user: encodePubkeyRef(user.publicKey) },
    );

    // Same account list, in the same order, with the same signer/writable
    // flags as the instruction the program tests drive.
    const expected = (await redeemTx(smoke, program, user.publicKey))
      .instructions[0]!;
    expect(req.accounts!.map((k) => k.pubkey)).toEqual(
      expected.keys.map((k) => k.pubkey.toBase58()),
    );
    expect(req.accounts!.map((k) => [k.isSigner, k.isWritable])).toEqual(
      expected.keys.map((k) => [k.isSigner, k.isWritable]),
    );

    // And it actually moves the money, not just parses.
    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(smoke.ctx, [user], new Transaction().add(expected));
    expect((await getAccount(conn, a.userUsdcAta)).amount - before).toBe(
      SHARES / 1_000_000_000_000n,
    );
  }, 60_000);
});
