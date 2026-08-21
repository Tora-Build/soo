// The abandonment escape hatch, end to end on LiteSVM.
//
// `settle` needs an attested outcome, so an adjudicator who vanishes between
// the lock and the attestation used to freeze a market forever — every
// position, LP stake and escrowed sell inside it unreachable, because none of
// them has a payout path that does not run through settlement.
//
// `force_invalid_attestation` is the door out. It is permissionless, it fires
// on a timeout measured from the market's own deadline, and it writes an
// ATTESTATION rather than a settlement — so the ordinary veto window still
// stands between it and a final outcome. See `instructions/settle.rs`.
//
// What only a runtime test can show, and this file does: the timeout boundary
// in both directions, and a holder actually being paid afterwards.

import { describe, expect, it } from "vitest";
import {
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
  deriveMarketVaultAmm,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveResolutionCommitmentPda,
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
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

const BN = anchorPkg.BN;

const OUTCOME_YES = 1;
const OUTCOME_INVALID = 2;
const VETO_PERIOD_SECS = 24n * 60n * 60n;
/// Mirrors `settle::ABANDONED_MARKET_TIMEOUT_SECS`. Written out rather than
/// imported so a change to the constant fails here instead of tracking it.
const ABANDONED_TIMEOUT_SECS = 14n * 24n * 60n * 60n;
const SHARES = 10n * WAD;

function accountsFor(smoke: SmokeContext, user: PublicKey) {
  const { marketId, programs, ammMint } = smoke;
  const lpMint = deriveLpMintPda(marketId, programs)[0];
  return {
    position: derivePositionPda(marketId, user, programs)[0],
    lpMint,
    lpMintAuthority: deriveLpMintAuthorityPda(marketId, programs)[0],
    userLpAta: deriveUserLpAta(user, lpMint),
    vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
    marketVault: deriveMarketVaultAmm(marketId, programs),
    userUsdcAta: deriveUserUsdcAta(user, ammMint),
    marketFeePool: feePoolAmmPda(marketId, programs)[0],
    protocolConfig: deriveProtocolConfigPda(programs)[0],
    ammState: deriveAmmStatePda(marketId, programs)[0],
    adjudicatorEntry: deriveAdjudicatorEntryPda(smoke.marketPda, programs)[0],
    resolutionCommitment: deriveResolutionCommitmentPda(
      smoke.marketPda,
      programs,
    )[0],
  };
}

async function buy(
  smoke: SmokeContext,
  program: any,
  user: any,
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

/// The permissionless post-deadline lock. Deliberately NOT the adjudicator's
/// `lock_for_resolution`: the whole scenario is that nobody holds that key any
/// more.
async function requestLock(smoke: SmokeContext) {
  const a = accountsFor(smoke, smoke.user.publicKey);
  const asStranger = anchorProgram(smoke.ctx, smoke.user);
  await sendTx(
    smoke.ctx,
    [smoke.user],
    new Transaction().add(
      await asStranger.methods
        .requestLock()
        .accounts({
          adjudicatorEntry: a.adjudicatorEntry,
          market: smoke.marketPda,
          authority: smoke.user.publicKey,
        })
        .instruction(),
    ),
  );
}

async function forceInvalid(smoke: SmokeContext) {
  const a = accountsFor(smoke, smoke.user.publicKey);
  const asStranger = anchorProgram(smoke.ctx, smoke.user);
  await sendTx(
    smoke.ctx,
    [smoke.user],
    new Transaction().add(
      await asStranger.methods
        .forceInvalidAttestation()
        .accounts({
          market: smoke.marketPda,
          adjudicatorEntry: a.adjudicatorEntry,
          cranker: smoke.user.publicKey,
        })
        .instruction(),
    ),
  );
}

async function settle(smoke: SmokeContext) {
  const a = accountsFor(smoke, smoke.user.publicKey);
  const asStranger = anchorProgram(smoke.ctx, smoke.user);
  await sendTx(
    smoke.ctx,
    [smoke.user],
    new Transaction().add(
      await asStranger.methods
        .settle()
        .accounts({
          market: smoke.marketPda,
          adjudicatorEntry: a.adjudicatorEntry,
          protocolConfig: a.protocolConfig,
          cranker: smoke.user.publicKey,
        })
        .instruction(),
    ),
  );
}

/// A market one user has bought into, and whose adjudicator then went silent.
async function abandoned() {
  const smoke = await bootSmoke();
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
  await buy(smoke, program, smoke.user, OUTCOME_YES, SHARES);
  const market = await (program.account as any).market.fetch(smoke.marketPda);
  const deadline = BigInt(market.deadline.toString());
  return { smoke, program, deadline, a: accountsFor(smoke, smoke.user.publicKey) };
}

describe("an abandoned market", () => {
  it("cannot be forced to INVALID before the timeout", async () => {
    const { smoke, deadline } = await abandoned();
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);

    // One second short, on a market that is locked, unattested, and past its
    // deadline. Everything is in place except the wait.
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS - 1n);
    await expect(forceInvalid(smoke)).rejects.toThrow();
  });

  it("is forced to INVALID the second the timeout lands, and pays its holder", async () => {
    const { smoke, program, deadline, a } = await abandoned();
    const conn = new LiteSvmConnection(smoke.ctx);
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);

    // The other side of the same boundary.
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS);
    await forceInvalid(smoke);

    const entry = await (program.account as any).adjudicatorEntry.fetch(
      a.adjudicatorEntry,
    );
    expect(entry.attestedOutcome).toBe(OUTCOME_INVALID);
    expect(entry.forcedInvalid).toBe(true);

    // Forcing is not settling: the veto window still has to run.
    await expect(settle(smoke)).rejects.toThrow();
    const attestedAt = BigInt(entry.attestedAt.toString());
    warpClockTo(smoke.ctx, attestedAt + VETO_PERIOD_SECS);
    await settle(smoke);

    const market = await (program.account as any).market.fetch(smoke.marketPda);
    expect(market.winningOutcome).toBe(OUTCOME_INVALID);

    // And the holder gets their money — the INVALID split, half of every
    // share, out of a market that used to be a black hole.
    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [smoke.user],
      new Transaction().add(
        await program.methods
          .redeemAmmPosition(null)
          .accounts({
            market: smoke.marketPda,
            ammState: a.ammState,
            vaultAuthority: a.vaultAuthority,
            position: a.position,
            vault: a.marketVault,
            userAmmAta: a.userUsdcAta,
            resolutionCommitment: a.resolutionCommitment,
            user: smoke.user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ),
    );
    const after = (await getAccount(conn, a.userUsdcAta)).amount;
    // 10 YES shares, split down the middle: 5.00 USDC.
    expect(after - before).toBe(5_000_000n);
  });

  it("is never forced while an outcome is on record", async () => {
    const { smoke, deadline } = await abandoned();
    const a = accountsFor(smoke, smoke.creator.publicKey);
    const asCreator = anchorProgram(smoke.ctx, smoke.creator);
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await asCreator.methods
          .attestOutcome(OUTCOME_YES)
          .accounts({
            adjudicatorEntry: a.adjudicatorEntry,
            market: smoke.marketPda,
            authority: smoke.creator.publicKey,
          })
          .instruction(),
      ),
    );

    // An adjudicator who answered is not an adjudicator who vanished, however
    // long ago they answered. Overriding them is `dispute`'s job.
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS + 1n);
    await expect(forceInvalid(smoke)).rejects.toThrow();
  });

  it("cannot take the market from an adjudicator who was merely late", async () => {
    const { smoke, program, deadline, a } = await abandoned();
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS);
    await forceInvalid(smoke);

    // The real authority attests over the forced outcome, inside the window.
    const asCreator = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await asCreator.methods
          .attestOutcome(OUTCOME_YES)
          .accounts({
            adjudicatorEntry: a.adjudicatorEntry,
            market: smoke.marketPda,
            authority: smoke.creator.publicKey,
          })
          .instruction(),
      ),
    );
    const entry = await (program.account as any).adjudicatorEntry.fetch(
      a.adjudicatorEntry,
    );
    expect(entry.attestedOutcome).toBe(OUTCOME_YES);
    expect(entry.forcedInvalid).toBe(false);

    // And the exception closes behind it: the entry is one-shot again.
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        new Transaction().add(
          await asCreator.methods
            .attestOutcome(OUTCOME_INVALID)
            .accounts({
              adjudicatorEntry: a.adjudicatorEntry,
              market: smoke.marketPda,
              authority: smoke.creator.publicKey,
            })
            .instruction(),
        ),
      ),
    ).rejects.toThrow();
  });
});
