// buildClaim({kind: "redeem"}) request-shape test.
//
// Full on-chain redeem semantics are covered by the cargo CPI suite
// (`programs/sooth_market/tests/cpi_redeem.rs` — 4 tests across
// YES wins / NO wins / INVALID / before-settle rejection). This test
// closes the SDK-side gap: that the adapter produces a well-formed
// SoothRequest with `operation: "redeem"` and the correct ix programId,
// account list, and meta — independently of whether the market is
// actually settled at test time. Locks the SDK shape so a future change
// to the on-chain ix surface fails here instead of silently shipping a
// broken request.
//
// Why we don't drive the full mint→settle→redeem round-trip here: settle
// requires CPI from sooth_adjudicator (request_lock → attest_outcome),
// and the bootSmoke fixture wires the AMM/market/launchpad set but not
// adjudicator. The settle path itself is covered by
// `programs/sooth_market/tests/cpi_settle.rs`.

import { describe, expect, it } from "vitest";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD } from "../src/math/lmsr.js";
import {
  deriveYesMintPda,
  deriveNoMintPda,
  deriveVaultAuthorityPda,
  deriveMarketVaultAta,
} from "../src/pdas.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { bootSmoke } from "./fixtures/setup.js";
import { BankrunConnection } from "./fixtures/bankrun-connection.js";

describe("buildClaim({kind: 'redeem'}) request shape", () => {
  it("produces redeem ix with the right accounts + operation marker", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const conn = new BankrunConnection(smoke.ctx);
    const adapter = new SolanaChainAdapter({
      node: {
        id: "redeem-shape",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      usdcMint: smoke.usdcMint,
      connection: conn,
    });

    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);

    const req = await adapter.buildClaim(marketRef, {
      outcome: 0,
      user: userRef,
      kind: "redeem",
    });

    expect(req.kind).toBe("claim");
    const meta = req.meta as {
      operation?: string;
      ixProgramId?: string;
      ixData?: string;
      ixKeys?: Array<{
        pubkey: string;
        isSigner: boolean;
        isWritable: boolean;
      }>;
      winningOutcome?: number;
      userPk?: string;
      marketPda?: string;
    };
    expect(meta.operation).toBe("redeem");
    expect(meta.ixProgramId).toBe(smoke.programs.soothMarket.toBase58());
    expect(meta.userPk).toBe(smoke.user.publicKey.toBase58());
    expect(meta.marketPda).toBe(smoke.marketPda.toBase58());
    expect(typeof meta.ixData).toBe("string");
    expect((meta.ixData ?? "").length).toBeGreaterThan(0);

    // Verify the account list contains the right PDAs.
    const [vaultAuthorityPda] = deriveVaultAuthorityPda(
      smoke.marketId,
      smoke.programs,
    );
    const [yesMintPda] = deriveYesMintPda(smoke.marketId, smoke.programs);
    const [noMintPda] = deriveNoMintPda(smoke.marketId, smoke.programs);
    const marketVault = deriveMarketVaultAta(
      smoke.marketId,
      smoke.usdcMint,
      smoke.programs,
    );
    const userYesAta = getAssociatedTokenAddressSync(
      yesMintPda,
      smoke.user.publicKey,
    );
    const userNoAta = getAssociatedTokenAddressSync(
      noMintPda,
      smoke.user.publicKey,
    );

    const keyStrs = (meta.ixKeys ?? []).map((k) => k.pubkey);
    expect(keyStrs).toContain(smoke.marketPda.toBase58());
    expect(keyStrs).toContain(vaultAuthorityPda.toBase58());
    expect(keyStrs).toContain(yesMintPda.toBase58());
    expect(keyStrs).toContain(noMintPda.toBase58());
    expect(keyStrs).toContain(marketVault.toBase58());
    expect(keyStrs).toContain(userYesAta.toBase58());
    expect(keyStrs).toContain(userNoAta.toBase58());
    expect(keyStrs).toContain(smoke.user.publicKey.toBase58());
  });
});
