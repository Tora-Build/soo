// Sell fees count toward graduation, exactly as buy fees do.
//
// The graduation odometer (`AmmState.fee_b_base_wad`) measures fees the venue
// has EARNED against the subsidy the creator put at risk — `b·ln(2) ×
// graduation_bps`. Both trading directions pay `amm_fee_bps` into the same
// `fee_pool_amm`, so accruing only the buy side made the odometer disagree
// with the pool it is measuring and made a churn-heavy market harder to
// graduate than a buy-only one that earned the protocol the same money.
//
// This file pins the decision in both directions:
//
//   1. a buy sized just UNDER the threshold does not graduate — so the
//      assertion below cannot pass by the market having graduated already;
//   2. a subsequent sell, whose own fee carries the odometer over, graduates
//      the market inside `sell_positions` and flips `Market.book_enabled`
//      with it.
//
// Sizing (b = 1 WAD, amm_fee_bps = 500, graduation_bps defaults to 10 000):
//   threshold      = b·ln2                    ≈ 0.6931 WAD
//   buy 13 shares  → cost ≈ 12.307, fee ≈ 0.6153 WAD   (under)
//   sell 5 shares  → proceeds ≈ 5.000, fee ≈ 0.2500 WAD (0.8653 total, over)

import { describe, expect, it } from "vitest";
import { Transaction } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD } from "../src/math/lmsr.js";
import { deriveAmmStatePda, deriveMarketPda } from "../src/pdas.js";

import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";
import { anchorProgram, initMarketFeePool } from "./fixtures/orderbook.js";

const OUTCOME_YES = 1;

function adapterFor(smoke: SmokeContext): SolanaChainAdapter {
  return new SolanaChainAdapter({
    node: {
      id: "sell-graduation",
      chainKind: "solana",
      chainId: "test",
      rpcUrl: "http://localhost:8899",
    },
    programIds: smoke.programs,
    bookMint: smoke.usdcMint,
    ammMint: smoke.ammMint,
    connection: new LiteSvmConnection(smoke.ctx),
  } as never);
}

function signerFor(smoke: SmokeContext) {
  return {
    publicKey: smoke.user.publicKey.toBase58(),
    signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => {
      const tx = Transaction.from(raw);
      tx.partialSign(smoke.user);
      return tx.serialize({
        verifySignatures: false,
        requireAllSignatures: false,
      });
    },
  };
}

describe("sell fees advance the graduation odometer", () => {
  it("a sell can graduate the market, and flips book_enabled with it", async () => {
    const smoke = await bootSmoke({
      bWad: WAD,
      userUsdcBaseUnits: 500_000_000n,
    });
    const program = anchorProgram(smoke.ctx, smoke.user);
    await initMarketFeePool(smoke.ctx, program, smoke, smoke.creator);

    const adapter = adapterFor(smoke);
    const signer = signerFor(smoke);
    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);

    const [ammStatePda] = deriveAmmStatePda(smoke.marketId, smoke.programs);
    const [marketPda] = deriveMarketPda(smoke.marketId, smoke.programs);
    const readAmm = () =>
      (program.account as any).ammState.fetch(ammStatePda) as Promise<{
        isGraduated: boolean;
        feeBBaseWad: { toString(): string };
      }>;
    const readBookEnabled = async () =>
      ((await (program.account as any).market.fetch(marketPda)) as {
        bookEnabled: boolean;
      }).bookEnabled;

    // ─── 1. Buy just under the threshold ────────────────────────────────
    const buyShares = 13n * WAD;
    const buyQuote = await adapter.readQuote(marketRef, OUTCOME_YES, buyShares);
    await adapter.submit(
      await adapter.buildTrade(marketRef, {
        side: "buy",
        outcome: OUTCOME_YES,
        deltaShares: buyShares,
        maxCostWad: buyQuote.cost * 2n,
        // @ts-expect-error — Solana-only meta channel.
        user: userRef,
      }),
      signer,
    );

    const afterBuy = await readAmm();
    // The negative control. If this ever flips true the sizing above has
    // drifted and the rest of the test proves nothing.
    expect(afterBuy.isGraduated).toBe(false);
    expect(await readBookEnabled()).toBe(false);
    const odometerAfterBuy = BigInt(afterBuy.feeBBaseWad.toString());
    expect(odometerAfterBuy).toBeGreaterThan(0n);

    // ─── 2. Sell — its fee carries the odometer over ────────────────────
    await adapter.submit(
      await adapter.buildSell(marketRef, {
        outcome: OUTCOME_YES,
        deltaShares: 5n * WAD,
        minProceedsWad: 0n,
        user: userRef,
      }),
      signer,
    );

    const afterSell = await readAmm();
    const odometerAfterSell = BigInt(afterSell.feeBBaseWad.toString());
    // The odometer moved: the sell's fee was accrued, not dropped.
    expect(odometerAfterSell).toBeGreaterThan(odometerAfterBuy);
    // …and the crossing was acted on inside `sell_positions`, not deferred to
    // whatever buy happens next.
    expect(afterSell.isGraduated).toBe(true);
    // `Market.book_enabled` mirrors `AmmState.is_graduated` and is written in
    // the same block. A sell that graduates must open the book too.
    expect(await readBookEnabled()).toBe(true);
  }, 90_000);
});
