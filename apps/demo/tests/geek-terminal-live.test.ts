// The Geek terminal against the real program.
//
// Every command that submits a transaction runs here, in order, the way a
// person at the terminal would: fund, inspect, trade both directions, run a
// seeded simulation, graduate the market, and trade the book that graduation
// unlocks — including the first order on a market whose book account does not
// exist yet, which is the case every freshly graduated market is in.

import { expect, test } from "vitest";
import { Transaction, type Connection } from "@solana/web3.js";
import {
  SolanaChainAdapter,
  encodePubkeyRef,
  type SignerRef,
} from "@sooth/sdk-solana";
import { bootSmoke } from "../../../packages/sdk-solana/tests/fixtures/setup";
import { LiteSvmConnection } from "../../../packages/sdk-solana/tests/fixtures/svm";
import { SoothSDK } from "../src/lib/sdk";

const WAD = 1_000_000_000_000_000_000n;

test("terminal session: trade → simulate → graduate → book", async () => {
  // Small b so `graduate` completes in a handful of rounds.
  const smoke = await bootSmoke({
    bWad: 50n * WAD,
    userUsdcBaseUnits: 5_000_000_000n, // 5,000 USDC
  });
  const conn = new LiteSvmConnection(smoke.ctx);
  const adapter = new SolanaChainAdapter({
    node: {
      id: "demo-litesvm",
      chainKind: "solana",
      chainId: "test",
      rpcUrl: "http://localhost:8899",
    },
    programIds: smoke.programs,
    bookMint: smoke.usdcMint,
    ammMint: smoke.ammMint,
    connection: conn as unknown as Connection,
  });
  const signer: SignerRef = {
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
  const demo = {
    adapter,
    userRef: encodePubkeyRef(smoke.user.publicKey),
    signer,
    marketRef: null as string | null,
    connected: true,
  };
  const sdk = new SoothSDK(0, null, null, smoke.user.publicKey.toBase58(), demo);
  const run = async (cmd: string) => {
    const r = await sdk.executeCommand(cmd);
    const text = r.output.map((l) => l.text).join("\n");
    return { ...r, text };
  };

  // Discovery: point the terminal at the fixture's market.
  const set = await run(`setmarket ${smoke.marketPda.toBase58()}`);
  expect(set.result.success).toBe(true);

  const status = await run("status");
  expect(status.result.success, status.text).toBe(true);
  expect(status.text).toContain("Live");
  expect(status.text).toContain("Graduated: false");

  // AMM, both directions.
  expect((await run("buyyes 10")).result.success).toBe(true);
  expect((await run("buyno 4")).result.success).toBe(true);
  const sell = await run("sell 3 yes");
  expect(sell.result.success, sell.text).toBe(true);
  expect(sell.text, sell.text).toMatch(/proceeds \d+\.\d+ USDC \(fee /);

  const buyWithCost = await run("buyyes 2");
  expect(buyWithCost.text).toMatch(/cost \d+\.\d+ USDC \(fee /);

  // Seeded flow: deterministic, and every step lands or is reported.
  const sim = await run("simulate 6 2 42");
  expect(sim.result.success, sim.text).toBe(true);
  expect(sim.text).toContain("6 ok, 0 failed");

  // Same seed, same shape of run — the transcript names each action.
  expect(sim.text).toMatch(/buy (YES|NO)/);

  // Graduate, then the book venue the flip unlocks.
  const grad = await run("graduate 25 40");
  expect(grad.result.success, grad.text).toBe(true);
  expect(grad.text).toContain("Graduated after");
  expect(grad.text, grad.text).toMatch(/spent ~\d+\.\d+ USDC/);

  // First order on a fresh book: the account does not exist until now.
  const place = await run("place bid 450 25");
  expect(place.result.success, place.text).toBe(true);
  expect(place.text).toContain("Book account created");

  const book = await run("book");
  expect(book.result.success, book.text).toBe(true);
  expect(book.text).toContain("bid");
  expect(book.text).toContain("450");

  const orders = await run("orders");
  expect(orders.result.success, orders.text).toBe(true);
  const seq = /seq[\s\S]*?(\d+)\s+bid/.exec(orders.text)?.[1];
  expect(seq, orders.text).toBeTruthy();

  const cancel = await run(`cancelorder ${seq}`);
  expect(cancel.result.success, cancel.text).toBe(true);

  // Post-graduation simulate rests book orders around the price.
  const bookSim = await run("simulate 4 2 7");
  expect(bookSim.result.success, bookSim.text).toBe(true);
  expect(bookSim.text).toMatch(/place (bid|ask)/);

  // Balance reads through the same session.
  const bal = await run("balance");
  expect(bal.result.success).toBe(true);
  expect(bal.text).toContain("USDC");
}, 120_000);
