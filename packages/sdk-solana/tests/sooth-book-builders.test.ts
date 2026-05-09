// Shape coverage for sooth_book order-lifecycle builders.
//
// These tests do not execute sooth_book instructions. They lock the SDK-side
// Anchor instruction shape: discriminators, account counts, W5 PDA binding,
// and the post-W5 fee-route accounts on the existing crank builders.

import { beforeAll, describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { soothBookIdl } from "../src/anchor/index.js";
import {
  deriveBookEscrowPda,
  deriveBookMarketLiquiditiesPda,
  deriveBookMarketMatchingPoolPda,
  deriveBookMarketPda,
  deriveBookMarketPositionPda,
  deriveBookOrderPda,
  deriveBookOrderRequestOrderPda,
  deriveBookOrderRequestQueuePda,
  deriveBookTradePda,
  deriveFeePoolAuthorityPda,
  deriveFeePoolVaultAta,
  deriveMarketVaultAta,
  deriveNoMintPda,
  deriveProtocolConfigPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
} from "../src/pdas.js";
import { encodePubkeyRef } from "../src/refs.js";

import { BankrunConnection } from "./fixtures/bankrun-connection.js";
import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";

type BuiltMeta = {
  ixData?: string;
  ixKeys?: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  ixProgramId?: string;
  [key: string]: unknown;
};

describe("sooth_book builder request shapes", () => {
  let smoke: SmokeContext;
  let adapter: SolanaChainAdapter;
  let bookPrograms: { soothBook: PublicKey };
  let bookMarketPda: PublicKey;

  beforeAll(async () => {
    smoke = await bootSmoke({
      userUsdcBaseUnits: 100_000_000n,
    });
    adapter = new SolanaChainAdapter({
      node: {
        id: "sooth-book-builders",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      usdcMint: smoke.usdcMint,
      connection: new BankrunConnection(smoke.ctx),
    });
    bookPrograms = { soothBook: adapter.programIds.soothBook! };
    [bookMarketPda] = deriveBookMarketPda(smoke.marketPda, bookPrograms);
  }, 60_000);

  it("buildMintIntoBook emits the W5 instruction shape and PDAs", async () => {
    const distinctSeedYes = 11n;
    const distinctSeedNo = 12n;
    const req = await adapter.buildMintIntoBook({
      user: encodePubkeyRef(smoke.user.publicKey),
      bookMarketPda: encodePubkeyRef(bookMarketPda),
      soothMarketPda: encodePubkeyRef(smoke.marketPda),
      priceYes: 500_000n,
      stake: 1_000_000n,
      distinctSeedYes,
      distinctSeedNo,
    });

    const meta = req.meta as BuiltMeta;
    expect(req.kind).toBe("trade");
    expect(meta.ixProgramId).toBe(bookPrograms.soothBook.toBase58());
    expect(discriminator(meta)).toEqual(idlDiscriminator("mint_into_book"));
    expect(req.accounts).toHaveLength(idlAccountCount("mint_into_book"));

    const [vaultAuthority] = deriveVaultAuthorityPda(
      smoke.marketId,
      smoke.programs,
    );
    const marketVault = deriveMarketVaultAta(
      smoke.marketId,
      smoke.usdcMint,
      smoke.programs,
    );
    const [bookEscrowAuthority] = deriveBookEscrowPda(
      bookMarketPda,
      bookPrograms,
    );
    const [yesMint] = deriveYesMintPda(smoke.marketId, smoke.programs);
    const [noMint] = deriveNoMintPda(smoke.marketId, smoke.programs);
    const expectedEscrowYes = getAssociatedTokenAddressSync(
      yesMint,
      bookEscrowAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const expectedEscrowNo = getAssociatedTokenAddressSync(
      noMint,
      bookEscrowAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const [orderYes] = deriveBookOrderPda(
      bookMarketPda,
      distinctSeedYes,
      bookPrograms,
    );
    const [orderNo] = deriveBookOrderPda(
      bookMarketPda,
      distinctSeedNo,
      bookPrograms,
    );
    const [marketLiquidities] = deriveBookMarketLiquiditiesPda(
      bookMarketPda,
      bookPrograms,
    );
    const [marketPosition] = deriveBookMarketPositionPda(
      bookMarketPda,
      smoke.user.publicKey,
      bookPrograms,
    );
    const [orderRequestQueue] = deriveBookOrderRequestQueuePda(
      bookMarketPda,
      bookPrograms,
    );

    const keys = keySet(req);
    expect(keys).toContain(
      deriveUserUsdcAta(smoke.user.publicKey, smoke.usdcMint).toBase58(),
    );
    expect(keys).toContain(vaultAuthority.toBase58());
    expect(keys).toContain(marketVault.toBase58());
    expect(keys).toContain(bookMarketPda.toBase58());
    expect(keys).toContain(expectedEscrowYes.toBase58());
    expect(keys).toContain(expectedEscrowNo.toBase58());
    expect(keys).toContain(bookEscrowAuthority.toBase58());
    expect(keys).toContain(orderYes.toBase58());
    expect(keys).toContain(orderNo.toBase58());
    expect(keys).toContain(marketLiquidities.toBase58());
    expect(keys).toContain(marketPosition.toBase58());
    expect(meta.orderRequestQueue).toBe(orderRequestQueue.toBase58());
  });

  it("buildSettleRestingOrders emits the W5 settle shape and payout accounts", async () => {
    const [orderPda] = deriveBookOrderPda(bookMarketPda, 77n, bookPrograms);
    const req = await adapter.buildSettleRestingOrders({
      caller: encodePubkeyRef(smoke.creator.publicKey),
      bookMarketPda: encodePubkeyRef(bookMarketPda),
      soothMarketPda: encodePubkeyRef(smoke.marketPda),
      orderPda: encodePubkeyRef(orderPda),
      orderPurchaser: encodePubkeyRef(smoke.user.publicKey),
    });

    const meta = req.meta as BuiltMeta;
    expect(req.kind).toBe("claim");
    expect(meta.ixProgramId).toBe(bookPrograms.soothBook.toBase58());
    expect(discriminator(meta)).toEqual(
      idlDiscriminator("settle_resting_orders"),
    );
    expect(req.accounts).toHaveLength(idlAccountCount("settle_resting_orders"));

    const [vaultAuthority] = deriveVaultAuthorityPda(
      smoke.marketId,
      smoke.programs,
    );
    const marketVault = deriveMarketVaultAta(
      smoke.marketId,
      smoke.usdcMint,
      smoke.programs,
    );
    const [bookEscrowAuthority] = deriveBookEscrowPda(
      bookMarketPda,
      bookPrograms,
    );
    const purchaserUsdcAta = deriveUserUsdcAta(
      smoke.user.publicKey,
      smoke.usdcMint,
    );

    const keys = keySet(req);
    expect(keys).toContain(smoke.marketPda.toBase58());
    expect(keys).toContain(bookMarketPda.toBase58());
    expect(keys).toContain(orderPda.toBase58());
    expect(keys).toContain(smoke.user.publicKey.toBase58());
    expect(keys).toContain(marketVault.toBase58());
    expect(keys).toContain(vaultAuthority.toBase58());
    expect(keys).toContain(bookEscrowAuthority.toBase58());
    expect(keys).toContain(purchaserUsdcAta.toBase58());
  });

  it("buildCreateBookMarket binds BookMarket PDA to sooth_market_pda", async () => {
    const marketTypeName = "SoothEvent";
    const build = (soothMarketPda: PublicKey) =>
      adapter.buildCreateBookMarket({
        creator: encodePubkeyRef(smoke.creator.publicKey),
        soothMarketPda: encodePubkeyRef(soothMarketPda),
        eventAccount: encodePubkeyRef(soothMarketPda),
        marketTypeName,
        title: "Sooth book market",
        marketLockTimestamp: 2_000_000_000n,
        eventStartTimestamp: 2_000_000_100n,
      });

    const first = await build(smoke.marketPda);
    const otherSoothMarketPda = Keypair.generate().publicKey;
    const second = await build(otherSoothMarketPda);
    const [expectedFirst] = deriveBookMarketPda(smoke.marketPda, bookPrograms);
    const [expectedSecond] = deriveBookMarketPda(
      otherSoothMarketPda,
      bookPrograms,
    );

    expect(discriminator(first.meta as BuiltMeta)).toEqual(
      idlDiscriminator("create_market"),
    );
    expect((first.meta as BuiltMeta).bookMarketPda).toBe(
      expectedFirst.toBase58(),
    );
    expect((second.meta as BuiltMeta).bookMarketPda).toBe(
      expectedSecond.toBase58(),
    );
    expect(expectedFirst.equals(expectedSecond)).toBe(false);
  });

  it("buildProcessOrderRequest includes W5 fee-route accounts", async () => {
    const purchaser = Keypair.generate().publicKey;
    const distinctSeed = seed16(31);
    const expectedPrice = 600_000n;
    const req = await adapter.buildProcessOrderRequest({
      crankOperator: encodePubkeyRef(smoke.creator.publicKey),
      bookMarketPda: encodePubkeyRef(bookMarketPda),
      purchaser: encodePubkeyRef(purchaser),
      distinctSeed,
      marketOutcomeIndex: 1,
      expectedPrice,
      forOutcome: true,
    });

    const meta = req.meta as BuiltMeta;
    expect(discriminator(meta)).toEqual(idlDiscriminator("process_order_request"));
    expect(req.accounts).toHaveLength(idlAccountCount("process_order_request"));

    const [order] = deriveBookOrderRequestOrderPda(
      bookMarketPda,
      purchaser,
      distinctSeed,
      bookPrograms,
    );
    const [matchingPool] = deriveBookMarketMatchingPoolPda(
      bookMarketPda,
      1,
      expectedPrice,
      true,
      bookPrograms,
    );
    const feeRoute = expectedFeeRouteAccounts(smoke);
    const keys = keySet(req);
    expect(keys).toContain(order.toBase58());
    expect(keys).toContain(matchingPool.toBase58());
    expect(keys).toContain(feeRoute.protocolConfig.toBase58());
    expect(keys).toContain(feeRoute.feePoolAuthority.toBase58());
    expect(keys).toContain(feeRoute.feePoolVault.toBase58());
  });

  it("buildMatchOrders includes W5 fee-route accounts", async () => {
    const forPurchaser = Keypair.generate().publicKey;
    const againstPurchaser = Keypair.generate().publicKey;
    const [orderFor] = deriveBookOrderPda(bookMarketPda, 101n, bookPrograms);
    const [orderAgainst] = deriveBookOrderPda(
      bookMarketPda,
      102n,
      bookPrograms,
    );
    const tradeForSeed = seed16(41);
    const tradeAgainstSeed = seed16(42);
    const req = await adapter.buildMatchOrders({
      crankOperator: encodePubkeyRef(smoke.creator.publicKey),
      bookMarketPda: encodePubkeyRef(bookMarketPda),
      orderForPda: encodePubkeyRef(orderFor),
      orderAgainstPda: encodePubkeyRef(orderAgainst),
      orderForPurchaser: encodePubkeyRef(forPurchaser),
      orderAgainstPurchaser: encodePubkeyRef(againstPurchaser),
      marketOutcomeIndex: 1,
      orderForExpectedPrice: 550_000n,
      orderAgainstExpectedPrice: 560_000n,
      tradeForSeed,
      tradeAgainstSeed,
    });

    const meta = req.meta as BuiltMeta;
    expect(discriminator(meta)).toEqual(idlDiscriminator("match_orders"));
    expect(req.accounts).toHaveLength(idlAccountCount("match_orders"));

    const [tradeFor] = deriveBookTradePda(orderFor, tradeForSeed, bookPrograms);
    const [tradeAgainst] = deriveBookTradePda(
      orderAgainst,
      tradeAgainstSeed,
      bookPrograms,
    );
    const feeRoute = expectedFeeRouteAccounts(smoke);
    const keys = keySet(req);
    expect(keys).toContain(tradeFor.toBase58());
    expect(keys).toContain(tradeAgainst.toBase58());
    expect(keys).toContain(feeRoute.protocolConfig.toBase58());
    expect(keys).toContain(feeRoute.feePoolAuthority.toBase58());
    expect(keys).toContain(feeRoute.feePoolVault.toBase58());
  });
});

function idlInstruction(name: string) {
  const ix = soothBookIdl.instructions.find(
    (candidate) => candidate.name === name,
  );
  if (!ix) throw new Error(`missing sooth_book IDL instruction ${name}`);
  return ix;
}

function idlDiscriminator(name: string): number[] {
  return [...idlInstruction(name).discriminator];
}

function idlAccountCount(name: string): number {
  return idlInstruction(name).accounts.length;
}

function discriminator(meta: BuiltMeta): number[] {
  if (!meta.ixData) throw new Error("missing ixData");
  return [...Buffer.from(meta.ixData, "base64").subarray(0, 8)];
}

function keySet(req: { accounts?: Array<{ pubkey: string }> }): string[] {
  return (req.accounts ?? []).map((account) => account.pubkey);
}

function seed16(start: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, index) => start + index);
}

function expectedFeeRouteAccounts(smoke: SmokeContext): {
  protocolConfig: PublicKey;
  feePoolAuthority: PublicKey;
  feePoolVault: PublicKey;
} {
  const launchpad = { soothLaunchpad: smoke.programs.soothLaunchpad! };
  const [protocolConfig] = deriveProtocolConfigPda(launchpad);
  const [feePoolAuthority] = deriveFeePoolAuthorityPda(launchpad);
  const feePoolVault = deriveFeePoolVaultAta(smoke.usdcMint, launchpad);
  return { protocolConfig, feePoolAuthority, feePoolVault };
}
