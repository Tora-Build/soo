// Request-shape coverage for sooth_market's program-owned escrow variants.
//
// Cargo CPI tests own the token-account semantics. This SDK test locks the
// adapter surface that sooth_book needs: split USDC payer/destination authority
// for minting, and split burn authority/USDC payout destination for redeeming.

import { describe, expect, it } from "vitest";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import {
  deriveMarketVaultAta,
  deriveNoMintPda,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
} from "../src/pdas.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD } from "../src/math/lmsr.js";

import { BankrunConnection } from "./fixtures/bankrun-connection.js";
import { bootSmoke } from "./fixtures/setup.js";

describe("program-owned sooth_market variant request shapes", () => {
  it("builds split-authority mint and redeem instructions", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "program-owned-variants",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      usdcMint: smoke.usdcMint,
      connection: conn,
    });

    const marketRef = encodePubkeyRef(smoke.marketPda);
    const payerRef = encodePubkeyRef(smoke.user.publicKey);
    const [destinationAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("sooth-book-escrow")],
      smoke.programs.soothCore,
    );
    const [yesMint] = deriveYesMintPda(smoke.marketId, smoke.programs);
    const [noMint] = deriveNoMintPda(smoke.marketId, smoke.programs);
    const destinationYesAta = getAssociatedTokenAddressSync(
      yesMint,
      destinationAuthority,
      true,
    );
    const destinationNoAta = getAssociatedTokenAddressSync(
      noMint,
      destinationAuthority,
      true,
    );

    const mintReq = await adapter.buildMintCompleteSetToProgramOwned({
      market: marketRef,
      payer: payerRef,
      destinationAuthority: encodePubkeyRef(destinationAuthority),
      destinationYesAta: encodePubkeyRef(destinationYesAta),
      destinationNoAta: encodePubkeyRef(destinationNoAta),
      amount: 10_000_000n,
    });

    expect(mintReq.kind).toBe("trade");
    const mintMeta = mintReq.meta as {
      operation?: string;
      ixProgramId?: string;
      ixKeys?: Array<{
        pubkey: string;
        isSigner: boolean;
        isWritable: boolean;
      }>;
      userPk?: string;
      marketPda?: string;
      amountStr?: string;
    };
    expect(mintMeta.operation).toBe("mintCompleteSetToProgramOwned");
    expect(mintMeta.ixProgramId).toBe(smoke.programs.soothCore.toBase58());
    expect(mintMeta.userPk).toBe(smoke.user.publicKey.toBase58());
    expect(mintMeta.marketPda).toBe(smoke.marketPda.toBase58());
    expect(mintMeta.amountStr).toBe("10000000");

    const [vaultAuthority] = deriveVaultAuthorityPda(
      smoke.marketId,
      smoke.programs,
    );
    const marketVault = deriveMarketVaultAta(
      smoke.marketId,
      smoke.usdcMint,
      smoke.programs,
    );
    const mintKeys = mintMeta.ixKeys ?? [];
    const mintKeyStrs = mintKeys.map((k) => k.pubkey);
    expect(mintKeyStrs).toContain(smoke.marketPda.toBase58());
    expect(mintKeyStrs).toContain(vaultAuthority.toBase58());
    expect(mintKeyStrs).toContain(yesMint.toBase58());
    expect(mintKeyStrs).toContain(noMint.toBase58());
    expect(mintKeyStrs).toContain(smoke.usdcMint.toBase58());
    expect(mintKeyStrs).toContain(marketVault.toBase58());
    expect(mintKeyStrs).toContain(destinationAuthority.toBase58());
    expect(mintKeyStrs).toContain(destinationYesAta.toBase58());
    expect(mintKeyStrs).toContain(destinationNoAta.toBase58());
    expect(
      mintKeys.find((k) => k.pubkey === destinationAuthority.toBase58())
        ?.isSigner,
    ).toBe(false);
    expect(
      mintKeys.find((k) => k.pubkey === smoke.user.publicKey.toBase58())
        ?.isSigner,
    ).toBe(true);

    const usdcDestination = getAssociatedTokenAddressSync(
      smoke.usdcMint,
      smoke.creator.publicKey,
    );
    const redeemReq = await adapter.buildRedeemFromProgramOwned({
      market: marketRef,
      burnAuthority: encodePubkeyRef(destinationAuthority),
      sourceYesAta: encodePubkeyRef(destinationYesAta),
      sourceNoAta: encodePubkeyRef(destinationNoAta),
      usdcDestination: encodePubkeyRef(usdcDestination),
      amountYes: 5_000_000n,
      amountNo: 2_000_000n,
    });

    expect(redeemReq.kind).toBe("claim");
    const redeemMeta = redeemReq.meta as {
      operation?: string;
      ixProgramId?: string;
      ixKeys?: Array<{
        pubkey: string;
        isSigner: boolean;
        isWritable: boolean;
      }>;
      userPk?: string;
      marketPda?: string;
      amountYesStr?: string;
      amountNoStr?: string;
    };
    expect(redeemMeta.operation).toBe("redeemFromProgramOwned");
    expect(redeemMeta.ixProgramId).toBe(smoke.programs.soothCore.toBase58());
    expect(redeemMeta.userPk).toBe(destinationAuthority.toBase58());
    expect(redeemMeta.marketPda).toBe(smoke.marketPda.toBase58());
    expect(redeemMeta.amountYesStr).toBe("5000000");
    expect(redeemMeta.amountNoStr).toBe("2000000");

    const redeemKeys = redeemMeta.ixKeys ?? [];
    const redeemKeyStrs = redeemKeys.map((k) => k.pubkey);
    expect(redeemKeyStrs).toContain(smoke.marketPda.toBase58());
    expect(redeemKeyStrs).toContain(vaultAuthority.toBase58());
    expect(redeemKeyStrs).toContain(yesMint.toBase58());
    expect(redeemKeyStrs).toContain(noMint.toBase58());
    expect(redeemKeyStrs).toContain(marketVault.toBase58());
    expect(redeemKeyStrs).toContain(destinationYesAta.toBase58());
    expect(redeemKeyStrs).toContain(destinationNoAta.toBase58());
    expect(redeemKeyStrs).toContain(usdcDestination.toBase58());
    expect(
      redeemKeys.find((k) => k.pubkey === destinationAuthority.toBase58())
        ?.isSigner,
    ).toBe(true);
  }, 60_000);
});
