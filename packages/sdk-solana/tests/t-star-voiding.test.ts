// T* voiding, end to end on LiteSVM.
//
// The unit tests in `sooth_core` cover the merkle shape and the payout bounds
// as pure functions. What they cannot cover is the part that only exists at
// runtime: `redeem_amm_position` reads the `ResolutionCommitment` PDA out of a
// RAW account and writes the running refund total back by hand, because the
// account's honest state is "does not exist" and Anchor cannot express that.
// This file drives the real instructions against the real program so that
// serialization round-trip is exercised rather than assumed.
//
// The mechanism is described in `docs/design/t-star-voiding.md`.

import { createHash } from "node:crypto";
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
const VETO_PERIOD_SECS = 24n * 60n * 60n;
const SHARES = 10n * WAD;

// ── merkle, rebuilt here on purpose ──────────────────────────────────────────
//
// Written against `docs/design/t-star-voiding.md` rather than imported from
// anything the program shares, so agreement between these hashes and the
// on-chain ones is evidence, not tautology.

const sha256 = (...parts: Buffer[]) =>
  createHash("sha256").update(Buffer.concat(parts)).digest();

function leafHash(
  market: PublicKey,
  user: PublicKey,
  validYesWad: bigint,
  validNoWad: bigint,
  voidRefundUsdc: bigint,
): Buffer {
  const u128 = (v: bigint) => {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0);
    b.writeBigUInt64LE(v >> 64n, 8);
    return b;
  };
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    return b;
  };
  return sha256(
    Buffer.from([0x00]),
    market.toBuffer(),
    user.toBuffer(),
    u128(validYesWad),
    u128(validNoWad),
    u64(voidRefundUsdc),
  );
}

const pairHash = (a: Buffer, b: Buffer): Buffer =>
  Buffer.compare(a, b) <= 0
    ? sha256(Buffer.from([0x01]), a, b)
    : sha256(Buffer.from([0x01]), b, a);

/** Root and per-leaf proofs, with the odd node promoted unchanged. */
function buildTree(leaves: Buffer[]): { root: Buffer; proofs: Buffer[][] } {
  const proofs: Buffer[][] = leaves.map(() => []);
  // position[k] tracks where leaf k sits in the current level.
  let position = leaves.map((_, i) => i);
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length ? pairHash(level[i], level[i + 1]) : level[i],
      );
    }
    for (const [k, pos] of position.entries()) {
      const sibling = pos % 2 === 0 ? pos + 1 : pos - 1;
      if (sibling < level.length) proofs[k].push(level[sibling]);
    }
    position = position.map((pos) => Math.floor(pos / 2));
    level = next;
  }
  return { root: level[0], proofs };
}

// ── fixture plumbing ─────────────────────────────────────────────────────────

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

/** Lock + attest, stopping INSIDE the veto window — where publishing lives. */
async function lockAndAttest(smoke: SmokeContext, outcome: number) {
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
  return BigInt(entry.attestedAt.toString());
}

async function settleAfterVeto(smoke: SmokeContext, attestedAt: bigint) {
  const a = accountsFor(smoke, smoke.creator.publicKey);
  const asCreator = anchorProgram(smoke.ctx, smoke.creator);
  warpClockTo(smoke.ctx, attestedAt + VETO_PERIOD_SECS);
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

async function publish(
  smoke: SmokeContext,
  root: Buffer,
  tStar: bigint,
  leafCount: number,
  totalVoidRefund: bigint,
) {
  const a = accountsFor(smoke, smoke.creator.publicKey);
  const asCreator = anchorProgram(smoke.ctx, smoke.creator);
  await sendTx(
    smoke.ctx,
    [smoke.creator],
    new Transaction().add(
      await asCreator.methods
        .publishResolutionCommitment({
          merkleRoot: Array.from(root),
          tStar: new BN(tStar.toString()),
          leafCount,
          totalVoidRefundUsdc: new BN(totalVoidRefund.toString()),
        })
        .accounts({
          resolutionCommitment: a.resolutionCommitment,
          market: smoke.marketPda,
          adjudicatorEntry: a.adjudicatorEntry,
          protocolConfig: a.protocolConfig,
          authority: smoke.creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ),
  );
}

async function redeem(
  smoke: SmokeContext,
  program: any,
  user: PublicKey,
  claim: {
    validYesWad: bigint;
    validNoWad: bigint;
    voidRefundUsdc: bigint;
    proof: Buffer[];
  } | null,
) {
  const a = accountsFor(smoke, user);
  const arg =
    claim === null
      ? null
      : {
          validYesWad: new BN(claim.validYesWad.toString()),
          validNoWad: new BN(claim.validNoWad.toString()),
          voidRefundUsdc: new BN(claim.voidRefundUsdc.toString()),
          proof: claim.proof.map((p) => Array.from(p)),
        };
  return new Transaction().add(
    await program.methods
      .redeemAmmPosition(arg)
      .accounts({
        market: smoke.marketPda,
        ammState: a.ammState,
        vaultAuthority: a.vaultAuthority,
        position: a.position,
        vault: a.marketVault,
        userAmmAta: a.userUsdcAta,
        resolutionCommitment: a.resolutionCommitment,
        user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  );
}

/** A market bought into by one user, locked and attested YES. */
async function boot() {
  const smoke = await bootSmoke();
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
  const user = smoke.user;
  await buy(smoke, program, user, OUTCOME_YES, SHARES);
  const a = accountsFor(smoke, user.publicKey);
  const position = await (program.account as any).position.fetch(a.position);
  const attestedAt = await lockAndAttest(smoke, OUTCOME_YES);
  const market = await (program.account as any).market.fetch(smoke.marketPda);
  // T* must sit inside (start_time, min(attested_at, deadline)].
  const tStar = BigInt(
    Math.min(Number(market.deadline.toString()), Number(attestedAt)),
  );
  return {
    smoke,
    program,
    user,
    a,
    attestedAt,
    tStar,
    lockedCost: BigInt(position.lockedCostUsdc.toString()),
  };
}

/** Leaves for `user` plus three decoys, so proofs are never empty. */
function treeFor(
  market: PublicKey,
  user: PublicKey,
  validYesWad: bigint,
  voidRefundUsdc: bigint,
) {
  const leaves = [
    leafHash(market, user, validYesWad, 0n, voidRefundUsdc),
    leafHash(market, Keypair.generate().publicKey, 1n, 0n, 0n),
    leafHash(market, Keypair.generate().publicKey, 2n, 0n, 0n),
  ];
  const { root, proofs } = buildTree(leaves);
  return { root, proof: proofs[0], leafCount: leaves.length };
}

describe("T* voiding", () => {
  it("pays a voided position its valid shares plus its refund", async () => {
    const { smoke, program, user, a, tStar, lockedCost } = await boot();
    const conn = new LiteSvmConnection(smoke.ctx);

    // 10 YES held; only 4 of them were bought before T*, and 1 USDC of the
    // rest is returned at cost.
    const validYes = 4n * WAD;
    const refund = 1_000_000n;
    expect(lockedCost).toBeGreaterThan(refund);
    const { root, proof, leafCount } = treeFor(
      smoke.marketPda,
      user.publicKey,
      validYes,
      refund,
    );
    await publish(smoke, root, tStar, leafCount, refund);

    const commitment = await (program.account as any).resolutionCommitment.fetch(
      a.resolutionCommitment,
    );
    expect(Buffer.from(commitment.merkleRoot)).toEqual(root);
    expect(BigInt(commitment.tStar.toString())).toBe(tStar);

    await settleAfterVetoFor(smoke, program);

    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [user],
      await redeem(smoke, program, user.publicKey, {
        validYesWad: validYes,
        validNoWad: 0n,
        voidRefundUsdc: refund,
        proof,
      }),
    );
    const after = (await getAccount(conn, a.userUsdcAta)).amount;

    // 4 shares at 1 USDC each, plus the refund — NOT the 10 USDC an
    // unvoided position of this size would have been paid.
    expect(after - before).toBe(4_000_000n + refund);

    const post = await (program.account as any).resolutionCommitment.fetch(
      a.resolutionCommitment,
    );
    expect(BigInt(post.voidRefundPaidUsdc.toString())).toBe(refund);
  });

  it("refuses a full-value redemption once a commitment exists", async () => {
    // The bypass the extra account exists to close.
    const { smoke, program, user, tStar } = await boot();
    const { root, leafCount } = treeFor(
      smoke.marketPda,
      user.publicKey,
      4n * WAD,
      0n,
    );
    await publish(smoke, root, tStar, leafCount, 0n);
    await settleAfterVetoFor(smoke, program);

    await expect(
      sendTx(
        smoke.ctx,
        [user],
        await redeem(smoke, program, user.publicKey, null),
      ),
    ).rejects.toThrow();
  });

  it("refuses an inflated entitlement", async () => {
    const { smoke, program, user, tStar } = await boot();
    const validYes = 4n * WAD;
    const { root, proof, leafCount } = treeFor(
      smoke.marketPda,
      user.publicKey,
      validYes,
      0n,
    );
    await publish(smoke, root, tStar, leafCount, 0n);
    await settleAfterVetoFor(smoke, program);

    await expect(
      sendTx(
        smoke.ctx,
        [user],
        await redeem(smoke, program, user.publicKey, {
          validYesWad: validYes + WAD,
          validNoWad: 0n,
          voidRefundUsdc: 0n,
          proof,
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses a refund beyond the published total", async () => {
    // Per-leaf bounds can all pass and still drain a vault in aggregate;
    // this is the ceiling that stops it.
    const { smoke, program, user, tStar, lockedCost } = await boot();
    const refund = 1_000_000n;
    expect(lockedCost).toBeGreaterThan(refund);
    const { root, proof, leafCount } = treeFor(
      smoke.marketPda,
      user.publicKey,
      0n,
      refund,
    );
    // Published total is one base unit short of this single leaf's refund.
    await publish(smoke, root, tStar, leafCount, refund - 1n);
    await settleAfterVetoFor(smoke, program);

    await expect(
      sendTx(
        smoke.ctx,
        [user],
        await redeem(smoke, program, user.publicKey, {
          validYesWad: 0n,
          validNoWad: 0n,
          voidRefundUsdc: refund,
          proof,
        }),
      ),
    ).rejects.toThrow();
  });

  it("revoking inside the veto window restores the ordinary payout", async () => {
    const { smoke, program, user, a, tStar } = await boot();
    const conn = new LiteSvmConnection(smoke.ctx);
    const { root, leafCount } = treeFor(
      smoke.marketPda,
      user.publicKey,
      4n * WAD,
      0n,
    );
    await publish(smoke, root, tStar, leafCount, 0n);

    const asCreator = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await asCreator.methods
          .revokeResolutionCommitment()
          .accounts({
            resolutionCommitment: a.resolutionCommitment,
            market: smoke.marketPda,
            adjudicatorEntry: a.adjudicatorEntry,
            protocolConfig: a.protocolConfig,
            publisher: smoke.creator.publicKey,
            disputeAuthority: smoke.creator.publicKey,
          })
          .instruction(),
      ),
    );

    await settleAfterVetoFor(smoke, program);

    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [user],
      await redeem(smoke, program, user.publicKey, null),
    );
    const after = (await getAccount(conn, a.userUsdcAta)).amount;
    // The full 10 shares — as if voiding had never been attempted.
    expect(after - before).toBe(10_000_000n);
  });

  it("refuses a commitment once the veto window has closed", async () => {
    const { smoke, program, user, tStar } = await boot();
    const { root, leafCount } = treeFor(
      smoke.marketPda,
      user.publicKey,
      4n * WAD,
      0n,
    );
    await settleAfterVetoFor(smoke, program);
    await expect(publish(smoke, root, tStar, leafCount, 0n)).rejects.toThrow();
  });

  it("agrees with the program on what a leaf hashes to", async () => {
    // If the two implementations of the leaf preimage ever disagree, every
    // proof in the world stops verifying. This is that canary: the root is
    // computed here and the proof is accepted on-chain.
    const { smoke, program, user, tStar } = await boot();
    const { root, proof, leafCount } = treeFor(
      smoke.marketPda,
      user.publicKey,
      1n * WAD,
      0n,
    );
    expect(proof.length).toBe(2);
    await publish(smoke, root, tStar, leafCount, 0n);
    await settleAfterVetoFor(smoke, program);
    await sendTx(
      smoke.ctx,
      [user],
      await redeem(smoke, program, user.publicKey, {
        validYesWad: 1n * WAD,
        validNoWad: 0n,
        voidRefundUsdc: 0n,
        proof,
      }),
    );
  });
});

/** Warp past the veto window using the entry's own attestation time. */
async function settleAfterVetoFor(smoke: SmokeContext, program: any) {
  const a = accountsFor(smoke, smoke.creator.publicKey);
  const entry = await (program.account as any).adjudicatorEntry.fetch(
    a.adjudicatorEntry,
  );
  await settleAfterVeto(smoke, BigInt(entry.attestedAt.toString()));
}
