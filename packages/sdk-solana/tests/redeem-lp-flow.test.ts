import { describe, expect, it } from "vitest";
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { WAD } from "../src/math/lmsr.js";
import {
  deriveLpMintPda,
  deriveLpYieldAuthority,
  lpYieldAmmPda,
  lpYieldBookPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
} from "../src/pdas.js";
import { encodePubkeyRef } from "../src/refs.js";

import { LiteSvmConnection } from "./fixtures/svm.js";
import { bootSmoke } from "./fixtures/setup.js";
import { anchorProgram, customError, sendTx } from "./fixtures/orderbook.js";
import anchorPkg from "@coral-xyz/anchor";
import { deriveAmmStatePda, deriveMarketPda } from "../src/pdas.js";

/** Anchor's ConstraintSeeds. */
const ANCHOR_CONSTRAINT_SEEDS = 2006;

describe("LP redemption flow", () => {
  it("burns post-graduation LP and pays pro-rata USDC yield", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new LiteSvmConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "redeem-lp-flow",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      bookMint: smoke.usdcMint,
      ammMint: smoke.ammMint,
      connection: conn,
    });

    await forceGraduated(smoke);

    const [lpMint] = deriveLpMintPda(smoke.marketId, smoke.programs);
    const creatorLpAta = deriveUserLpAta(smoke.creator.publicKey, lpMint);
    const lpSupply = (await getAccount(conn, creatorLpAta)).amount;
    expect(lpSupply).toBeGreaterThan(0n);

    // LP is AMM-side equity, so its yield vault and the creator's payout ATA
    // hold the AMM's token — `redeem_lp` pins them to `AMM_TOKEN_MINT`.
    const [lpYieldAuthority] = deriveLpYieldAuthority(smoke.programs);
    // Per-market since the global-vault cross-market fix.
    const [lpYieldVault] = lpYieldAmmPda(smoke.marketId, smoke.programs);
    const [lpYieldBookVault] = lpYieldBookPda(smoke.marketId, smoke.programs);
    const creatorUsdcAta = deriveUserUsdcAta(
      smoke.creator.publicKey,
      smoke.ammMint,
    );

    const yieldVaultAmount = 2_000_000n;
    await writeTokenAccount(
      smoke,
      lpYieldVault,
      smoke.ammMint,
      lpYieldAuthority,
      yieldVaultAmount,
    );
    await writeTokenAccount(
      smoke,
      creatorUsdcAta,
      smoke.ammMint,
      smoke.creator.publicKey,
      0n,
    );
    // The book-side vault must exist too — one burn pays both venues.
    await writeTokenAccount(
      smoke,
      lpYieldBookVault,
      smoke.usdcMint,
      lpYieldAuthority,
      0n,
    );

    const burnAmount = lpSupply / 2n;
    const expectedPayout = (yieldVaultAmount * burnAmount) / lpSupply;
    const marketRef = encodePubkeyRef(smoke.marketPda);
    const creatorRef = encodePubkeyRef(smoke.creator.publicKey);

    const req = await adapter.buildRedeemLp(marketRef, {
      user: creatorRef,
      lpAmount: burnAmount,
    });
    expect(req.kind).toBe("claim");
    expect((req.meta as { operation?: string }).operation).toBe("redeemLp");

    const receipt = await adapter.submit(req, signer(smoke.creator));
    expect(receipt.txId.startsWith("sol:")).toBe(true);

    const lpAfter = (await getAccount(conn, creatorLpAta)).amount;
    expect(lpAfter).toBe(lpSupply - burnAmount);
    const yieldAfter = (await getAccount(conn, lpYieldVault)).amount;
    expect(yieldAfter).toBe(yieldVaultAmount - expectedPayout);
    const userUsdcAfter = (await getAccount(conn, creatorUsdcAta)).amount;
    expect(userUsdcAfter).toBe(expectedPayout);
  }, 90_000);

  it("B6: a foreign mint cannot drain the LP yield vault", async () => {
    // `redeem_lp` pays `lp_yield_vault.amount * lp_amount / lp_mint.supply`,
    // and `lp_mint` used to be a bare `#[account(mut)] Box<Account<Mint>>` —
    // no seeds, no market, no link to anything. `amm_state` was bound only on
    // `is_graduated`, which ANY graduated market in the protocol satisfies.
    //
    // So anyone could create their own SPL mint with a supply of 1, burn one
    // token, and take the ENTIRE global yield vault. A permissionless drain of
    // protocol funds, not a mis-accounting.
    //
    // Here the attacker substitutes the USDC mint — a perfectly valid Mint
    // account that would have sailed through the old constraints. It now fails
    // seed derivation before any burn or transfer happens.
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    await forceGraduated(smoke);

    const conn = new LiteSvmConnection(smoke.ctx);
    const program = anchorProgram(smoke.ctx, smoke.creator);
    const [lpYieldAuthority] = deriveLpYieldAuthority(smoke.programs);
    const [lpYieldVault] = lpYieldAmmPda(smoke.marketId, smoke.programs);
    const [lpYieldBookVault] = lpYieldBookPda(smoke.marketId, smoke.programs);
    await writeTokenAccount(
      smoke,
      lpYieldBookVault,
      smoke.usdcMint,
      lpYieldAuthority,
      0n,
    );
    // Fund the vault so the drain would be worth something if it worked.
    const yieldAmount = 2_000_000n;
    await writeTokenAccount(
      smoke,
      lpYieldVault,
      smoke.ammMint,
      lpYieldAuthority,
      yieldAmount,
    );
    const vaultBefore = (await getAccount(conn, lpYieldVault)).amount;
    expect(vaultBefore).toBe(yieldAmount);

    const [ammState] = deriveAmmStatePda(smoke.marketId, smoke.programs);
    const [marketPda] = deriveMarketPda(smoke.marketId, smoke.programs);
    const attackerUsdc = deriveUserUsdcAta(
      smoke.creator.publicKey,
      smoke.ammMint,
    );
    // Give the attacker a real USDC account, so the call fails on the binding
    // we are testing rather than on a missing account.
    await writeTokenAccount(
      smoke,
      attackerUsdc,
      smoke.ammMint,
      smoke.creator.publicKey,
      1_000_000n,
    );

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        new Transaction().add(
          await (program.methods as any)
            .redeemLp(new anchorPkg.BN(1))
            .accounts({
              market: marketPda,
              ammState,
              lpMint: smoke.ammMint, // <- the substitution
              userLpAta: attackerUsdc,
              lpYieldAmm: lpYieldVault,
              lpYieldBook: lpYieldBookVault,
              lpYieldAuthority,
              userAmmAta: attackerUsdc,
              userBookAta: deriveUserUsdcAta(
                smoke.creator.publicKey,
                smoke.usdcMint,
              ),
              user: smoke.creator.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ),
      ),
    ).rejects.toThrow(customError(ANCHOR_CONSTRAINT_SEEDS));

    // Nothing moved.
    expect((await getAccount(conn, lpYieldVault)).amount).toBe(vaultBefore);
  }, 60_000);

  it("the GLOBAL vault location is dead — cross-market yield theft regression", async () => {
    // The finding this whole change exists for. The yield vault used to be
    // the ATA of the singleton lp_yield_authority — ONE account for every
    // market in the protocol — and redeem paid `global_vault × lp / THIS
    // market's supply`. Passing that old global location must now fail seed
    // derivation: yield is claimable only from the vault seeded by this
    // market's own id.
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    await forceGraduated(smoke);
    const program = anchorProgram(smoke.ctx, smoke.creator);
    const [lpYieldAuthority] = deriveLpYieldAuthority(smoke.programs);
    const [lpMint] = deriveLpMintPda(smoke.marketId, smoke.programs);
    const creatorLpAta = deriveUserLpAta(smoke.creator.publicKey, lpMint);

    // Fund the OLD global location — another market's accumulated yield.
    const globalVault = getAssociatedTokenAddressSync(
      smoke.ammMint, lpYieldAuthority, true,
    );
    await writeTokenAccount(
      smoke, globalVault, smoke.ammMint, lpYieldAuthority, 5_000_000n,
    );
    const [lpYieldBookVault] = lpYieldBookPda(smoke.marketId, smoke.programs);
    await writeTokenAccount(
      smoke, lpYieldBookVault, smoke.usdcMint, lpYieldAuthority, 0n,
    );
    const attackerAta = deriveUserUsdcAta(smoke.creator.publicKey, smoke.ammMint);
    await writeTokenAccount(
      smoke, attackerAta, smoke.ammMint, smoke.creator.publicKey, 0n,
    );

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        new Transaction().add(
          await (program.methods as any)
            .redeemLp(new anchorPkg.BN(1))
            .accounts({
              market: smoke.marketPda,
              ammState: deriveAmmStatePda(smoke.marketId, smoke.programs)[0],
              lpMint,
              userLpAta: creatorLpAta,
              // ← the old global vault, holding everyone's yield
              lpYieldAmm: globalVault,
              lpYieldBook: lpYieldBookVault,
              lpYieldAuthority,
              userAmmAta: attackerAta,
              userBookAta: deriveUserUsdcAta(
                smoke.creator.publicKey, smoke.usdcMint,
              ),
              user: smoke.creator.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ),
      ),
    ).rejects.toThrow(customError(ANCHOR_CONSTRAINT_SEEDS));
  }, 60_000);
});

async function forceGraduated(
  smoke: Awaited<ReturnType<typeof bootSmoke>>,
): Promise<void> {
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

async function writeTokenAccount(
  smoke: Awaited<ReturnType<typeof bootSmoke>>,
  address: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
): Promise<void> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  const rent = await smoke.ctx.banksClient.getRent();
  smoke.ctx.setAccount(address, {
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports: rent.minimumBalance(BigInt(data.length)) as unknown as number,
    data,
    rentEpoch: 0 as unknown as number,
  });
}

function signer(kp: Awaited<ReturnType<typeof bootSmoke>>["creator"]) {
  return {
    publicKey: kp.publicKey.toBase58(),
    signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => {
      const tx = Transaction.from(raw);
      tx.partialSign(kp);
      return tx.serialize({
        verifySignatures: false,
        requireAllSignatures: false,
      });
    },
  };
}
