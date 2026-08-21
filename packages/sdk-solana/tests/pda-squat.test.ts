// A lamport must not be able to censor a question.
//
// Every PDA `sooth_core` creates by hand derives from `market_id`, and
// `market_id` is `sha256(question)[..16]` by SDK convention — so the address a
// given question WILL occupy is public before the market exists. The system
// program's `CreateAccount` refuses a target that already holds lamports, so
// one lamport sent to that address used to make `create_market` fail forever:
// permanent, unrecoverable censorship of a specific question, for 1e-9 SOL.
// The same trick worked on the AMM state, the AMM vault, the LP mint, the LP
// position and the book.
//
// `pda::create_pda_account` closes it by taking the path Anchor's `init`
// takes: adopt a funded-but-empty address (transfer the shortfall, allocate,
// assign) instead of demanding an empty one. What it must NOT do is let a live
// account be overwritten — `close_market` leaves an 8-byte tombstone at the
// Market address precisely so a spent `market_id` can never be reused, and
// that guarantee used to ride on `create_account`'s lamport check.
//
// So this file pins both halves: the squat no longer works, and re-init still
// does not.

import { describe, expect, it } from "vitest";
import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import { createHash } from "node:crypto";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";

import { soothCoreIdl } from "../src/anchor/index.js";
import {
  deriveAmmStatePda,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveLpMintPda,
  deriveLpMintAuthorityPda,
  deriveLpPositionPda,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveMarketVaultAmm,
  deriveProtocolConfigPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
} from "../src/pdas.js";
import { WAD } from "../src/math/lmsr.js";
import {
  bootSmoke,
  PROGRAMS,
  SOOTH_CORE_ID,
  squatLamports,
  type SmokeContext,
} from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";
import { bookInitIx, bookPda, sendBookTx } from "./fixtures/book.js";

const LN2_WAD = 693_147_180_559_945_309n;
const SMOKE_QUESTION = "Will the smoke fixture resolve YES?";

function programFor(smoke: SmokeContext): Program {
  const conn = new LiteSvmConnection(smoke.ctx);
  const signer = smoke.creator;
  const wallet: Wallet = {
    publicKey: signer.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> => {
      (tx as Transaction).partialSign(signer);
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> => {
      for (const tx of txs) (tx as Transaction).partialSign(signer);
      return txs;
    },
    payer: signer,
  };
  return new Program(
    soothCoreIdl as Idl,
    new AnchorProvider(conn, wallet, { commitment: "confirmed" }),
  );
}

/** The addresses `create_market` and `seed_lp` allocate by hand. */
function handRolledPdas(marketId: Uint8Array) {
  return {
    marketPda: deriveMarketPda(marketId, PROGRAMS)[0],
    ammStatePda: deriveAmmStatePda(marketId, PROGRAMS)[0],
    lpMint: deriveLpMintPda(marketId, PROGRAMS)[0],
    vaultAmm: deriveMarketVaultAmm(marketId, PROGRAMS),
  };
}

describe("a squatted PDA cannot censor a market", () => {
  it("creates market, AMM state, AMM vault, LP mint and LP position over a pre-funded address", async () => {
    // `squatPdas` drops 1 lamport on each address immediately before the
    // instruction that creates it. Before the fix this boot threw on
    // `create_market` with the system program's "account already in use".
    const smoke = await bootSmoke({ squatPdas: true });
    const { ctx, marketId, creator } = smoke;

    const pdas = handRolledPdas(marketId);
    const [lpPosition] = deriveLpPositionPda(
      marketId,
      creator.publicKey,
      PROGRAMS,
    );

    // Program-owned state accounts: the squat's lamport became part of the
    // rent, and the account carries this program's data.
    for (const [label, addr] of [
      ["market", pdas.marketPda],
      ["amm_state", pdas.ammStatePda],
      ["lp_position", lpPosition],
    ] as const) {
      const acc = await ctx.banksClient.getAccount(addr);
      expect(acc, `${label} was never created`).toBeTruthy();
      expect(acc!.owner.toBase58(), `${label} owner`).toBe(
        SOOTH_CORE_ID.toBase58(),
      );
      expect(acc!.data.length, `${label} is empty`).toBeGreaterThan(8);
    }

    // Token-program accounts created the same way: the AMM vault (its own
    // PDA, not an ATA) and the per-market LP mint.
    for (const [label, addr] of [
      ["vault_amm", pdas.vaultAmm],
      ["lp_mint", pdas.lpMint],
    ] as const) {
      const acc = await ctx.banksClient.getAccount(addr);
      expect(acc, `${label} was never created`).toBeTruthy();
      expect(acc!.owner.toBase58(), `${label} owner`).toBe(
        TOKEN_PROGRAM_ID.toBase58(),
      );
    }

    // And the Market deserializes as a Market — the adopted account carries
    // real state, not just the right owner.
    const program = programFor(smoke);
    const market = await (program.account as any).market.fetch(pdas.marketPda);
    expect(market.marketId).toEqual(Array.from(marketId));
  });

  it("initializes the book over a pre-funded address", async () => {
    // The book is created by the same helper, from a `market_id`-derived
    // address, and a market that cannot open its book can never graduate.
    const smoke = await bootSmoke();
    const book = bookPda(smoke.marketId);
    await squatLamports(smoke.ctx, book, 1n);

    await sendBookTx(
      smoke,
      smoke.creator,
      bookInitIx(smoke, smoke.creator.publicKey, 16),
    );

    const acc = await smoke.ctx.banksClient.getAccount(book);
    expect(acc).toBeTruthy();
    expect(acc!.owner.toBase58()).toBe(SOOTH_CORE_ID.toBase58());
    expect(acc!.data.length).toBeGreaterThan(8);
  });

  it("still refuses to re-create a market that already exists", async () => {
    // The other half. Adopting a funded address is only safe while a LIVE
    // account is still refused: re-running `create_market` on a live id would
    // reset the market's lifecycle under every position that references it.
    const smoke = await bootSmoke();
    const program = programFor(smoke);
    const { marketId, creator } = smoke;

    const [config] = deriveProtocolConfigPda(PROGRAMS);
    const [marketPda] = deriveMarketPda(marketId, PROGRAMS);
    const [vaultAuthority] = deriveVaultAuthorityPda(marketId, PROGRAMS);
    const [lockAuthority] = deriveLockAuthorityPda(marketId, PROGRAMS);
    const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);

    const ix = await (program.methods as any)
      .createMarket({
        marketId: Array.from(marketId),
        question: SMOKE_QUESTION,
        questionHash: Array.from(
          new Uint8Array(
            createHash("sha256").update(SMOKE_QUESTION, "utf8").digest(),
          ),
        ),
        startTime: new BN(1_000_000),
        deadline: new BN(1_000_000 + 7 * 24 * 60 * 60),
        adjudicator: creator.publicKey,
        initialB: new BN((1_000n * WAD).toString()),
      })
      .accounts({
        config,
        market: marketPda,
        vaultAuthority,
        lockAuthority,
        bookMint: smoke.usdcMint,
        ammMint: smoke.ammMint,
        vaultBook: deriveMarketVaultAta(marketId, smoke.usdcMint, PROGRAMS),
        vaultAmm: deriveMarketVaultAmm(marketId, PROGRAMS),
        lockVault: deriveLockVaultAta(marketId, smoke.ammMint, PROGRAMS),
        ammState: ammStatePda,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    await expect(
      sendBookTx(smoke, creator, ix),
    ).rejects.toThrow(/PdaAlreadyInitialized|already initialized/i);
  });

  it("still refuses to seed a market twice", async () => {
    // `seed_lp` mints the creator's entire LP claim. Running it again over a
    // live `lp_mint` would mint a second full claim against the same vaults.
    const smoke = await bootSmoke();
    const program = programFor(smoke);
    const { marketId, creator } = smoke;

    const [config] = deriveProtocolConfigPda(PROGRAMS);
    const [marketPda] = deriveMarketPda(marketId, PROGRAMS);
    const [ammStatePda] = deriveAmmStatePda(marketId, PROGRAMS);
    const [lpMint] = deriveLpMintPda(marketId, PROGRAMS);
    const [lpMintAuthority] = deriveLpMintAuthorityPda(marketId, PROGRAMS);
    const [lpPosition] = deriveLpPositionPda(
      marketId,
      creator.publicKey,
      PROGRAMS,
    );

    const bWad = 1_000n * WAD;
    const ix = await (program.methods as any)
      .seedLp({
        lpAmount: new BN((bWad / 1_000_000_000_000n).toString()),
        seedDepositWad: new BN(((bWad * LN2_WAD) / WAD).toString()),
      })
      .accounts({
        config,
        market: marketPda,
        ammState: ammStatePda,
        lpMint,
        lpMintAuthority,
        creatorLpAta: deriveUserLpAta(creator.publicKey, lpMint),
        lpPosition,
        marketVault: deriveMarketVaultAmm(marketId, PROGRAMS),
        creatorAmmAta: deriveUserUsdcAta(creator.publicKey, smoke.ammMint),
        ammMint: smoke.ammMint,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    await expect(
      sendBookTx(smoke, creator, ix),
    ).rejects.toThrow(/PdaAlreadyInitialized|already initialized/i);
  });

  it("still refuses to re-create a market whose id was tombstoned", async () => {
    // `close_market` shrinks the Market account to 8 bytes and stamps a
    // marker over the discriminator, so every `Account<Market>` load fails and
    // the id is poisoned. That poison used to be enforced by `create_account`
    // rejecting the tombstone's lamports; it is now an explicit ownership
    // check, and this proves the guarantee survived the change.
    const smoke = await bootSmoke();
    const [marketPda] = deriveMarketPda(smoke.marketId, PROGRAMS);

    // Simulate the tombstone directly rather than driving a full settlement:
    // what matters to `create_pda_account` is the state it leaves behind — an
    // account this program owns, carrying data.
    const live = await smoke.ctx.banksClient.getAccount(marketPda);
    expect(live).toBeTruthy();
    smoke.ctx.setAccount(marketPda, {
      executable: false,
      owner: SOOTH_CORE_ID,
      lamports: live!.lamports,
      data: new Uint8Array(Buffer.from("MKTCLOSD", "utf8")),
      rentEpoch: 0n,
    });

    const program = programFor(smoke);
    const [config] = deriveProtocolConfigPda(PROGRAMS);
    const [vaultAuthority] = deriveVaultAuthorityPda(smoke.marketId, PROGRAMS);
    const [lockAuthority] = deriveLockAuthorityPda(smoke.marketId, PROGRAMS);
    const [ammStatePda] = deriveAmmStatePda(smoke.marketId, PROGRAMS);

    const ix = await (program.methods as any)
      .createMarket({
        marketId: Array.from(smoke.marketId),
        question: SMOKE_QUESTION,
        questionHash: Array.from(
          new Uint8Array(
            createHash("sha256").update(SMOKE_QUESTION, "utf8").digest(),
          ),
        ),
        startTime: new BN(1_000_000),
        deadline: new BN(1_000_000 + 7 * 24 * 60 * 60),
        adjudicator: smoke.creator.publicKey,
        initialB: new BN((1_000n * WAD).toString()),
      })
      .accounts({
        config,
        market: marketPda,
        vaultAuthority,
        lockAuthority,
        bookMint: smoke.usdcMint,
        ammMint: smoke.ammMint,
        vaultBook: deriveMarketVaultAta(
          smoke.marketId,
          smoke.usdcMint,
          PROGRAMS,
        ),
        vaultAmm: deriveMarketVaultAmm(smoke.marketId, PROGRAMS),
        lockVault: deriveLockVaultAta(smoke.marketId, smoke.ammMint, PROGRAMS),
        ammState: ammStatePda,
        creator: smoke.creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    await expect(
      sendBookTx(smoke, smoke.creator, ix),
    ).rejects.toThrow(/PdaAlreadyInitialized|already initialized/i);
  });
});
