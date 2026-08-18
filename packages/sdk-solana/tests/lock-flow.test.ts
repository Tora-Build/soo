// Lock-on-sell: sell_positions escrows proceeds for 24h, claim_unlocked
// releases them.
//
// Replaces main's sooth_amm/tests/lock_flow.rs (7 tests). As with the
// adjudicator suite, this is a re-test rather than a transcription, because
// main's file tests almost nothing about locking:
//
//   - 3 tests are LMSR round-trip math (cost_delta buy/sell symmetry), which
//     develop already covers in tests/lmsr.test.ts and the Rust lmsr module.
//   - 1 is wad_to_usdc_floor rounding, likewise already covered.
//   - 2 assert LockEntry::SPACE and Position::SPACE against a hand-summed
//     layout. develop replaced those with `const _: () = assert!(SPACE ==
//     …_TOTAL_LEN)` compile-time asserts in state/{lock_entry,position}.rs,
//     which is strictly stronger — the build fails rather than a test.
//   - 1 asserts LOCK_DURATION_SECS == 86_400 against the exported constant.
//
// Which leaves the lock mechanism itself untested, and main's header says so
// outright: "The acceptance check on the on-chain `claim_unlocked` rejection
// of pre-`unlock_at` calls is the `LockNotElapsed` error variant declared in
// `error.rs` plus the `require!(now >= lock_entry.unlock_at, …)` line in
// `instructions/claim_unlocked.rs:128` — both reviewed inline."
//
// Reading the source is not a test. The 24h escrow is the protocol's main
// defence against sell-side manipulation, and nothing anywhere confirmed it
// holds funds, that it releases them, or that it releases them only once.
// That is what this file does, against the real instructions.
//
// LOCK_DURATION_SECS is a private const in sell_positions.rs (develop does not
// re-export it), so the duration is asserted where it actually matters: the
// unlock_at the program writes.

import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";

import {
  deriveAmmStatePda,
  deriveLockAuthorityPda,
  deriveLockEntryPda,
  deriveLockVaultAta,
  deriveLpMintAuthorityPda,
  deriveLpMintPda,
  deriveMarketVaultAta,
  deriveMarketVaultAmm,
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
  createFundedMaker,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

const BN = anchorPkg.BN;

const OUTCOME_YES = 1;
const LOCK_DURATION_SECS = 24n * 60n * 60n;
/** bootSmoke warps to startTime + 1 before returning. */
const NOW_AT_BOOT = 1_000_000 + 1;

const ERR = {
  Unauthorized: 6019,
  LockNotElapsed: 6022,
  OrderIdSeedMismatch: 6043,
} as const;

/** Anchor built-ins, not in the program's own enum. */
const ANCHOR_CONSTRAINT_SEEDS = 2006;
const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;

function accountsFor(smoke: SmokeContext, user: PublicKey) {
  const { marketId, programs, usdcMint, ammMint } = smoke;
  const [position] = derivePositionPda(marketId, user, programs);
  return {
    position,
    lpMint: deriveLpMintPda(marketId, programs)[0],
    lpMintAuthority: deriveLpMintAuthorityPda(marketId, programs)[0],
    userLpAta: deriveUserLpAta(user, deriveLpMintPda(marketId, programs)[0]),
    vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
    lockAuthority: deriveLockAuthorityPda(marketId, programs)[0],
    marketVault: deriveMarketVaultAmm(marketId, programs),
    lockVault: deriveLockVaultAta(marketId, ammMint, programs),
    userUsdcAta: deriveUserUsdcAta(user, ammMint),
    marketFeePool: feePoolAmmPda(marketId, programs)[0],
    protocolConfig: deriveProtocolConfigPda(programs)[0],
    ammState: deriveAmmStatePda(marketId, programs)[0],
  };
}

/** Buy YES on the AMM so there is something to sell. */
async function buyYes(
  smoke: SmokeContext,
  program: any,
  user: Keypair,
  shares: bigint,
): Promise<void> {
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
            new BN((100n * WAD).toString()), // generous max_cost
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

async function sellYes(
  smoke: SmokeContext,
  program: any,
  user: Keypair,
  shares: bigint,
  nonce: bigint,
): Promise<PublicKey> {
  const a = accountsFor(smoke, user.publicKey);
  const [lockEntry] = deriveLockEntryPda(a.position, nonce, smoke.programs);
  await sendTx(
    smoke.ctx,
    [user],
    new Transaction().add(
      await program.methods
        .sellPositions(
          OUTCOME_YES,
          new BN((-shares).toString()),
          new BN(0), // min_proceeds_wad — slippage floor off
          new BN(nonce.toString()),
        )
        .accounts({
          market: smoke.marketPda,
          ammState: a.ammState,
          position: a.position,
          vaultAuthority: a.vaultAuthority,
          lockAuthority: a.lockAuthority,
          marketVault: a.marketVault,
          lockVault: a.lockVault,
          lockEntry,
          ammMint: smoke.ammMint,
          protocolConfig: a.protocolConfig,
          marketFeePool: a.marketFeePool,
          user: user.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
    ),
  );
  return lockEntry;
}

async function claimTx(
  smoke: SmokeContext,
  program: any,
  user: PublicKey,
  lockEntry: PublicKey,
) {
  const a = accountsFor(smoke, user);
  return new Transaction().add(
    await program.methods
      .claimUnlocked()
      .accounts({
        market: smoke.marketPda,
        position: a.position,
        lockEntry,
        lockAuthority: a.lockAuthority,
        lockVault: a.lockVault,
        userAmmAta: a.userUsdcAta,
        ammMint: smoke.ammMint,
        user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  );
}

const SHARES = 10n * WAD;

async function boot() {
  const smoke = await bootSmoke();
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
  await buyYes(smoke, program, smoke.user, SHARES);
  return { smoke, program, user: smoke.user };
}

describe("sell_positions escrows proceeds", () => {
  it("moves proceeds into the lock vault, not the seller's wallet", async () => {
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);
    const conn = new LiteSvmConnection(smoke.ctx);

    const walletBefore = (await getAccount(conn, a.userUsdcAta)).amount;
    const lockVaultBefore = (await getAccount(conn, a.lockVault)).amount;
    expect(lockVaultBefore).toBe(0n);

    const lockEntry = await sellYes(smoke, program, user, SHARES, 0n);

    // The whole point of the mechanism: the seller is not paid yet.
    const walletAfter = (await getAccount(conn, a.userUsdcAta)).amount;
    expect(walletAfter).toBe(walletBefore);

    const entry = await (program.account as any).lockEntry.fetch(lockEntry);
    const escrowed = BigInt(entry.amountUsdc.toString());
    expect(escrowed).toBeGreaterThan(0n);
    // Every escrowed base unit is actually sitting in the vault — the
    // LockEntry is not an IOU against funds that were never moved.
    expect((await getAccount(conn, a.lockVault)).amount).toBe(escrowed);
  }, 60_000);

  it("sets unlock_at exactly 24h ahead", async () => {
    const { smoke, program, user } = await boot();
    const lockEntry = await sellYes(smoke, program, user, SHARES, 0n);
    const entry = await (program.account as any).lockEntry.fetch(lockEntry);

    expect(BigInt(entry.unlockAt.toString())).toBe(
      BigInt(NOW_AT_BOOT) + LOCK_DURATION_SECS,
    );
    expect(entry.user.toBase58()).toBe(user.publicKey.toBase58());
    expect(entry.market.toBase58()).toBe(smoke.marketPda.toBase58());
    expect(BigInt(entry.nonce.toString())).toBe(0n);
  }, 60_000);

  it("bumps the position's lock_nonce so a second sell gets its own entry", async () => {
    // The nonce is what stops a second sell from colliding with the first
    // LockEntry PDA (which would be an `init` failure, i.e. sells silently
    // becoming impossible until the first claim).
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);

    const first = await sellYes(smoke, program, user, SHARES / 2n, 0n);
    const pos = await (program.account as any).position.fetch(a.position);
    expect(BigInt(pos.lockNonce.toString())).toBe(1n);

    const second = await sellYes(smoke, program, user, SHARES / 4n, 1n);
    expect(second.toBase58()).not.toBe(first.toBase58());

    // Both escrows coexist; the vault holds the sum.
    const e1 = await (program.account as any).lockEntry.fetch(first);
    const e2 = await (program.account as any).lockEntry.fetch(second);
    const conn = new LiteSvmConnection(smoke.ctx);
    expect((await getAccount(conn, a.lockVault)).amount).toBe(
      BigInt(e1.amountUsdc.toString()) + BigInt(e2.amountUsdc.toString()),
    );
  }, 60_000);

  it("rejects a lock_nonce that does not match the position", async () => {
    const { smoke, program, user } = await boot();
    // Nonce 1 while position.lock_nonce is 0. Without this guard a caller
    // could pick any nonce and mint arbitrarily many LockEntry PDAs.
    await expect(sellYes(smoke, program, user, SHARES, 1n)).rejects.toThrow(
      customError(ERR.OrderIdSeedMismatch),
    );
  }, 60_000);
});

describe("claim_unlocked", () => {
  it("refuses before unlock_at — the guard main only reviewed by eye", async () => {
    const { smoke, program, user } = await boot();
    const lockEntry = await sellYes(smoke, program, user, SHARES, 0n);

    await expect(
      sendTx(
        smoke.ctx,
        [user],
        await claimTx(smoke, program, user.publicKey, lockEntry),
      ),
    ).rejects.toThrow(customError(ERR.LockNotElapsed));
  }, 60_000);

  it("still refuses one second early", async () => {
    // Boundary, not just "some earlier time" — an off-by-one in the
    // comparison would pass the test above.
    const { smoke, program, user } = await boot();
    const lockEntry = await sellYes(smoke, program, user, SHARES, 0n);
    const entry = await (program.account as any).lockEntry.fetch(lockEntry);
    const unlockAt = BigInt(entry.unlockAt.toString());

    warpClockTo(smoke.ctx, unlockAt - 1n);
    await expect(
      sendTx(
        smoke.ctx,
        [user],
        await claimTx(smoke, program, user.publicKey, lockEntry),
      ),
    ).rejects.toThrow(customError(ERR.LockNotElapsed));
  }, 60_000);

  it("pays out at exactly unlock_at and closes the entry", async () => {
    const { smoke, program, user } = await boot();
    const a = accountsFor(smoke, user.publicKey);
    const lockEntry = await sellYes(smoke, program, user, SHARES, 0n);
    const entry = await (program.account as any).lockEntry.fetch(lockEntry);
    const escrowed = BigInt(entry.amountUsdc.toString());

    const conn = new LiteSvmConnection(smoke.ctx);
    const walletBefore = (await getAccount(conn, a.userUsdcAta)).amount;

    // `require!(now >= unlock_at)` — the boundary itself must succeed.
    warpClockTo(smoke.ctx, BigInt(entry.unlockAt.toString()));
    await sendTx(
      smoke.ctx,
      [user],
      await claimTx(smoke, program, user.publicKey, lockEntry),
    );

    expect((await getAccount(conn, a.userUsdcAta)).amount).toBe(
      walletBefore + escrowed,
    );
    expect((await getAccount(conn, a.lockVault)).amount).toBe(0n);
    // close = user: the account is gone and its rent refunded.
    expect(await smoke.ctx.banksClient.getAccount(lockEntry)).toBeNull();
  }, 60_000);

  it("cannot be claimed twice", async () => {
    const { smoke, program, user } = await boot();
    const lockEntry = await sellYes(smoke, program, user, SHARES, 0n);
    const entry = await (program.account as any).lockEntry.fetch(lockEntry);
    warpClockTo(smoke.ctx, BigInt(entry.unlockAt.toString()));

    await sendTx(
      smoke.ctx,
      [user],
      await claimTx(smoke, program, user.publicKey, lockEntry),
    );
    // The second attempt hits a closed account, so it cannot double-spend the
    // lock vault.
    await expect(
      sendTx(
        smoke.ctx,
        [user],
        await claimTx(smoke, program, user.publicKey, lockEntry),
      ),
    ).rejects.toThrow(customError(ANCHOR_ACCOUNT_NOT_INITIALIZED));
  }, 60_000);

  it("cannot be claimed by someone else", async () => {
    const { smoke, program, user } = await boot();
    const lockEntry = await sellYes(smoke, program, user, SHARES, 0n);
    const entry = await (program.account as any).lockEntry.fetch(lockEntry);

    // Give the thief a genuine position of their own, otherwise the claim
    // fails on a missing `position` account (AccountNotInitialized) and never
    // reaches the ownership check — a green test that proves nothing.
    const thief = await createFundedMaker(smoke, 50_000_000n);
    const thiefProgram = anchorProgram(smoke.ctx, thief);
    await buyYes(smoke, thiefProgram, thief, SHARES);

    warpClockTo(smoke.ctx, BigInt(entry.unlockAt.toString()));

    // Now the thief has everything the instruction needs except the right to
    // this LockEntry. Its seeds bind it to the victim's position PDA, so
    // presenting it alongside the thief's position fails the seed derivation.
    await expect(
      sendTx(
        smoke.ctx,
        [thief],
        await claimTx(smoke, thiefProgram, thief.publicKey, lockEntry),
      ),
    ).rejects.toThrow(customError(ANCHOR_CONSTRAINT_SEEDS));

    // And the funds are still claimable by the rightful owner afterwards.
    await sendTx(
      smoke.ctx,
      [user],
      await claimTx(smoke, program, user.publicKey, lockEntry),
    );
    expect(await smoke.ctx.banksClient.getAccount(lockEntry)).toBeNull();
  }, 60_000);
});
