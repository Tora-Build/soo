// The end of a market's life: sweep the unowed surplus, close the accounts,
// and make sure the id can never come back.
//
// Three properties, in rising order of importance:
//
// 1. `redeem_amm_position` retires shares from `AmmState.q` as it pays, so
//    "every winner has claimed" is a provable on-chain fact rather than a
//    guess about elapsed time.
//
// 2. `sweep_residual` refuses while winning shares are outstanding. This is
//    the line between "surplus" and "someone's unclaimed payout" — a naive
//    balance check cannot tell them apart, and getting it wrong takes a slow
//    claimant's money.
//
// 3. `close_market` leaves a TOMBSTONE. Full deletion would let
//    `create_market` re-init the same market_id, and every Position PDA from
//    the dead market — derived from that id — would deserialize against the
//    new one. The resurrection test below is the most important test in this
//    file: it is the difference between a rent-reclaim feature and an
//    everyone-can-mint-shares exploit.

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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";

const { BN } = anchorPkg;

import {
  deriveAdjudicatorEntryPda,
  deriveAmmStatePda,
  deriveFeePoolAuthorityPda,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveLpMintAuthorityPda,
  deriveLpMintPda,
  deriveLpPositionPda,
  deriveLpYieldAuthority,
  deriveMarketVaultAta,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
  feePoolBookPda,
  deriveMarketPda,
} from "../src/pdas.js";
import { WAD } from "../src/math/lmsr.js";
import { bootSmoke, warpClockTo, type SmokeContext } from "./fixtures/setup.js";
import {
  anchorProgram,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

const OUTCOME_YES = 1;
const VETO = 24n * 60n * 60n;
const ERR = {
  MarketNotClosable: 6067,
  VaultNotEmpty: 6068,
  OutstandingClaims: 6071,
  Unauthorized: 6019,
} as const;

function codeOf(err: unknown): number | undefined {
  const m = String((err as Error)?.message ?? err).match(
    /custom program error: 0x([0-9a-f]+)/i,
  );
  return m ? parseInt(m[1], 16) : undefined;
}

async function tokenBal(smoke: SmokeContext, addr: PublicKey): Promise<bigint> {
  const acc = await smoke.ctx.banksClient.getAccount(addr);
  if (!acc || acc.data.length < 72) return 0n;
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

function accts(smoke: SmokeContext, user: PublicKey) {
  const { marketId, programs, ammMint } = smoke;
  const lpMint = deriveLpMintPda(marketId, programs)[0];
  return {
    position: derivePositionPda(marketId, user, programs)[0],
    lpMint,
    lpMintAuthority: deriveLpMintAuthorityPda(marketId, programs)[0],
    userLpAta: deriveUserLpAta(user, lpMint),
    vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
    marketVault: deriveMarketVaultAta(marketId, ammMint, programs),
    userAmmAta: deriveUserUsdcAta(user, ammMint),
    feePoolAmm: feePoolAmmPda(marketId, programs)[0],
    protocolConfig: deriveProtocolConfigPda(programs)[0],
    ammState: deriveAmmStatePda(marketId, programs)[0],
    adjudicatorEntry: deriveAdjudicatorEntryPda(smoke.marketPda, programs)[0],
  };
}

async function buy(smoke: SmokeContext, program: any, user: Keypair, shares: bigint, outcome = OUTCOME_YES) {
  const a = accts(smoke, user.publicKey);
  await sendTx(
    smoke.ctx,
    [user],
    new Transaction()
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          user.publicKey, a.userLpAta, user.publicKey, a.lpMint,
        ),
      )
      .add(
        await program.methods
          .tradePositions(outcome, new BN(shares.toString()), new BN((100n * WAD).toString()))
          .accounts({
            market: smoke.marketPda,
            ammState: a.ammState,
            position: a.position,
            vaultAuthority: a.vaultAuthority,
            userAmmAta: a.userAmmAta,
            marketVault: a.marketVault,
            ammMint: smoke.ammMint,
            protocolConfig: a.protocolConfig,
            marketFeePool: a.feePoolAmm,
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

async function redeem(smoke: SmokeContext, program: any, user: Keypair) {
  const a = accts(smoke, user.publicKey);
  await sendTx(
    smoke.ctx,
    [user],
    new Transaction().add(
      await program.methods
        .redeemAmmPosition()
        .accounts({
          market: smoke.marketPda,
          ammState: a.ammState,
          vaultAuthority: a.vaultAuthority,
          position: a.position,
          vault: a.marketVault,
          userAmmAta: a.userAmmAta,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ),
  );
}

async function settleYes(smoke: SmokeContext) {
  const a = accts(smoke, smoke.creator.publicKey);
  const p = anchorProgram(smoke.ctx, smoke.creator);
  const send = async (ix: any) =>
    sendTx(smoke.ctx, [smoke.creator], new Transaction().add(ix));
  await send(
    await (p.methods as any).lockForResolution().accounts({
      market: smoke.marketPda, adjudicatorEntry: a.adjudicatorEntry,
      authority: smoke.creator.publicKey,
    }).instruction(),
  );
  await send(
    await (p.methods as any).attestOutcome(OUTCOME_YES).accounts({
      adjudicatorEntry: a.adjudicatorEntry, market: smoke.marketPda,
      authority: smoke.creator.publicKey,
    }).instruction(),
  );
  const entry = await (p.account as any).adjudicatorEntry.fetch(a.adjudicatorEntry);
  warpClockTo(smoke.ctx, BigInt(entry.attestedAt.toString()) + VETO);
  await send(
    await (p.methods as any).settle().accounts({
      market: smoke.marketPda, adjudicatorEntry: a.adjudicatorEntry,
      cranker: smoke.creator.publicKey,
    }).instruction(),
  );
}

async function sweep(smoke: SmokeContext, program: any, cranker: Keypair, treasuryOwner: PublicKey) {
  const a = accts(smoke, cranker.publicKey);
  const treasuryVault = getAssociatedTokenAddressSync(smoke.ammMint, treasuryOwner, true);
  await sendTx(
    smoke.ctx,
    [cranker],
    new Transaction()
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          cranker.publicKey, treasuryVault, treasuryOwner, smoke.ammMint,
        ),
      )
      .add(
        await program.methods
          .sweepResidual()
          .accounts({
            config: a.protocolConfig,
            market: smoke.marketPda,
            ammState: a.ammState,
            lpPosition: deriveLpPositionPda(
              smoke.marketId, smoke.creator.publicKey, smoke.programs,
            )[0],
            vaultAuthority: a.vaultAuthority,
            venueMint: smoke.ammMint,
            vaultAmm: a.marketVault,
            protocolTreasuryVault: treasuryVault,
            cranker: cranker.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ),
  );
  return treasuryVault;
}

async function reclaimSubsidy(smoke: SmokeContext, program: any) {
  const { marketId, programs, ammMint, creator } = smoke;
  await sendTx(
    smoke.ctx,
    [creator],
    new Transaction()
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          creator.publicKey,
          deriveUserUsdcAta(creator.publicKey, ammMint),
          creator.publicKey,
          ammMint,
        ),
      )
      .add(
        await program.methods
          .reclaimSubsidy()
          .accounts({
            market: smoke.marketPda,
            ammState: deriveAmmStatePda(marketId, programs)[0],
            lpPosition: deriveLpPositionPda(marketId, creator.publicKey, programs)[0],
            vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
            vaultAmm: deriveMarketVaultAta(marketId, ammMint, programs),
            creatorAmmAta: deriveUserUsdcAta(creator.publicKey, ammMint),
            creator: creator.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ),
  );
}

async function distributeAmm(smoke: SmokeContext, program: any) {
  const { marketId, programs, ammMint, creator } = smoke;
  const [lpYieldAuthority] = deriveLpYieldAuthority(programs);
  const cfg = await (program.account as any).protocolConfig.fetch(
    deriveProtocolConfigPda(programs)[0],
  );
  const market = await (program.account as any).market.fetch(smoke.marketPda);
  const mk = async (owner: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(ammMint, owner, true);
    await sendTx(
      smoke.ctx,
      [creator],
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          creator.publicKey, ata, owner, ammMint,
        ),
      ),
    );
    return ata;
  };
  await sendTx(
    smoke.ctx,
    [creator],
    new Transaction().add(
      await program.methods
        .distributeFeesAmm()
        .accounts({
          config: deriveProtocolConfigPda(programs)[0],
          market: smoke.marketPda,
          feePoolAuthority: deriveFeePoolAuthorityPda(programs)[0],
          venueMint: ammMint,
          feePool: feePoolAmmPda(marketId, programs)[0],
          bBaseYieldVault: deriveMarketVaultAta(marketId, ammMint, programs),
          lpYieldAuthority,
          lpYieldVault: await mk(lpYieldAuthority),
          adjudicatorFeeVault: await mk(market.adjudicator),
          protocolTreasuryVault: await mk(cfg.treasury),
          cranker: creator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ),
  );
}

async function close(smoke: SmokeContext, program: any, signer: Keypair) {
  const { marketId, programs, usdcMint, ammMint } = smoke;
  await sendTx(
    smoke.ctx,
    [signer],
    new Transaction().add(
      await program.methods
        .closeMarket(Array.from(marketId))
        .accounts({
          market: smoke.marketPda,
          ammState: deriveAmmStatePda(marketId, programs)[0],
          book: null, // bootSmoke markets never graduate — no book exists
          vaultBook: deriveMarketVaultAta(marketId, usdcMint, programs),
          vaultAmm: deriveMarketVaultAta(marketId, ammMint, programs),
          lockVault: deriveLockVaultAta(marketId, ammMint, programs),
          feePoolAmm: feePoolAmmPda(marketId, programs)[0],
          feePoolBook: feePoolBookPda(marketId, programs)[0],
          vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
          lockAuthority: deriveLockAuthorityPda(marketId, programs)[0],
          feePoolAuthority: deriveFeePoolAuthorityPda(programs)[0],
          creator: signer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ),
  );
}

/** Boot, trade, and fully settle a market ready for end-of-life tests. */
async function settledMarket() {
  const smoke = await bootSmoke({
    bWad: 1_000n * WAD,
    userUsdcBaseUnits: 100_000_000n,
  });
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
  // A winning YES leg AND a larger losing NO leg. The NO cost is the market's
  // profit — without it the vault holds less than the subsidy, every trade
  // having been a payout, and there is genuinely nothing to sweep.
  await buy(smoke, program, smoke.user, 10n * WAD);
  await buy(smoke, program, smoke.user, 30n * WAD, 0);
  await settleYes(smoke);
  return { smoke, program };
}

describe("redeem retires shares from the outstanding count", () => {
  it("q returns to its virtual seed floor when every winner claims", async () => {
    const { smoke, program } = await settledMarket();
    const before = await (program.account as any).ammState.fetch(
      accts(smoke, smoke.user.publicKey).ammState,
    );
    expect(BigInt(before.qYes.toString())).toBeGreaterThan(
      BigInt(before.seedQYes.toString()),
    );
    await redeem(smoke, program, smoke.user);
    const after = await (program.account as any).ammState.fetch(
      accts(smoke, smoke.user.publicKey).ammState,
    );
    expect(after.qYes.toString()).toBe(after.seedQYes.toString());
  }, 60_000);
});

describe("sweep_residual", () => {
  it("refuses while a winner has not redeemed", async () => {
    // The line between surplus and someone's payout. Sweeping here would
    // take the user's winnings and call it dust.
    const { smoke, program } = await settledMarket();
    const err = await sweep(
      smoke, program, smoke.user, smoke.creator.publicKey,
    ).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.OutstandingClaims);
  }, 60_000);

  it("leaves the creator's unreclaimed subsidy — a sweep cannot front-run reclaim", async () => {
    // The creator has NOT reclaimed yet. A permissionless cranker fires the
    // sweep first. The vault must keep exactly the creator's cap
    // (posted − reclaimed) — anything else confiscates their capital to the
    // treasury, the same shape as the fee-drain bug with a nicer name.
    const { smoke, program } = await settledMarket();
    await redeem(smoke, program, smoke.user);
    const a = accts(smoke, smoke.user.publicKey);
    const vaultBefore = await tokenBal(smoke, a.marketVault);

    const lpPos = await (program.account as any).lpPosition.fetch(
      deriveLpPositionPda(smoke.marketId, smoke.creator.publicKey, smoke.programs)[0],
    );
    const posted = BigInt(lpPos.seedDepositWad.toString()) / 10n ** 12n;
    const reserved = posted - BigInt(lpPos.reclaimedBase.toString());
    expect(reserved).toBeGreaterThan(0n);

    const treasuryVault = getAssociatedTokenAddressSync(
      smoke.ammMint, smoke.creator.publicKey, true,
    );
    const tBefore = await tokenBal(smoke, treasuryVault);
    await sweep(smoke, program, smoke.user, smoke.creator.publicKey);

    // The cap stays; only what lies above it moved.
    expect(await tokenBal(smoke, a.marketVault)).toBe(reserved);
    expect((await tokenBal(smoke, treasuryVault)) - tBefore).toBe(
      vaultBefore - reserved,
    );

    // And the creator can still take what is theirs, emptying the vault.
    await reclaimSubsidy(smoke, program);
    expect(await tokenBal(smoke, a.marketVault)).toBe(0n);
  }, 60_000);
});

describe("close_market", () => {
  it("refuses while the vault still holds funds", async () => {
    const { smoke, program } = await settledMarket();
    await redeem(smoke, program, smoke.user);
    // Vault still holds the residual; fee pool still holds fees.
    const err = await close(smoke, program, smoke.creator).catch((e) => e);
    expect([ERR.VaultNotEmpty, 6069]).toContain(codeOf(err));
  }, 60_000);

  it("refuses an unfinished market outright", async () => {
    const smoke = await bootSmoke({ bWad: 1_000n * WAD });
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
    const err = await close(smoke, program, smoke.creator).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.MarketNotClosable);
  }, 60_000);

  it("closes a fully drained market: rent home, tombstone left", async () => {
    const { smoke, program } = await settledMarket();
    await redeem(smoke, program, smoke.user);
    await reclaimSubsidy(smoke, program);
    await distributeAmm(smoke, program); // fee pool -> 0; b_base back to vault
    await sweep(smoke, program, smoke.user, smoke.creator.publicKey);

    const a = accts(smoke, smoke.user.publicKey);
    const creatorBefore = BigInt(
      (await smoke.ctx.banksClient.getAccount(smoke.creator.publicKey))!.lamports,
    );

    const asCreator = anchorProgram(smoke.ctx, smoke.creator);
    await close(smoke, asCreator, smoke.creator);

    // Tombstone: 8 bytes, the marker, still program-owned.
    const tomb = await smoke.ctx.banksClient.getAccount(smoke.marketPda);
    expect(tomb).not.toBeNull();
    expect(tomb!.data.length).toBe(8);
    expect(Buffer.from(tomb!.data).toString()).toBe("MKTCLOSD");

    // Everything else is gone.
    for (const gone of [
      a.ammState,
      a.marketVault,
      deriveMarketVaultAta(smoke.marketId, smoke.usdcMint, smoke.programs),
      deriveLockVaultAta(smoke.marketId, smoke.ammMint, smoke.programs),
      a.feePoolAmm,
      feePoolBookPda(smoke.marketId, smoke.programs)[0],
    ]) {
      const acc = await smoke.ctx.banksClient.getAccount(gone);
      expect(acc === null || acc.data.length === 0).toBe(true);
    }

    const creatorAfter = BigInt(
      (await smoke.ctx.banksClient.getAccount(smoke.creator.publicKey))!.lamports,
    );
    expect(creatorAfter).toBeGreaterThan(creatorBefore);
  }, 60_000);

  it("refuses a signer who is not the creator", async () => {
    const { smoke, program } = await settledMarket();
    await redeem(smoke, program, smoke.user);
    await reclaimSubsidy(smoke, program);
    await distributeAmm(smoke, program);
    await sweep(smoke, program, smoke.user, smoke.creator.publicKey);
    const err = await close(smoke, program, smoke.user).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.Unauthorized);
  }, 60_000);

  it("the market_id can NEVER be re-created — the resurrection test", async () => {
    // The reason the tombstone exists. If this test can be made to pass with
    // a fully deleted Market account, every Position from the dead market
    // comes back to life against whatever vault the recreated market raises.
    const { smoke, program } = await settledMarket();
    await redeem(smoke, program, smoke.user);
    await reclaimSubsidy(smoke, program);
    await distributeAmm(smoke, program);
    await sweep(smoke, program, smoke.user, smoke.creator.publicKey);
    const asCreator = anchorProgram(smoke.ctx, smoke.creator);
    await close(smoke, asCreator, smoke.creator);

    const { marketId, programs, usdcMint, ammMint, creator } = smoke;
    const [marketPda] = deriveMarketPda(marketId, programs);
    const now = Math.floor(Date.now() / 1000);
    const { createHash } = await import("node:crypto");
    const q = "resurrected?";
    const err = await sendTx(
      smoke.ctx,
      [creator],
      new Transaction().add(
        await (asCreator.methods as any)
          .createMarket({
            marketId: Array.from(marketId),
            question: q,
            questionHash: Array.from(createHash("sha256").update(q).digest()),
            startTime: new BN(now),
            deadline: new BN(now + 86_400),
            adjudicator: creator.publicKey,
            initialB: new BN((1_000n * WAD).toString()),
          })
          .accounts({
            config: deriveProtocolConfigPda(programs)[0],
            market: marketPda,
            ammState: deriveAmmStatePda(marketId, programs)[0],
            vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
            lockAuthority: deriveLockAuthorityPda(marketId, programs)[0],
            vaultBook: deriveMarketVaultAta(marketId, usdcMint, programs),
            vaultAmm: deriveMarketVaultAta(marketId, ammMint, programs),
            lockVault: deriveLockVaultAta(marketId, ammMint, programs),
            bookMint: usdcMint,
            ammMint,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .instruction(),
      ),
    ).catch((e) => e);
    // Any failure will do — the tombstone occupies the address, so `init`
    // cannot create over it. What must NOT happen is success.
    expect(err).toBeInstanceOf(Error);
  }, 60_000);
});
