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
  deriveUserLpAta,
  deriveUserUsdcAta,
} from "../src/pdas.js";
import { encodePubkeyRef } from "../src/refs.js";

import { BankrunConnection } from "./fixtures/bankrun-connection.js";
import { bootSmoke } from "./fixtures/setup.js";

describe("LP redemption flow", () => {
  it("burns post-graduation LP and pays pro-rata USDC yield", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "redeem-lp-flow",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      usdcMint: smoke.usdcMint,
      connection: conn,
    });

    await forceGraduated(smoke);

    const [lpMint] = deriveLpMintPda(smoke.marketId, {
      soothLaunchpad: smoke.programs.soothLaunchpad!,
    });
    const creatorLpAta = deriveUserLpAta(smoke.creator.publicKey, lpMint);
    const lpSupply = (await getAccount(conn, creatorLpAta)).amount;
    expect(lpSupply).toBeGreaterThan(0n);

    const [lpYieldAuthority] = deriveLpYieldAuthority({
      soothLaunchpad: smoke.programs.soothLaunchpad!,
    });
    const lpYieldVault = getAssociatedTokenAddressSync(
      smoke.usdcMint,
      lpYieldAuthority,
      true,
    );
    const creatorUsdcAta = deriveUserUsdcAta(
      smoke.creator.publicKey,
      smoke.usdcMint,
    );

    const yieldVaultAmount = 2_000_000n;
    await writeTokenAccount(
      smoke,
      lpYieldVault,
      smoke.usdcMint,
      lpYieldAuthority,
      yieldVaultAmount,
    );
    await writeTokenAccount(
      smoke,
      creatorUsdcAta,
      smoke.usdcMint,
      smoke.creator.publicKey,
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
