// Shape coverage for sooth_book order-lifecycle builders.
//
// These tests do not execute sooth_book instructions. They lock the SDK-side
// Anchor instruction shape: discriminators, account counts, W5 PDA binding,
// and the post-W5 fee-route accounts on the existing crank builders.

import { beforeAll, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import {
  bookSidePda,
  deriveUserUsdcAta,
  marketBookPda,
  marketFeePoolPda,
  orderbookPositionPda,
} from "../src/pdas.js";
import { encodePubkeyRef } from "../src/refs.js";

// 13 program accounts + Anchor's #[event_cpi] tail (event_authority +
// program). Was 13 + a single sooth_log_program until `buy` switched from
// invoking a second program to self-invoking. Named so the durable-event work
// that added the 14th does not read as an unexplained off-by-one later.
const BUY_ACCOUNT_COUNT = 15;
import { DEFAULT_MATCH_LIMIT_PER_TX } from "../src/orderbook/matching-driver.js";

import { LiteSvmConnection } from "./fixtures/svm.js";
import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";

type BuiltMeta = {
  ixData?: string;
  ixKeys?: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  ixProgramId?: string;
  [key: string]: unknown;
};

type BookPrograms = { soothBook: PublicKey };

function deriveBookMarketPda(
  soothMarketPda: PublicKey,
  programs: BookPrograms,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), soothMarketPda.toBuffer()],
    programs.soothBook,
  );
}

describe("sooth_book builder request shapes", () => {
  let smoke: SmokeContext;
  let adapter: SolanaChainAdapter;
  let bookPrograms: BookPrograms;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      connection: new LiteSvmConnection(smoke.ctx),
    });
    bookPrograms = { soothBook: adapter.programIds.soothCore };
    [bookMarketPda] = deriveBookMarketPda(smoke.marketPda, bookPrograms);
  }, 60_000);

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
    expect(discriminator(meta)).toEqual(hexDiscriminator("66063d1201daebea"));
    expect(req.accounts).toHaveLength(BUY_ACCOUNT_COUNT);
    expect(meta.operation).toBe("buyYes");
    expect(meta.side).toBe(1);
    expect(meta.tick).toBe(tick);
    expect(meta.amountStr).toBe(String(amount));
    // Reference the constant, not a literal — this drifted when the 256 KB
    // allocator raised the per-tx fill ceiling.
    expect(meta.matchLimit).toBe(DEFAULT_MATCH_LIMIT_PER_TX);

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
    expect(discriminator(meta)).toEqual(hexDiscriminator("66063d1201daebea"));
    expect(req.accounts).toHaveLength(BUY_ACCOUNT_COUNT);
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
    expect(req.accounts).toHaveLength(11);
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
    expect(req.accounts).toHaveLength(11);
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
