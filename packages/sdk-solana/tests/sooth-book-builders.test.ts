// Shape coverage for sooth_book order-lifecycle builders.
//
// These tests do not execute sooth_book instructions. They lock the SDK-side
// Anchor instruction shape: discriminators, account counts, W5 PDA binding,
// and the post-W5 fee-route accounts on the existing crank builders.

import { beforeAll, describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { soothBookIdl } from "../src/anchor/index.js";
import {
  bookSidePda,
  deriveFeePoolAuthorityPda,
  deriveFeePoolVaultAta,
  deriveMarketVaultAta,
  deriveNoMintPda,
  deriveProtocolConfigPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
  marketBookPda,
  marketFeePoolPda,
  orderbookPositionPda,
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

type BookPrograms = { soothBook: PublicKey };

function u64Bytes(value: bigint, name: string): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`${name} must fit in u64`);
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function u128Bytes(value: bigint, name: string): Buffer {
  if (value < 0n || value > 0xffffffffffffffffffffffffffffffffn) {
    throw new Error(`${name} must fit in u128`);
  }
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  out.writeBigUInt64LE(value >> 64n, 8);
  return out;
}

function seed16Bytes(seed: Uint8Array, name: string): Buffer {
  if (seed.length !== 16) {
    throw new Error(`${name} must be exactly 16 bytes`);
  }
  return Buffer.from(seed);
}

function deriveBookMarketPda(
  soothMarketPda: PublicKey,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), soothMarketPda.toBuffer()],
    programs.soothBook,
  );
}

function deriveBookEscrowPda(
  bookMarketPda: PublicKey,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), bookMarketPda.toBuffer()],
    programs.soothBook,
  );
}

function deriveBookMarketLiquiditiesPda(
  bookMarketPda: PublicKey,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liquidities"), bookMarketPda.toBuffer()],
    programs.soothBook,
  );
}

function deriveBookMarketMatchingQueuePda(
  bookMarketPda: PublicKey,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("matching"), bookMarketPda.toBuffer()],
    programs.soothBook,
  );
}

function deriveBookOrderRequestQueuePda(
  bookMarketPda: PublicKey,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order_request"), bookMarketPda.toBuffer()],
    programs.soothBook,
  );
}

function deriveBookMarketPositionPda(
  bookMarketPda: PublicKey,
  user: PublicKey,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), bookMarketPda.toBuffer(), user.toBuffer()],
    programs.soothBook,
  );
}

function deriveBookOrderPda(
  bookMarketPda: PublicKey,
  distinctSeed: bigint,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), bookMarketPda.toBuffer(), u64Bytes(distinctSeed, "distinctSeed")],
    programs.soothBook,
  );
}

function deriveBookOrderRequestOrderPda(
  bookMarketPda: PublicKey,
  purchaser: PublicKey,
  distinctSeed: Uint8Array,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [bookMarketPda.toBuffer(), purchaser.toBuffer(), seed16Bytes(distinctSeed, "distinctSeed")],
    programs.soothBook,
  );
}

function deriveBookMarketOutcomePda(
  bookMarketPda: PublicKey,
  outcomeIndex: number,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [bookMarketPda.toBuffer(), Buffer.from(String(outcomeIndex))],
    programs.soothBook,
  );
}

function deriveBookMarketMatchingPoolPda(
  bookMarketPda: PublicKey,
  outcomeIndex: number,
  expectedPrice: bigint,
  forOutcome: boolean,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      bookMarketPda.toBuffer(),
      Buffer.from(String(outcomeIndex)),
      Buffer.from("-"),
      u128Bytes(expectedPrice, "expectedPrice"),
      Buffer.from(forOutcome ? "true" : "false"),
    ],
    programs.soothBook,
  );
}

function deriveBookTradePda(
  orderPda: PublicKey,
  tradeSeed: Uint8Array,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [orderPda.toBuffer(), seed16Bytes(tradeSeed, "tradeSeed")],
    programs.soothBook,
  );
}

describe("sooth_book builder request shapes", () => {
  let smoke: SmokeContext;
  let adapter: SolanaChainAdapter;
  let bookPrograms: BookPrograms;
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
    expect(discriminator(meta)).toEqual(
      idlDiscriminator("process_order_request"),
    );
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

  // ── buildOrderbookBuy / Sell ───────────────────────────────────────────

  it("buildOrderbookBuy emits buy_yes with the W7 PDA surface", async () => {
    const purchaser = smoke.user.publicKey;
    const tick = 400;
    const amount = 100_000_000_000_000_000n;
    const req = await adapter.buildOrderbookBuy(
      encodePubkeyRef(smoke.marketPda),
      {
        side: 1,
        tick,
        amount,
        escrow: false,
        matchLimit: 0,
        user: encodePubkeyRef(purchaser),
      } as any,
    );

    const meta = req.meta as BuiltMeta;
    expect(req.kind).toBe("orderbook");
    expect(meta.ixProgramId).toBe(bookPrograms.soothBook.toBase58());
    expect(discriminator(meta)).toEqual(hexDiscriminator("7c4c7182b170bb68"));
    expect(req.accounts).toHaveLength(15);
    expect(meta.operation).toBe("buyYes");
    expect(meta.side).toBe(1);
    expect(meta.tick).toBe(tick);
    expect(meta.amountStr).toBe(String(amount));
    expect(meta.matchLimit).toBe(3);

    const [marketBook] = marketBookPda(smoke.marketId, smoke.programs);
    const [bookSide] = bookSidePda(smoke.marketId, 1, tick, smoke.programs);
    const [feePool] = marketFeePoolPda(smoke.marketId, smoke.programs);
    const [position] = orderbookPositionPda(
      smoke.marketId,
      purchaser,
      smoke.programs,
    );
    const keys = keySet(req);
    expect(keys).toContain(smoke.marketPda.toBase58());
    expect(keys).toContain(marketBook.toBase58());
    expect(keys).toContain(bookSide.toBase58());
    expect(keys).toContain(feePool.toBase58());
    expect(keys).toContain(position.toBase58());
    expect(keys).toContain(deriveUserUsdcAta(purchaser, smoke.usdcMint).toBase58());
  });

  it("buildOrderbookSell routes to buy_no with side=0", async () => {
    const purchaser = smoke.user.publicKey;
    const tick = 600;
    const req = await adapter.buildOrderbookSell(
      encodePubkeyRef(smoke.marketPda),
      {
        side: 0,
        tick,
        amount: 50_000_000_000_000_000n,
        escrow: false,
        matchLimit: 3,
        user: encodePubkeyRef(purchaser),
      } as any,
    );

    const meta = req.meta as BuiltMeta;
    expect(discriminator(meta)).toEqual(hexDiscriminator("59f0f410c4c9bea3"));
    expect(req.accounts).toHaveLength(15);
    expect(meta.operation).toBe("buyNo");

    const [bookSide] = bookSidePda(smoke.marketId, 0, tick, smoke.programs);
    expect(keySet(req)).toContain(bookSide.toBase58());
  });

  it("buildOrderbookBuy throws when args.user is missing", async () => {
    await expect(
      adapter.buildOrderbookBuy(encodePubkeyRef(smoke.marketPda), {
        side: 1,
        tick: 400,
        amount: 1_000_000n,
        escrow: false,
        matchLimit: 0,
      } as any),
    ).rejects.toThrow(/args\.user/);
  });

  it("buildOrderbookBuy throws when tick is outside the orderbook range", async () => {
    await expect(
      adapter.buildOrderbookBuy(encodePubkeyRef(smoke.marketPda), {
        side: 1,
        tick: 1000,
        amount: 1_000_000n,
        escrow: false,
        matchLimit: 0,
        user: encodePubkeyRef(smoke.user.publicKey),
      } as any),
    ).rejects.toThrow(/1\.\.999/);
  });

  // ── buildOrderbookCancel ───────────────────────────────────────────────

  it("buildOrderbookCancel emits cancel for a signer-owned linear scan", async () => {
    const purchaser = smoke.user.publicKey;
    const side = 1;
    const tick = 450;
    const req = await adapter.buildOrderbookCancel(
      encodePubkeyRef(smoke.marketPda),
      side,
      tick,
      { user: encodePubkeyRef(purchaser) },
    );
    const meta = req.meta as BuiltMeta;
    expect(req.kind).toBe("orderbook");
    expect(meta.ixProgramId).toBe(bookPrograms.soothBook.toBase58());
    expect(discriminator(meta)).toEqual(hexDiscriminator("e8dbdf29dbecdcbe"));
    expect(req.accounts).toHaveLength(13);
    expect(meta.operation).toBe("cancel");
    expect(meta.side).toBe(side);
    expect(meta.tick).toBe(tick);

    const [marketBook] = marketBookPda(smoke.marketId, smoke.programs);
    const [bookSide] = bookSidePda(smoke.marketId, side, tick, smoke.programs);
    const [position] = orderbookPositionPda(
      smoke.marketId,
      purchaser,
      smoke.programs,
    );
    const keys = keySet(req);
    expect(keys).toContain(smoke.marketPda.toBase58());
    expect(keys).toContain(marketBook.toBase58());
    expect(keys).toContain(bookSide.toBase58());
    expect(keys).toContain(position.toBase58());
    expect(keys).toContain(purchaser.toBase58());
  });

  it("buildOrderbookCancel emits cancel_by_id and checks composite side/tick", async () => {
    const side = 0;
    const tick = 610;
    const orderId = encodeOrderId(side, tick, 123n);
    const req = await adapter.buildOrderbookCancel(
      encodePubkeyRef(smoke.marketPda),
      side,
      tick,
      { user: encodePubkeyRef(smoke.user.publicKey), byId: orderId },
    );

    const meta = req.meta as BuiltMeta;
    expect(discriminator(meta)).toEqual(hexDiscriminator("bcf1f0325f86217f"));
    expect(req.accounts).toHaveLength(13);
    expect(meta.operation).toBe("cancelById");
    expect(meta.orderId).toBe(orderId.toString());

    await expect(
      adapter.buildOrderbookCancel(
        encodePubkeyRef(smoke.marketPda),
        1,
        tick,
        { user: encodePubkeyRef(smoke.user.publicKey), byId: orderId },
      ),
    ).rejects.toThrow(/does not match/);
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

function hexDiscriminator(hex: string): number[] {
  return [...Buffer.from(hex, "hex")];
}

function keySet(req: { accounts?: Array<{ pubkey: string }> }): string[] {
  return (req.accounts ?? []).map((account) => account.pubkey);
}

function encodeOrderId(side: 0 | 1, tick: number, seq: bigint): bigint {
  return (BigInt(side) << 56n) | (BigInt(tick) << 40n) | seq;
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
