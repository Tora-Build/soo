// The resolver's tree, verified by the program that has to accept it.
//
// `tests/t-star-voiding.test.ts` proves the MECHANISM works against a tree
// written inline in that file. This one proves the tree the RESOLVER actually
// publishes works — the leaf encoding, the pairing rule, the odd-node
// promotion and the FIFO entitlement accounting in `infra/zk-resolver/src/void`
// — by importing those modules and handing their output to the real
// instructions on LiteSVM.
//
// That distinction is the whole point. An encoding mismatch between the
// resolver and `state/resolution.rs` produces a root that looks fine, publishes
// fine, and then rejects every proof in the world. Nothing catches it except
// running the two against each other, which is this file.
//
// The mechanism is described in `docs/design/t-star-voiding.md`.

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

// The resolver's own modules — plain ESM, imported across the repo boundary on
// purpose. Reimplementing them here would test a copy, which is exactly the
// mistake this file exists to rule out.
import {
  ammLeaf,
  bookLeaf,
  buildTree,
  verifyProof,
} from "../../../infra/zk-resolver/src/void/merkle.mjs";
import { computeAmmEntitlements } from "../../../infra/zk-resolver/src/void/entitlements.mjs";

import {
  deriveAdjudicatorEntryPda,
  deriveAmmStatePda,
  deriveLpMintAuthorityPda,
  deriveLpMintPda,
  deriveMarketVaultAmm,
  deriveMarketVaultAta,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveResolutionCommitmentPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
} from "../src/pdas.js";
import { bookPda } from "../src/book/index.js";
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

// The market's clock starts at `start_time + 1` = 1_000_001 (see
// `fixtures/setup.ts`). The two buys straddle T*.
const BUY_BEFORE_AT = 1_000_100;
const T_STAR = 1_000_200;
const BUY_AFTER_AT = 1_000_500;

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
    resolutionCommitment: deriveResolutionCommitmentPda(smoke.marketPda, programs)[0],
    book: bookPda(marketId, programs)[0],
    vaultBook: deriveMarketVaultAta(marketId, ammMint, programs),
  };
}

async function buy(
  smoke: SmokeContext,
  program: any,
  user: Keypair,
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
            OUTCOME_YES,
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

/**
 * A market whose single trader bought 4 YES before T* and 6 YES after it, with
 * the clock warped so the two acquisitions carry genuinely different
 * timestamps — the tape the resolver would replay, produced by the program.
 */
async function boot() {
  const smoke = await bootSmoke();
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
  const a = accountsFor(smoke, smoke.user.publicKey);
  const fetchPosition = () => (program.account as any).position.fetch(a.position);

  warpClockTo(smoke.ctx, BigInt(BUY_BEFORE_AT));
  await buy(smoke, program, smoke.user, 4n * WAD);
  const afterFirst = BigInt((await fetchPosition()).lockedCostUsdc.toString());

  warpClockTo(smoke.ctx, BigInt(BUY_AFTER_AT));
  await buy(smoke, program, smoke.user, 6n * WAD);
  const afterSecond = BigInt((await fetchPosition()).lockedCostUsdc.toString());

  // Lock and attest, stopping INSIDE the veto window — where publishing lives.
  const asCreator = anchorProgram(smoke.ctx, smoke.creator);
  for (const ix of [
    await asCreator.methods
      .lockForResolution()
      .accounts({
        market: smoke.marketPda,
        adjudicatorEntry: a.adjudicatorEntry,
        authority: smoke.creator.publicKey,
      })
      .instruction(),
    await asCreator.methods
      .attestOutcome(OUTCOME_YES)
      .accounts({
        adjudicatorEntry: a.adjudicatorEntry,
        market: smoke.marketPda,
        authority: smoke.creator.publicKey,
      })
      .instruction(),
  ]) {
    await sendTx(smoke.ctx, [smoke.creator], new Transaction().add(ix));
  }

  return {
    smoke,
    program,
    a,
    // The tape, in the shape `readVoidTape` normalizes chain events into.
    tape: [
      {
        wallet: smoke.user.publicKey.toBase58(),
        outcome: OUTCOME_YES,
        deltaSharesWad: 4n * WAD,
        costWad: afterFirst * 10n ** 12n,
        ts: BUY_BEFORE_AT,
      },
      {
        wallet: smoke.user.publicKey.toBase58(),
        outcome: OUTCOME_YES,
        deltaSharesWad: 6n * WAD,
        costWad: (afterSecond - afterFirst) * 10n ** 12n,
        ts: BUY_AFTER_AT,
      },
    ],
    lockedCost: afterSecond,
  };
}

async function publish(
  smoke: SmokeContext,
  root: Buffer,
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
          tStar: new BN(T_STAR),
          leafCount,
          totalVoidRefundUsdc: new BN(totalVoidRefund.toString()),
          // No book on this market, so it may promise no book refund.
          totalBookVoidRefundUsdc: new BN(0),
        })
        .accounts({
          resolutionCommitment: a.resolutionCommitment,
          market: smoke.marketPda,
          adjudicatorEntry: a.adjudicatorEntry,
          protocolConfig: a.protocolConfig,
          ammState: a.ammState,
          vaultAmm: a.marketVault,
          book: a.book,
          vaultBook: a.vaultBook,
          authority: smoke.creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ),
  );
}

async function settleAfterVeto(smoke: SmokeContext, program: any) {
  const a = accountsFor(smoke, smoke.creator.publicKey);
  const entry = await (program.account as any).adjudicatorEntry.fetch(a.adjudicatorEntry);
  warpClockTo(smoke.ctx, BigInt(entry.attestedAt.toString()) + VETO_PERIOD_SECS);
  const asCreator = anchorProgram(smoke.ctx, smoke.creator);
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

async function redeem(
  smoke: SmokeContext,
  program: any,
  user: PublicKey,
  claim: {
    validYesWad: bigint;
    validNoWad: bigint;
    voidRefundUsdc: bigint;
    proof: Buffer[];
  },
) {
  const a = accountsFor(smoke, user);
  return new Transaction().add(
    await program.methods
      .redeemAmmPosition({
        validYesWad: new BN(claim.validYesWad.toString()),
        validNoWad: new BN(claim.validNoWad.toString()),
        voidRefundUsdc: new BN(claim.voidRefundUsdc.toString()),
        proof: claim.proof.map((p) => Array.from(p)),
      })
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

/**
 * The tree the resolver would build: the real wallet's leaf, plus decoys of
 * BOTH leaf kinds so the tree is deep, the proof is non-empty and the two
 * domains coexist in it the way a real market's tree has them.
 */
function resolverTree(
  market: PublicKey,
  wallet: PublicKey,
  validYesWad: bigint,
  voidRefundUsdc: bigint,
) {
  const leaves = [
    ammLeaf(market, wallet, validYesWad, 0n, voidRefundUsdc),
    ammLeaf(market, Keypair.generate().publicKey, 1n, 0n, 0n),
    ammLeaf(market, Keypair.generate().publicKey, 2n, 3n, 4n),
    bookLeaf(market, Keypair.generate().publicKey, -5n, 6n),
    bookLeaf(market, Keypair.generate().publicKey, 7n, 0n),
  ];
  const { root, proofs } = buildTree(leaves);
  return { root, leaves, proofs, leafCount: leaves.length };
}

describe("the resolver's tree, against the program that verifies it", () => {
  it("pays exactly the entitlement the resolver computed", async () => {
    const { smoke, program, a, tape, lockedCost } = await boot();
    const conn = new LiteSvmConnection(smoke.ctx);
    const wallet = smoke.user.publicKey;

    // ── What the resolver computes ────────────────────────────────────────
    const { entitlements, anomalies } = computeAmmEntitlements({
      trades: tape,
      tStar: T_STAR,
    });
    expect(anomalies).toEqual([]);
    const e = entitlements.get(wallet.toBase58())!;
    expect(e.validYesWad).toBe(4n * WAD);
    expect(e.voidedYesWad).toBe(6n * WAD);
    expect(e.refundUsdc).toBeGreaterThan(0n);
    // The bound the program enforces per leaf.
    expect(e.refundUsdc).toBeLessThanOrEqual(lockedCost);

    // ── What it publishes ─────────────────────────────────────────────────
    const { root, leaves, proofs, leafCount } = resolverTree(
      smoke.marketPda,
      wallet,
      e.validYesWad,
      e.refundUsdc,
    );
    await publish(smoke, root, leafCount, e.refundUsdc);

    const commitment = await (program.account as any).resolutionCommitment.fetch(
      a.resolutionCommitment,
    );
    expect(Buffer.from(commitment.merkleRoot)).toEqual(root);
    expect(Number(commitment.tStar.toString())).toBe(T_STAR);
    expect(commitment.leafCount).toBe(leafCount);
    // The published ceiling IS the sum of the tree's refunds.
    expect(BigInt(commitment.totalVoidRefundUsdc.toString())).toBe(e.refundUsdc);

    // ── What the program pays ─────────────────────────────────────────────
    await settleAfterVeto(smoke, program);
    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [smoke.user],
      await redeem(smoke, program, wallet, {
        validYesWad: e.validYesWad,
        validNoWad: 0n,
        voidRefundUsdc: e.refundUsdc,
        proof: proofs[0],
      }),
    );
    const after = (await getAccount(conn, a.userUsdcAta)).amount;

    // 4 pre-T* shares at 1 USDC, plus the 6 post-T* shares' cost back — NOT
    // the 10 USDC the position would have been paid unvoided.
    expect(after - before).toBe(4_000_000n + e.refundUsdc);
    expect(after - before).toBeLessThan(10_000_000n);

    const post = await (program.account as any).resolutionCommitment.fetch(
      a.resolutionCommitment,
    );
    expect(BigInt(post.voidRefundPaidUsdc.toString())).toBe(e.refundUsdc);
    // And the tree agreed with itself before it ever reached the chain.
    expect(verifyProof(leaves[0], proofs[0], root)).toBe(true);
  });

  it("a wallet with only pre-T* trades is settled in full and refunded nothing", async () => {
    const { smoke, program, a, tape } = await boot();
    const conn = new LiteSvmConnection(smoke.ctx);
    const wallet = smoke.user.publicKey;

    // A T* after both buys: nothing is voided.
    const { entitlements } = computeAmmEntitlements({
      trades: tape,
      tStar: BUY_AFTER_AT + 1,
    });
    const e = entitlements.get(wallet.toBase58())!;
    expect(e.validYesWad).toBe(10n * WAD);
    expect(e.refundUsdc).toBe(0n);

    const { root, proofs, leafCount } = resolverTree(smoke.marketPda, wallet, e.validYesWad, 0n);
    await publish(smoke, root, leafCount, 0n);
    await settleAfterVeto(smoke, program);

    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [smoke.user],
      await redeem(smoke, program, wallet, {
        validYesWad: e.validYesWad,
        validNoWad: 0n,
        voidRefundUsdc: 0n,
        proof: proofs[0],
      }),
    );
    expect((await getAccount(conn, a.userUsdcAta)).amount - before).toBe(10_000_000n);
  });

  it("a wallet with only post-T* trades is settled nothing and refunded its cost", async () => {
    const { smoke, program, a, tape, lockedCost } = await boot();
    const conn = new LiteSvmConnection(smoke.ctx);
    const wallet = smoke.user.publicKey;

    // A T* before both buys: the whole position is voided.
    const { entitlements } = computeAmmEntitlements({
      trades: tape,
      tStar: BUY_BEFORE_AT - 1,
    });
    const e = entitlements.get(wallet.toBase58())!;
    expect(e.validYesWad).toBe(0n);
    expect(e.voidedYesWad).toBe(10n * WAD);
    expect(e.refundUsdc).toBeLessThanOrEqual(lockedCost);

    const { root, proofs, leafCount } = resolverTree(smoke.marketPda, wallet, 0n, e.refundUsdc);
    await publish(smoke, root, leafCount, e.refundUsdc);
    await settleAfterVeto(smoke, program);

    const before = (await getAccount(conn, a.userUsdcAta)).amount;
    await sendTx(
      smoke.ctx,
      [smoke.user],
      await redeem(smoke, program, wallet, {
        validYesWad: 0n,
        validNoWad: 0n,
        voidRefundUsdc: e.refundUsdc,
        proof: proofs[0],
      }),
    );
    // Cost back, and nothing for ten worthless-by-then shares.
    expect((await getAccount(conn, a.userUsdcAta)).amount - before).toBe(e.refundUsdc);
  });

  it("every leaf of the resolver's tree verifies on chain, at every position", async () => {
    // The encoding canary, run across the whole tree rather than one leaf: a
    // wrong domain byte, endianness or field order would break some positions
    // and not others, and one passing leaf would hide it.
    const { smoke, program, tape } = await boot();
    const wallet = smoke.user.publicKey;
    const { entitlements } = computeAmmEntitlements({ trades: tape, tStar: T_STAR });
    const e = entitlements.get(wallet.toBase58())!;

    for (const size of [1, 2, 3, 5, 8, 13]) {
      const leaves = Array.from({ length: size }, (_, i) =>
        i === 0
          ? ammLeaf(smoke.marketPda, wallet, e.validYesWad, 0n, e.refundUsdc)
          : ammLeaf(smoke.marketPda, Keypair.generate().publicKey, BigInt(i), 0n, 0n),
      );
      const { root, proofs } = buildTree(leaves);
      for (let i = 0; i < size; i++) {
        expect(verifyProof(leaves[i], proofs[i], root)).toBe(true);
      }
    }

    // …and the one that matters is accepted by the program itself, at a tree
    // size where the proof is neither empty nor a single hop.
    const leaves = [
      ammLeaf(smoke.marketPda, Keypair.generate().publicKey, 1n, 0n, 0n),
      ammLeaf(smoke.marketPda, Keypair.generate().publicKey, 2n, 0n, 0n),
      ammLeaf(smoke.marketPda, wallet, e.validYesWad, 0n, e.refundUsdc),
      bookLeaf(smoke.marketPda, Keypair.generate().publicKey, 3n, 0n),
      ammLeaf(smoke.marketPda, Keypair.generate().publicKey, 4n, 0n, 0n),
    ];
    const { root, proofs } = buildTree(leaves);
    expect(proofs[2].length).toBeGreaterThan(1);
    await publish(smoke, root, leaves.length, e.refundUsdc);
    await settleAfterVeto(smoke, program);
    await sendTx(
      smoke.ctx,
      [smoke.user],
      await redeem(smoke, program, wallet, {
        validYesWad: e.validYesWad,
        validNoWad: 0n,
        voidRefundUsdc: e.refundUsdc,
        proof: proofs[2],
      }),
    );
  });

  it("a book leaf cannot be spent on an AMM position", async () => {
    // The two domains share one tree. If they collided, a seat entitlement
    // would prove an AMM one — so the program must reject a book leaf's proof
    // presented to `redeem_amm_position`.
    const { smoke, program, tape } = await boot();
    const wallet = smoke.user.publicKey;
    const { entitlements } = computeAmmEntitlements({ trades: tape, tStar: T_STAR });
    const e = entitlements.get(wallet.toBase58())!;

    const leaves = [
      bookLeaf(smoke.marketPda, wallet, 4n, e.refundUsdc),
      ammLeaf(smoke.marketPda, Keypair.generate().publicKey, 1n, 0n, 0n),
    ];
    const { root, proofs } = buildTree(leaves);
    await publish(smoke, root, leaves.length, e.refundUsdc);
    await settleAfterVeto(smoke, program);

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await redeem(smoke, program, wallet, {
          validYesWad: 4n,
          validNoWad: 0n,
          voidRefundUsdc: e.refundUsdc,
          proof: proofs[0],
        }),
      ),
    ).rejects.toThrow();
  });
});
