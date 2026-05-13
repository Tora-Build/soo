import { test, expect } from "@playwright/test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  createSeededOrderbookMarketViaAdapter,
  deriveMarketFeePoolPda,
  distributeMarketFeesViaAdapter,
  forceAmmGraduatedViaSurfpool,
  fundOrderbookTrader,
  getTokenAccountAmount,
  initMarketFeePoolViaAdapter,
  loadCreatorKeypair,
  loadMintAuthorityKeypair,
  placeOrderbookBuyViaAdapter,
  type FreshOrderbookMarketSetup,
} from "../helpers/sdk-helpers";

const WAD = 10n ** 18n;
const SIDE_NO = 0;
const SIDE_YES = 1;

async function prepareOrderbookMarket(args: {
  conn: ReturnType<typeof makeConnection>;
  creator: ReturnType<typeof loadCreatorKeypair>;
  usdcMint: PublicKey;
}): Promise<FreshOrderbookMarketSetup> {
  const ob = await createSeededOrderbookMarketViaAdapter({
    conn: args.conn,
    creator: args.creator,
    usdcMint: args.usdcMint,
  });
  await forceAmmGraduatedViaSurfpool({ conn: args.conn, marketId: ob.marketId });
  await initMarketFeePoolViaAdapter({
    conn: args.conn,
    signer: args.creator,
    usdcMint: args.usdcMint,
    marketPda: ob.soothMarketPda,
    marketId: ob.marketId,
  });
  return ob;
}

async function crossOneFill(args: {
  conn: ReturnType<typeof makeConnection>;
  mintAuthority: ReturnType<typeof loadMintAuthorityKeypair>;
  usdcMint: PublicKey;
  market: FreshOrderbookMarketSetup;
}): Promise<void> {
  const maker = Keypair.generate();
  const taker = Keypair.generate();
  await fundOrderbookTrader({
    conn: args.conn,
    trader: maker,
    mintAuthority: args.mintAuthority,
    usdcMint: args.usdcMint,
  });
  await fundOrderbookTrader({
    conn: args.conn,
    trader: taker,
    mintAuthority: args.mintAuthority,
    usdcMint: args.usdcMint,
  });

  await placeOrderbookBuyViaAdapter({
    conn: args.conn,
    signer: maker,
    usdcMint: args.usdcMint,
    marketPda: args.market.soothMarketPda,
    side: SIDE_NO,
    tick: 300,
    amount: 10n * WAD,
  });
  await placeOrderbookBuyViaAdapter({
    conn: args.conn,
    signer: taker,
    usdcMint: args.usdcMint,
    marketPda: args.market.soothMarketPda,
    side: SIDE_YES,
    tick: 700,
    amount: 10n * WAD,
  });
}

test.describe("orderbook per-market fee pools (W8)", () => {
  test("fills and distribute_fees drain only the addressed market pool", async () => {
    test.setTimeout(240_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const mintAuthority = loadMintAuthorityKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);

    const marketA = await prepareOrderbookMarket({ conn, creator, usdcMint });
    const marketB = await prepareOrderbookMarket({ conn, creator, usdcMint });
    const poolA = deriveMarketFeePoolPda(marketA.marketId);
    const poolB = deriveMarketFeePoolPda(marketB.marketId);

    expect(await getTokenAccountAmount(conn, poolA)).toBe(0n);
    expect(await getTokenAccountAmount(conn, poolB)).toBe(0n);

    await crossOneFill({ conn, mintAuthority, usdcMint, market: marketA });
    const poolAAfterA = await getTokenAccountAmount(conn, poolA);
    const poolBAfterA = await getTokenAccountAmount(conn, poolB);
    expect(poolAAfterA).toBeGreaterThan(0n);
    expect(poolBAfterA).toBe(0n);

    await crossOneFill({ conn, mintAuthority, usdcMint, market: marketB });
    const poolAAfterB = await getTokenAccountAmount(conn, poolA);
    const poolBAfterB = await getTokenAccountAmount(conn, poolB);
    expect(poolAAfterB).toBe(poolAAfterA);
    expect(poolBAfterB).toBeGreaterThan(0n);

    await distributeMarketFeesViaAdapter({
      conn,
      signer: creator,
      usdcMint,
      marketPda: marketA.soothMarketPda,
      marketId: marketA.marketId,
    });
    expect(await getTokenAccountAmount(conn, poolA)).toBe(0n);
    expect(await getTokenAccountAmount(conn, poolB)).toBe(poolBAfterB);

    await distributeMarketFeesViaAdapter({
      conn,
      signer: creator,
      usdcMint,
      marketPda: marketB.soothMarketPda,
      marketId: marketB.marketId,
    });
    expect(await getTokenAccountAmount(conn, poolA)).toBe(0n);
    expect(await getTokenAccountAmount(conn, poolB)).toBe(0n);
  });
});
