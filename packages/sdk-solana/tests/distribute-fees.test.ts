// Draining a market's fee pool — and where the money is allowed to go.
//
// `cranker` is any signer. Distribution is permissionless on purpose, so fees
// are not hostage to one keeper, but that is only safe if every destination is
// fixed by the program. A destination carrying `token::mint` and nothing else
// would let any caller route the b_base, LP and adjudicator shares — 90% of
// the pool at the 50/30/10/10 split — into accounts they owned.
//
// So the substitution attempts matter more than the happy path: each one is a
// theft that must fail. The happy path is here to keep them honest — a
// rejection proves nothing if the transaction was going to fail anyway, and an
// empty pool fails with `NothingToDistribute` before any constraint is even
// interesting. Every test below therefore runs against a pool holding real
// fees from a real trade, and the control asserts that same account set, with
// only the destination corrected, actually moves the money.

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
  deriveMarketVaultAta,
  deriveMarketVaultAmm,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
  lpYieldAmmPda,
} from "../src/pdas.js";
import { WAD } from "../src/math/lmsr.js";
import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import {
  anchorProgram,
  initMarketFeePool,
  sendTx,
} from "./fixtures/orderbook.js";

/** `bootSmoke` config: 50% b_base, 30% LP, 10% adjudicator, 10% protocol. */
const SPLIT = { bBase: 5_000n, lp: 3_000n, adj: 1_000n } as const;

/**
 * 2000-range codes are Anchor's own constraint failures. `VaultAuthorityMismatch`
 * is ours: the b_base destination carries `address = ... @ VaultAuthorityMismatch`,
 * so its rejection surfaces under the program's code rather than Anchor's 2012.
 */
const ERR = {
  ConstraintTokenOwner: 2015,
  ConstraintTokenMint: 2014,
  VaultAuthorityMismatch: 6007,
} as const;

async function tokenBalance(smoke: SmokeContext, addr: PublicKey): Promise<bigint> {
  const acc = await smoke.ctx.banksClient.getAccount(addr);
  if (!acc) return 0n;
  // SPL TokenAccount: mint(32) owner(32) amount(8 LE).
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

/** Create `owner`'s ATA for `mint` if it does not exist, and return it. */
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

/**
 * A market whose AMM fee pool holds real fees, plus every destination the
 * distribution expects. Returns the correct account set — each test then swaps
 * exactly one entry, so a failure can only be the swap.
 */
async function boot() {
  // A treasury distinct from `creator`. By default `bootSmoke` makes them the
  // same key, which is also the market's adjudicator — so the adjudicator's
  // 10% and the protocol's 10% would land in ONE account and the control below
  // could not tell a correct split from a doubled payment to either.
  const treasury = Keypair.generate().publicKey;
  const smoke = await bootSmoke({
    bWad: 1_000n * WAD,
    userUsdcBaseUnits: 100_000_000n,
    treasury,
  });
  const program = anchorProgram(smoke.ctx, smoke.user);
  await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);

  const { marketId, programs, ammMint } = smoke;
  const lpMint = deriveLpMintPda(marketId, programs)[0];
  const userLpAta = deriveUserLpAta(smoke.user.publicKey, lpMint);
  const [feePool] = feePoolAmmPda(marketId, programs);

  // A real buy: `trade_positions` skims `amm_fee_bps` into the pool, so the
  // distribution below has something to split.
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

  const fees = await tokenBalance(smoke, feePool);
  expect(fees, "the trade must leave fees to distribute").toBeGreaterThan(0n);

  const [feePoolAuthority] = deriveFeePoolAuthorityPda(programs);
  const [lpYieldAuthority] = deriveLpYieldAuthority(programs);
  const cfg = await (program.account as any).protocolConfig.fetch(
    deriveProtocolConfigPda(programs)[0],
  );

  // Read both owners off-chain rather than assuming who they are — the point
  // is that the PROGRAM decides these, and the test should follow it.
  const market = await (program.account as any).market.fetch(smoke.marketPda);

  const accounts = {
    config: deriveProtocolConfigPda(programs)[0],
    market: smoke.marketPda,
    feePoolAuthority,
    venueMint: ammMint,
    feePool,
    lpMint,
    bBaseYieldVault: deriveMarketVaultAmm(marketId, programs),
    lpYieldAuthority,
    lpYieldVault: lpYieldAmmPda(marketId, programs)[0],
    adjudicatorFeeVault: await ata(smoke, ammMint, market.adjudicator),
    protocolTreasuryVault: await ata(smoke, ammMint, cfg.treasury),
    cranker: smoke.user.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  // Every destination must be a distinct account, or a doubled payment to one
  // of them would read as a correct split.
  const dests = [
    accounts.bBaseYieldVault,
    accounts.lpYieldVault,
    accounts.adjudicatorFeeVault,
    accounts.protocolTreasuryVault,
  ].map((k) => k.toBase58());
  expect(new Set(dests).size, "destinations alias each other").toBe(4);

  return { smoke, program, accounts, fees };
}

/**
 * Build + send `distribute_fees_amm` with the given account set. `cranker` is
 * `smoke.user` — deliberately not the creator, authority or adjudicator.
 */
async function crank(
  smoke: SmokeContext,
  program: any,
  accounts: Record<string, unknown>,
) {
  const ix = await (program.methods as any)
    .distributeFeesAmm()
    .accounts(accounts)
    .instruction();
  return sendTx(smoke.ctx, [smoke.user], new Transaction().add(ix));
}

/** The Anchor error code a rejected transaction carried, if any. */
function codeOf(err: unknown): number | undefined {
  const text = String((err as Error)?.message ?? err);
  const m = text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (m) return parseInt(m[1], 16);
  const n = text.match(/Custom\((\d+)\)/);
  return n ? Number(n[1]) : undefined;
}

describe("distribute_fees pays the right places", () => {
  it("splits the pool and drains it completely", async () => {
    // The control. If this failed, every rejection below would be vacuous.
    const { smoke, program, accounts, fees } = await boot();

    const before = {
      bBase: await tokenBalance(smoke, accounts.bBaseYieldVault),
      lp: await tokenBalance(smoke, accounts.lpYieldVault),
      adj: await tokenBalance(smoke, accounts.adjudicatorFeeVault),
      treasury: await tokenBalance(smoke, accounts.protocolTreasuryVault),
    };

    await crank(smoke, program, accounts);

    const moved = {
      bBase: (await tokenBalance(smoke, accounts.bBaseYieldVault)) - before.bBase,
      lp: (await tokenBalance(smoke, accounts.lpYieldVault)) - before.lp,
      adj: (await tokenBalance(smoke, accounts.adjudicatorFeeVault)) - before.adj,
      treasury:
        (await tokenBalance(smoke, accounts.protocolTreasuryVault)) -
        before.treasury,
    };

    expect(moved.bBase).toBe((fees * SPLIT.bBase) / 10_000n);
    expect(moved.lp).toBe((fees * SPLIT.lp) / 10_000n);
    expect(moved.adj).toBe((fees * SPLIT.adj) / 10_000n);
    // Remainder to the protocol: the parts sum to the whole, so no dust is
    // stranded in a pool nobody can claim.
    expect(moved.bBase + moved.lp + moved.adj + moved.treasury).toBe(fees);
    expect(await tokenBalance(smoke, accounts.feePool)).toBe(0n);
  }, 90_000);

  it("lets anyone crank — the destinations, not the caller, are what's fixed", async () => {
    // Permissionlessness is a feature being pinned, not an oversight: fees
    // must not be strandable by an absent keeper.
    const { smoke, program, accounts } = await boot();
    expect(accounts.cranker.equals(smoke.creator.publicKey)).toBe(false);
    await crank(smoke, program, accounts);
    expect(await tokenBalance(smoke, accounts.feePool)).toBe(0n);
  }, 90_000);
});

describe("distribute_fees destinations cannot be chosen by the caller", () => {
  it("refuses an LP yield vault the cranker owns", async () => {
    const { smoke, program, accounts } = await boot();
    const thief = Keypair.generate();
    const err = await crank(smoke, program, {
      ...accounts,
      lpYieldVault: await ata(smoke, smoke.ammMint, thief.publicKey),
    }).catch((e) => e);
    // The vault is seeds-bound per market, so the rejection is Anchor's
    // ConstraintSeeds.
    expect(codeOf(err)).toBe(2006);
  }, 90_000);

  it("refuses an adjudicator vault the cranker owns", async () => {
    const { smoke, program, accounts } = await boot();
    const thief = Keypair.generate();
    const err = await crank(smoke, program, {
      ...accounts,
      adjudicatorFeeVault: await ata(smoke, smoke.ammMint, thief.publicKey),
    }).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.ConstraintTokenOwner);
  }, 90_000);

  it("refuses a treasury vault the cranker owns", async () => {
    const { smoke, program, accounts } = await boot();
    const thief = Keypair.generate();
    const err = await crank(smoke, program, {
      ...accounts,
      protocolTreasuryVault: await ata(smoke, smoke.ammMint, thief.publicKey),
    }).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.ConstraintTokenOwner);
  }, 90_000);

  it("refuses a b_base destination that is not this market's vault", async () => {
    // Pinned by address, not just owner: the b_base share must stay with the
    // market it was earned in, not merely with some market.
    const { smoke, program, accounts } = await boot();
    const thief = Keypair.generate();
    const err = await crank(smoke, program, {
      ...accounts,
      bBaseYieldVault: await ata(smoke, smoke.ammMint, thief.publicKey),
    }).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.VaultAuthorityMismatch);
  }, 90_000);

  it("refuses the book's vault as the b_base destination", async () => {
    // Cross-venue, not merely cross-owner. This one is the silent failure the
    // whole split exists to prevent: book tokens credited to AMM collateral.
    const { smoke, program, accounts } = await boot();
    const err = await crank(smoke, program, {
      ...accounts,
      bBaseYieldVault: deriveMarketVaultAta(
        smoke.marketId,
        smoke.usdcMint,
        smoke.programs,
      ),
    }).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.VaultAuthorityMismatch);
  }, 90_000);
});
