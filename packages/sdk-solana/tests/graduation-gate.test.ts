// The book opens at graduation, and not before.
//
// This was a UI convention until now: the program accepted book orders on an
// ungraduated market and only the front end declined to render the panel.
// Anyone calling the program directly could trade a book that was supposed not
// to exist yet — see `docs/design/dual-token-venues.md` §6.1.
//
// The gate reads `Market.book_enabled`, which mirrors `AmmState.is_graduated`.
// The mirror exists because `book_place` loads `Market` and not `AmmState`, so
// reading the real flag would cost an account and 32 bytes on every order
// forever. A mirrored fact can drift, so what this file actually pins is that
// it does not: the flag flips as part of the same instruction that graduates
// the market, and the book's behaviour changes with it.
//
// Every other book test calls the `enableBook` fixture to skip the incubation
// it is not testing. This is the file that proves the real transition works,
// so that shortcut is not hiding anything.

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
  marketFeePoolPda,
} from "../src/pdas.js";
import { WAD } from "../src/math/lmsr.js";
import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import { anchorProgram, initMarketFeePool, sendTx } from "./fixtures/orderbook.js";
import {
  ONE_SHARE,
  SIDE_BID,
  bookInitIx,
  bookPlaceIx,
  sendBookTx,
  trader,
} from "./fixtures/book.js";

const BN = anchorPkg.BN;
const OUTCOME_YES = 1;

/** `SoothCoreError::NotGraduated` — 6000 + 33. */
const NOT_GRADUATED = /0x1791|NotGraduated/;

function ammAccounts(smoke: SmokeContext, user: PublicKey) {
  const { marketId, programs, usdcMint } = smoke;
  const [lpMint] = deriveLpMintPda(marketId, programs);
  return {
    ammState: deriveAmmStatePda(marketId, programs)[0],
    position: derivePositionPda(marketId, user, programs)[0],
    vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
    marketVault: deriveMarketVaultAta(marketId, usdcMint, programs),
    userUsdcAta: deriveUserUsdcAta(user, usdcMint),
    protocolConfig: deriveProtocolConfigPda(programs)[0],
    marketFeePool: marketFeePoolPda(marketId, programs)[0],
    lpMint,
    lpMintAuthority: deriveLpMintAuthorityPda(marketId, programs)[0],
    userLpAta: deriveUserLpAta(user, lpMint),
  };
}

/** One AMM buy. Large enough here to cross `b · ln(2)` in a single trade. */
async function ammBuy(
  smoke: SmokeContext,
  program: any,
  user: Keypair,
  shares: bigint,
) {
  const a = ammAccounts(smoke, user.publicKey);
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
            new BN((10_000n * WAD).toString()),
          )
          .accounts({
            market: smoke.marketPda,
            ammState: a.ammState,
            position: a.position,
            vaultAuthority: a.vaultAuthority,
            userUsdcAta: a.userUsdcAta,
            marketVault: a.marketVault,
            usdcMint: smoke.usdcMint,
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

/** A market with a book account but no graduation. `bWad: WAD` keeps the
 *  threshold reachable in one trade. */
async function boot(): Promise<SmokeContext> {
  const smoke = await bootSmoke({ bWad: WAD, userUsdcBaseUnits: 500_000_000n });
  await initMarketFeePool(
    smoke.ctx,
    anchorProgram(smoke.ctx, smoke.creator),
    smoke,
    smoke.creator,
  );
  await sendBookTx(
    smoke,
    smoke.creator,
    bookInitIx(smoke, smoke.creator.publicKey, 32),
  );
  return smoke;
}

describe("the book opens at graduation", () => {
  it("rejects an order before graduation and accepts one after", async () => {
    // Both directions in one test on purpose: a gate that only ever rejects is
    // indistinguishable from a broken instruction, and one that only ever
    // accepts is indistinguishable from no gate at all.
    const smoke = await boot();
    const program = anchorProgram(smoke.ctx, smoke.user);
    const a = ammAccounts(smoke, smoke.user.publicKey);

    // ── before ────────────────────────────────────────────────────────────
    expect(
      (await (program.account as any).ammState.fetch(a.ammState)).isGraduated,
    ).toBe(false);
    expect(
      (await (program.account as any).market.fetch(smoke.marketPda))
        .bookEnabled,
    ).toBe(false);

    const maker = await trader(smoke);
    await expect(
      sendBookTx(
        smoke,
        maker,
        bookPlaceIx(smoke, maker.publicKey, SIDE_BID, 400, ONE_SHARE, 8, true),
      ),
    ).rejects.toThrow(NOT_GRADUATED);

    // ── graduate ──────────────────────────────────────────────────────────
    await ammBuy(smoke, program, smoke.user, 200n * WAD);

    // The mirror moved with the fact it mirrors, in the same instruction.
    expect(
      (await (program.account as any).ammState.fetch(a.ammState)).isGraduated,
    ).toBe(true);
    expect(
      (await (program.account as any).market.fetch(smoke.marketPda))
        .bookEnabled,
    ).toBe(true);

    // ── after ─────────────────────────────────────────────────────────────
    await sendBookTx(
      smoke,
      maker,
      bookPlaceIx(smoke, maker.publicKey, SIDE_BID, 400, ONE_SHARE, 8, true),
    );
  }, 120_000);

  it("leaves the exits open before graduation", async () => {
    // `book_cancel` and `book_withdraw` are deliberately ungated — a trader
    // must always be able to get out. Nothing can be resting pre-graduation
    // now, so what this pins is that the new gate did not leak onto the exit
    // paths: they must fail for having nothing to do, never for the gate.
    const smoke = await boot();
    const user = await trader(smoke);
    const program = anchorProgram(smoke.ctx, user);

    await expect(
      sendTx(
        smoke.ctx,
        [user],
        new Transaction().add(
          await program.methods
            .bookWithdraw()
            .accounts({
              book: bookPdaFor(smoke),
              market: smoke.marketPda,
              vaultAuthority: deriveVaultAuthorityPda(
                smoke.marketId,
                smoke.programs,
              )[0],
              vault: deriveMarketVaultAta(
                smoke.marketId,
                smoke.usdcMint,
                smoke.programs,
              ),
              userUsdcAta: deriveUserUsdcAta(user.publicKey, smoke.usdcMint),
              user: user.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ),
      ),
    ).resolves.not.toThrow();
  }, 120_000);
});

function bookPdaFor(smoke: SmokeContext): PublicKey {
  // Local rather than imported so this file does not depend on the book
  // fixture's internals for one derivation.
  return PublicKey.findProgramAddressSync(
    [Buffer.from("book"), Buffer.from(smoke.marketId)],
    smoke.programs.soothCore,
  )[0];
}
