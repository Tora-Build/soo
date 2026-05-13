import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  createSeededOrderbookMarketViaAdapter,
  deriveBookSidePda,
  deriveMarketBookPda,
  fetchOrderbookPosition,
  fetchTransactionLogs,
  forceAmmGraduatedViaSurfpool,
  initMarketFeePoolViaAdapter,
  loadCreatorKeypair,
  loadTestKeypair,
  minRestingOrderForTick,
  mintOrderbookCompleteSetViaAdapter,
  placeOrderbookBuyViaAdapter,
} from "../helpers/sdk-helpers";

const WAD = 10n ** 18n;
const SIDE_YES = 1;
const DUST_EVENT_DISCRIMINATOR = createHash("sha256")
  .update("event:DustOrderSkipped")
  .digest()
  .subarray(0, 8);

interface DustEvent {
  side: number;
  tick: number;
  amount: bigint;
  escrow: boolean;
}

function readU128LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
}

function dustEvents(logs: string[]): DustEvent[] {
  const out: DustEvent[] = [];
  for (const line of logs) {
    const match = /^Program data: ([A-Za-z0-9+/=]+)$/.exec(line.trim());
    if (!match) continue;
    const data = Buffer.from(match[1], "base64");
    if (data.length < 92) continue;
    if (!data.subarray(0, 8).equals(DUST_EVENT_DISCRIMINATOR)) continue;
    out.push({
      side: data.readUInt8(40),
      tick: data.readUInt16LE(41),
      amount: readU128LE(data, 75),
      escrow: data.readUInt8(91) !== 0,
    });
  }
  return out;
}

async function accountDataHex(
  conn: ReturnType<typeof makeConnection>,
  pubkey: PublicKey,
): Promise<string | null> {
  const info = await conn.getAccountInfo(pubkey);
  return info?.data.toString("hex") ?? null;
}

test.describe("orderbook dust handling (W8)", () => {
  test("dust orders skip resting state and escrow dust refunds the predebit", async () => {
    test.setTimeout(180_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const trader = loadTestKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);

    const ob = await createSeededOrderbookMarketViaAdapter({
      conn,
      creator,
      usdcMint,
    });
    await forceAmmGraduatedViaSurfpool({ conn, marketId: ob.marketId });
    await initMarketFeePoolViaAdapter({
      conn,
      signer: creator,
      usdcMint,
      marketPda: ob.soothMarketPda,
      marketId: ob.marketId,
    });

    await placeOrderbookBuyViaAdapter({
      conn,
      signer: trader,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side: SIDE_YES,
      tick: 500,
      amount: WAD,
    });

    const marketBook = deriveMarketBookPda(ob.marketId);
    const dustBookSide = deriveBookSidePda(ob.marketId, SIDE_YES, 999);
    const marketBookBefore = await accountDataHex(conn, marketBook);
    const bookSideBefore = await accountDataHex(conn, dustBookSide);
    const nonEscrowDust = minRestingOrderForTick(999) - 1n;

    const dustTx = await placeOrderbookBuyViaAdapter({
      conn,
      signer: trader,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side: SIDE_YES,
      tick: 999,
      amount: nonEscrowDust,
    });
    const logs = await fetchTransactionLogs(conn, dustTx);
    expect(dustEvents(logs)).toContainEqual({
      side: SIDE_YES,
      tick: 999,
      amount: nonEscrowDust,
      escrow: false,
    });
    expect(await accountDataHex(conn, marketBook)).toBe(marketBookBefore);
    expect(await accountDataHex(conn, dustBookSide)).toBe(bookSideBefore);

    await mintOrderbookCompleteSetViaAdapter({
      conn,
      signer: trader,
      usdcMint,
      marketPda: ob.soothMarketPda,
      amount: 1_000_000n,
    });
    const beforeEscrow = await fetchOrderbookPosition({
      conn,
      marketId: ob.marketId,
      user: trader.publicKey,
    });
    const escrowDust = minRestingOrderForTick(1) - 1n;
    const marketBookBeforeEscrow = await accountDataHex(conn, marketBook);
    const bookSideBeforeEscrow = await accountDataHex(conn, dustBookSide);

    const escrowDustTx = await placeOrderbookBuyViaAdapter({
      conn,
      signer: trader,
      usdcMint,
      marketPda: ob.soothMarketPda,
      side: SIDE_YES,
      tick: 999,
      amount: escrowDust,
      escrow: true,
    });
    const escrowLogs = await fetchTransactionLogs(conn, escrowDustTx);
    expect(dustEvents(escrowLogs)).toContainEqual({
      side: SIDE_YES,
      tick: 999,
      amount: escrowDust,
      escrow: true,
    });

    const afterEscrow = await fetchOrderbookPosition({
      conn,
      marketId: ob.marketId,
      user: trader.publicKey,
    });
    expect(afterEscrow.noShares).toBe(beforeEscrow.noShares);
    expect(afterEscrow.yesShares).toBe(beforeEscrow.yesShares);
    expect(await accountDataHex(conn, marketBook)).toBe(marketBookBeforeEscrow);
    expect(await accountDataHex(conn, dustBookSide)).toBe(bookSideBeforeEscrow);
  });
});
