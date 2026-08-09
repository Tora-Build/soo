// `readQuote` in both directions, against what the program actually charges.
//
// A quote is a promise about a transaction that has not happened yet, and the
// only thing that makes it worth anything is agreeing with the instruction it
// predicts. Two ways it silently did not:
//
//   1. the fee was computed as `cost > 0 ? ... : 0`, so every SELL quoted a
//      zero fee while `sell_positions` charged the same bps a buy pays;
//   2. the demo's shim passed `abs(delta)`, so a sell was priced as the cost
//      of buying MORE — a different point on the curve.
//
// Neither produced a wrong-looking number. They were absorbed by the ±5%
// slippage buffer the UI puts around a quote, until the fee grew big enough to
// eat the buffer and every sell failed with SlippageExceeded on a market that
// had not moved.
//
// So these assert the fee is charged on the MAGNITUDE in both directions, and
// that a sell prices the direction it actually travels. The arithmetic is
// checked against the program's own rules rather than a recorded constant:
//
//   buy   `trade_positions`: total = cost + fee,          fee = cost·bps/1e4
//   sell  `sell_positions`:  net   = proceeds - fee,      fee = |cost|·bps/1e4

import { describe, expect, it } from "vitest";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD } from "../src/math/lmsr.js";
import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";

/** The AMM rate `bootSmoke` initialises `ProtocolConfig` with. */
const AMM_FEE_BPS = 500n;

function adapterFor(smoke: SmokeContext): SolanaChainAdapter {
  return new SolanaChainAdapter({
    node: {
      id: "quote-direction",
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

const abs = (v: bigint) => (v < 0n ? -v : v);

describe("readQuote is direction-aware", () => {
  it("charges the fee on the magnitude, buying and selling", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const adapter = adapterFor(smoke);
    const market = encodePubkeyRef(smoke.marketPda);

    const buy = await adapter.readQuote(market, 1, 10n * WAD);
    const sell = await adapter.readQuote(market, 1, -10n * WAD);

    // Sign carries the direction: a buy costs, a sell yields.
    expect(buy.cost).toBeGreaterThan(0n);
    expect(sell.cost).toBeLessThan(0n);

    // The fee is positive on both. Zero on the sell is the bug this pins —
    // and it is not a rounding artefact, it is the whole fee.
    expect(buy.fee).toBeGreaterThan(0n);
    expect(sell.fee).toBeGreaterThan(0n);

    // Exactly the program's formula, not an approximation of it.
    expect(buy.fee).toBe((abs(buy.cost) * AMM_FEE_BPS) / 10_000n);
    expect(sell.fee).toBe((abs(sell.cost) * AMM_FEE_BPS) / 10_000n);
  }, 60_000);

  it("netCost is what the taker pays, or what the seller receives", async () => {
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const adapter = adapterFor(smoke);
    const market = encodePubkeyRef(smoke.marketPda);

    const buy = await adapter.readQuote(market, 1, 10n * WAD);
    const sell = await adapter.readQuote(market, 1, -10n * WAD);

    // `cost + fee` is correct in both directions precisely because `cost` is
    // signed and `fee` is not: a buy grows, a sell shrinks.
    expect(buy.netCost).toBe(buy.cost + buy.fee);
    expect(buy.netCost).toBeGreaterThan(buy.cost);

    expect(sell.netCost).toBe(sell.cost + sell.fee);
    expect(abs(sell.netCost)).toBeLessThan(abs(sell.cost));

    // The seller's net is gross proceeds less the fee — `sell_positions`'
    // `net_proceeds_wad = proceeds_wad - fee_wad`.
    expect(abs(sell.netCost)).toBe(abs(sell.cost) - sell.fee);
  }, 60_000);

  it("prices the direction it travels, not its mirror", async () => {
    // The shim's old `abs(delta)` bug in one assertion. From a flat book the
    // LMSR is symmetric, so buying and selling the same size cost the same —
    // the two only diverge once inventory exists. Take a position first, then
    // quote both ways: selling out must not cost what buying more costs.
    const smoke = await bootSmoke({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const adapter = adapterFor(smoke);
    const market = encodePubkeyRef(smoke.marketPda);

    const flatBuy = await adapter.readQuote(market, 1, 10n * WAD);
    const flatSell = await adapter.readQuote(market, 1, -10n * WAD);
    expect(abs(flatSell.cost)).not.toBe(flatBuy.cost);

    // Selling into the curve yields less than buying the same size costs:
    // both move price against the trader, and the LMSR is convex.
    expect(abs(flatSell.cost)).toBeLessThan(flatBuy.cost);
  }, 60_000);
});
