// B10: who earns LP on the trade that graduates a market.
//
// `trade_positions` snapshots `is_graduated` at instruction entry and the LP
// mint gates on that stale value, not the post-graduation one. That was flagged
// as a possible bug. It is not — but it is implicit, and any reordering silently
// changes who gets paid, so it is pinned here.
//
// Graduation fires when accumulated fees reach b*ln(2) — when fees have repaid
// the LMSR subsidy. The trade that crosses that threshold paid its fee while
// the market was still pre-graduation, so it earns LP like every trade before
// it. Gating on the fresh flag would mean the trader who completes the
// repayment pays a fee and receives nothing while the one immediately before
// them was paid: an arbitrary cliff, not a rule.

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
import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";
import { anchorProgram, initMarketFeePool, sendTx } from "./fixtures/orderbook.js";

const BN = anchorPkg.BN;
const OUTCOME_YES = 1;

function accts(smoke: SmokeContext, user: PublicKey) {
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
  };
}

async function buy(smoke: SmokeContext, program: any, user: Keypair, shares: bigint) {
  const a = accts(smoke, user.publicKey);
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
          .tradePositions(OUTCOME_YES, new BN(shares.toString()), new BN((10_000n * WAD).toString()))
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

describe("graduation and the LP mint (B10)", () => {
  it("the graduating trade still earns LP", async () => {
    // A tiny b makes the b*ln(2) threshold reachable in one trade.
    const smoke = await bootSmoke({ bWad: WAD, userUsdcBaseUnits: 500_000_000n });
    const program = anchorProgram(smoke.ctx, smoke.user);
    await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
    const conn = new LiteSvmConnection(smoke.ctx);
    const a = accts(smoke, smoke.user.publicKey);

    const before = await (program.account as any).ammState.fetch(a.ammState);
    expect(before.isGraduated).toBe(false);

    // One trade large enough that its fee crosses b * ln(2).
    await buy(smoke, program, smoke.user, 200n * WAD);

    const after = await (program.account as any).ammState.fetch(a.ammState);
    expect(after.isGraduated).toBe(true);

    // The trade that flipped the flag was still paid.
    const lp = await getAccount(conn, a.userLpAta);
    expect(lp.amount).toBeGreaterThan(0n);
  }, 60_000);

  it("a trade after graduation earns none", async () => {
    // The other half of the rule: once repaid, LP minting stops. Without this
    // the first test would pass even if the gate were removed entirely.
    const smoke = await bootSmoke({ bWad: WAD, userUsdcBaseUnits: 500_000_000n });
    const program = anchorProgram(smoke.ctx, smoke.user);
    await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);
    const conn = new LiteSvmConnection(smoke.ctx);
    const a = accts(smoke, smoke.user.publicKey);

    await buy(smoke, program, smoke.user, 200n * WAD);
    expect(
      (await (program.account as any).ammState.fetch(a.ammState)).isGraduated,
    ).toBe(true);
    const afterGraduation = (await getAccount(conn, a.userLpAta)).amount;

    await buy(smoke, program, smoke.user, 10n * WAD);
    expect((await getAccount(conn, a.userLpAta)).amount).toBe(afterGraduation);
  }, 60_000);
});
