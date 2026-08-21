// LP yield must never become unclaimable, because unclaimable yield freezes
// the market.
//
// `redeem_lp` pays `vault * lp_amount / supply`, so it needs a live supply and
// a holder to burn. But LP tokens are ordinary SPL tokens: a holder can call
// the token program's `burn` directly and destroy their claim without ever
// going through `redeem_lp`. If the last holder does that, supply hits zero
// with the yield vaults still holding everything `distribute_fees` paid in
// earlier — and `close_market` requires every token account at zero, so the
// market can never be closed either. One holder's mistake strands the vault
// AND the rent, permanently.
//
// `distribute_fees_*` already handles fees arriving AFTER supply hits zero, by
// folding the LP slice into the protocol remainder. `sweep_lp_yield` is the
// same rule applied to what was already there. Together they mean the vaults
// always drain.

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
  createBurnInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";

const { BN } = anchorPkg;

import {
  deriveAmmStatePda,
  deriveFeePoolAuthorityPda,
  deriveLpMintAuthorityPda,
  deriveLpMintPda,
  deriveLpYieldAuthority,
  deriveMarketVaultAmm,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
  lpYieldAmmPda,
  lpYieldBookPda,
} from "../src/pdas.js";
import { WAD } from "../src/math/lmsr.js";
import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import {
  anchorProgram,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

/** Anchor's own `ConstraintTokenOwner`. Ours live in the 6000 range. */
const CONSTRAINT_TOKEN_OWNER = 2015;

async function tokenBalance(smoke: SmokeContext, addr: PublicKey): Promise<bigint> {
  const acc = await smoke.ctx.banksClient.getAccount(addr);
  if (!acc) return 0n;
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

async function mintSupply(smoke: SmokeContext, mint: PublicKey): Promise<bigint> {
  const acc = await smoke.ctx.banksClient.getAccount(mint);
  if (!acc) return 0n;
  // SPL Mint: mint_authority_option(4) mint_authority(32) supply(8 LE).
  return Buffer.from(acc.data).readBigUInt64LE(36);
}

function codeOf(err: unknown): number | undefined {
  const text = String((err as Error)?.message ?? err);
  const m = text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (m) return parseInt(m[1], 16);
  const n = text.match(/Custom\((\d+)\)/);
  return n ? Number(n[1]) : undefined;
}

/** `ata` for `owner`, created if absent. */
async function ata(smoke: SmokeContext, mint: PublicKey, owner: PublicKey) {
  const addr = getAssociatedTokenAddressSync(mint, owner, true);
  await sendTx(
    smoke.ctx,
    [smoke.creator],
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        smoke.creator.publicKey,
        addr,
        owner,
        mint,
      ),
    ),
  );
  return addr;
}

/** Flip `AmmState.is_graduated`, the way `redeem-lp-flow` does. */
async function forceGraduated(smoke: SmokeContext): Promise<void> {
  const acc = await smoke.ctx.banksClient.getAccount(smoke.ammStatePda);
  if (!acc) throw new Error("AmmState account missing");
  const data = Buffer.from(acc.data);
  data[144] = 1;
  smoke.ctx.setAccount(smoke.ammStatePda, {
    executable: acc.executable,
    owner: acc.owner,
    lamports: acc.lamports as unknown as number,
    data,
    rentEpoch: acc.rentEpoch as unknown as number,
  });
}

/**
 * A market whose AMM-side LP yield vault holds real, distributed fees.
 *
 * Everything here is a real instruction: a real trade produces the fees, a
 * real `distribute_fees_amm` routes the LP slice into the vault. Faking the
 * balance would make the sweep's own accounting untestable.
 */
async function boot() {
  // A treasury distinct from creator/adjudicator, so a payment to the
  // treasury cannot be confused with one to either of the others.
  const treasury = Keypair.generate().publicKey;
  const smoke = await bootSmoke({
    bWad: 1_000n * WAD,
    userUsdcBaseUnits: 100_000_000n,
    treasury,
  });
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);

  const { marketId, programs, ammMint } = smoke;
  const [lpMint] = deriveLpMintPda(marketId, programs);
  const userLpAta = deriveUserLpAta(smoke.user.publicKey, lpMint);
  const [feePool] = feePoolAmmPda(marketId, programs);

  await sendTx(
    smoke.ctx,
    [smoke.user],
    new Transaction()
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          smoke.user.publicKey,
          userLpAta,
          smoke.user.publicKey,
          lpMint,
        ),
      )
      .add(
        await (program.methods as any)
          .tradePositions(
            1,
            new BN((10n * WAD).toString()),
            new BN((100n * WAD).toString()),
          )
          .accounts({
            market: smoke.marketPda,
            ammState: deriveAmmStatePda(marketId, programs)[0],
            position: derivePositionPda(marketId, smoke.user.publicKey, programs)[0],
            vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
            userAmmAta: deriveUserUsdcAta(smoke.user.publicKey, ammMint),
            marketVault: deriveMarketVaultAmm(marketId, programs),
            ammMint,
            protocolConfig: deriveProtocolConfigPda(programs)[0],
            marketFeePool: feePool,
            lpMint,
            lpMintAuthority: deriveLpMintAuthorityPda(marketId, programs)[0],
            userLpAta,
            user: smoke.user.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .instruction(),
      ),
  );

  const market = await (program.account as any).market.fetch(smoke.marketPda);
  const [lpYieldAuthority] = deriveLpYieldAuthority(programs);
  const [lpYieldAmm] = lpYieldAmmPda(marketId, programs);
  const [lpYieldBook] = lpYieldBookPda(marketId, programs);
  const treasuryAmmVault = await ata(smoke, ammMint, treasury);
  const treasuryBookVault = await ata(smoke, smoke.usdcMint, treasury);

  await sendTx(
    smoke.ctx,
    [smoke.user],
    new Transaction().add(
      await (program.methods as any)
        .distributeFeesAmm()
        .accounts({
          config: deriveProtocolConfigPda(programs)[0],
          market: smoke.marketPda,
          feePoolAuthority: deriveFeePoolAuthorityPda(programs)[0],
          venueMint: ammMint,
          feePool,
          lpMint,
          bBaseYieldVault: deriveMarketVaultAmm(marketId, programs),
          lpYieldAuthority,
          lpYieldVault: lpYieldAmm,
          adjudicatorFeeVault: await ata(smoke, ammMint, market.adjudicator),
          protocolTreasuryVault: treasuryAmmVault,
          cranker: smoke.user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ),
  );

  const stranded = await tokenBalance(smoke, lpYieldAmm);
  expect(stranded, "the fee split must leave LP yield to strand").toBeGreaterThan(0n);

  const sweepAccounts = {
    config: deriveProtocolConfigPda(programs)[0],
    market: smoke.marketPda,
    ammState: deriveAmmStatePda(marketId, programs)[0],
    lpMint,
    lpYieldAuthority,
    ammMint,
    bookMint: smoke.usdcMint,
    lpYieldAmm,
    lpYieldBook,
    treasuryAmmVault,
    treasuryBookVault,
    cranker: smoke.user.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  return { smoke, program, lpMint, lpYieldAmm, stranded, sweepAccounts, treasury };
}

/** Destroy every LP token by calling the TOKEN PROGRAM directly. */
async function burnAllLpOutsideRedeem(
  smoke: SmokeContext,
  lpMint: PublicKey,
): Promise<void> {
  for (const holder of [smoke.creator, smoke.user]) {
    const acct = deriveUserLpAta(holder.publicKey, lpMint);
    const balance = await tokenBalance(smoke, acct);
    if (balance === 0n) continue;
    await sendTx(
      smoke.ctx,
      [holder],
      new Transaction().add(
        createBurnInstruction(acct, lpMint, holder.publicKey, balance),
      ),
    );
  }
  expect(await mintSupply(smoke, lpMint)).toBe(0n);
}

async function sweep(
  smoke: SmokeContext,
  program: any,
  accounts: Record<string, unknown>,
) {
  const ix = await (program.methods as any)
    .sweepLpYield()
    .accounts(accounts)
    .instruction();
  return sendTx(smoke.ctx, [smoke.user], new Transaction().add(ix));
}

describe("LP yield stranded by a raw burn is still recoverable", () => {
  it("sweeps the remainder to the treasury once no LP token is left", async () => {
    const { smoke, program, lpMint, lpYieldAmm, stranded, sweepAccounts } =
      await boot();
    await forceGraduated(smoke);
    await burnAllLpOutsideRedeem(smoke, lpMint);

    const before = await tokenBalance(
      smoke,
      sweepAccounts.treasuryAmmVault as PublicKey,
    );
    await sweep(smoke, program, sweepAccounts);

    // The whole balance moved, and the vault is now at the zero
    // `close_market` demands of every token account.
    expect(await tokenBalance(smoke, lpYieldAmm)).toBe(0n);
    expect(
      (await tokenBalance(smoke, sweepAccounts.treasuryAmmVault as PublicKey)) -
        before,
    ).toBe(stranded);
  }, 90_000);

  it("is the ONLY path: redeem_lp cannot touch a zero-supply vault", async () => {
    // The stranding this fixes. Without the sweep the balance below has no
    // exit at all, and `close_market` blocks on it forever.
    const { smoke, program, lpMint, lpYieldAmm, sweepAccounts } = await boot();
    await forceGraduated(smoke);
    await burnAllLpOutsideRedeem(smoke, lpMint);

    const err = await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await (program.methods as any)
          .redeemLp(new BN(1))
          .accounts({
            market: smoke.marketPda,
            ammState: smoke.ammStatePda,
            lpMint,
            userLpAta: deriveUserLpAta(smoke.creator.publicKey, lpMint),
            lpYieldAmm,
            lpYieldBook: sweepAccounts.lpYieldBook,
            lpYieldAuthority: sweepAccounts.lpYieldAuthority,
            userAmmAta: deriveUserUsdcAta(smoke.creator.publicKey, smoke.ammMint),
            userBookAta: deriveUserUsdcAta(smoke.creator.publicKey, smoke.usdcMint),
            user: smoke.creator.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ),
    ).catch((e) => e);

    expect(codeOf(err), "redeem_lp must refuse a dead supply").toBeDefined();
    expect(await tokenBalance(smoke, lpYieldAmm)).toBeGreaterThan(0n);
  }, 90_000);
});

describe("the sweep cannot be turned on live LP holders", () => {
  it("refuses while any LP token still exists", async () => {
    // The guard: with a supply, `redeem_lp` works and this vault is theirs.
    const { smoke, program, lpMint, sweepAccounts } = await boot();
    await forceGraduated(smoke);
    expect(await mintSupply(smoke, lpMint)).toBeGreaterThan(0n);

    const err = await sweep(smoke, program, sweepAccounts).catch((e) => e);
    expect(codeOf(err)).toBeDefined();
    // 6000-range: ours, not an Anchor constraint.
    expect(codeOf(err)!).toBeGreaterThanOrEqual(6000);
  }, 90_000);

  it("refuses while the market can still mint LP to new buyers", async () => {
    // Zero supply on an incubating market is a lull, not an end:
    // `trade_positions` mints LP to the buyer on every pre-graduation trade.
    // Sweeping here would take yield the next LP is about to have a claim on.
    const { smoke, program, lpMint, sweepAccounts } = await boot();
    await burnAllLpOutsideRedeem(smoke, lpMint); // NOT graduated

    const err = await sweep(smoke, program, sweepAccounts).catch((e) => e);
    expect(codeOf(err)!).toBeGreaterThanOrEqual(6000);
  }, 90_000);

  it("refuses a treasury vault the cranker owns", async () => {
    // Permissionless, so the destination must be the program's choice, not
    // the caller's: pinned by `config.treasury`, exactly as in
    // `distribute_fees`.
    const { smoke, program, lpMint, sweepAccounts } = await boot();
    await forceGraduated(smoke);
    await burnAllLpOutsideRedeem(smoke, lpMint);

    const thief = Keypair.generate();
    const err = await sweep(smoke, program, {
      ...sweepAccounts,
      treasuryAmmVault: await ata(smoke, smoke.ammMint, thief.publicKey),
    }).catch((e) => e);
    expect(codeOf(err)).toBe(CONSTRAINT_TOKEN_OWNER);
  }, 90_000);
});
