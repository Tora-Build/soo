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
import {
  Clock,
  LiteSvmConnection,
} from "../../../packages/sdk-solana/tests/fixtures/svm";
import { SoothSDK } from "../src/lib/sdk";

const WAD = 1_000_000_000_000_000_000n;

test("terminal session: trade → simulate → graduate → book", async () => {
  // Small b so `graduate` completes in a handful of rounds.
  const smoke = await bootSmoke({
    bWad: 50n * WAD,
    userUsdcBaseUnits: 5_000_000_000n, // 5,000 USDC
    vetoPeriodSecs: 120,
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

  // ── Actors: a popup-free fleet funded by ONE signed transfer ──
  // Vite loads .env.local before tests run and vi.stubEnv cannot override an
  // already-defined import.meta.env key, so the fixture's key is injected
  // through the SDK's own override seam.
  sdk.faucetAuthorityBytes = JSON.stringify(
    Array.from(smoke.mintAuthority.secretKey),
  );
  await run("actors clear");

  // Burst refuses without a fleet — every tx must sign in-page.
  const noFleet = await run("burst 4");
  expect(noFleet.result.success).toBe(false);
  expect(noFleet.text).toContain("actors");

  const created = await run("actors create 3");
  expect(created.result.success, created.text).toBe(true);

  const funded = await run("actors fund 0.05 200");
  expect(funded.result.success, funded.text).toBe(true);
  expect(funded.text).toContain("SOL: 0.05 × 3");
  expect(funded.text).toContain("× 3/3 minted");

  const roster = await run("actors");
  expect(roster.text).toContain("Actors (3)");
  expect(roster.text).toContain("USDC 200.00");

  // ── Scripted burst on the bonding curve ──
  // A story, not noise: two buys land, the impossible sell is refused at
  // build time with the reason on its row — a plan can never silently drop
  // a leg.
  await run("plan a0 buy yes 2");
  await run("plan a1 buy no 1.5");
  const planned = await run("plan a2 sell yes 1");
  expect(planned.text).toContain("Burst plan — 3 row(s)");
  const scripted = await run("burst");
  expect(scripted.result.success, scripted.text).toBe(true);
  expect(scripted.text).toContain("scripted plan, 2 of 3 row(s) executable");
  expect(scripted.text).toMatch(/00 {4,}buy YES/);
  expect(scripted.text).toMatch(/SKIP: no position on this market yet|SKIP: holds 0/);
  expect(scripted.text).toMatch(/2\/2 confirmed/);
  // The plan is consumed by the run — the next burst is random again.
  expect((await run("plan")).text).toContain("No plan");

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


  // The fleet trades the book, each step signed by a different actor.
  const fleetSim = await run("simulate 6 2 9");
  expect(fleetSim.result.success, fleetSim.text).toBe(true);
  expect(fleetSim.text).toContain("3 actors");
  for (const label of ["00:", "01:", "02:"]) {
    expect(fleetSim.text, fleetSim.text).toContain(label);
  }

  // A plan against a graduated market is refused with the reason, not run.
  await run("plan a0 buy yes 1");
  const planOnBook = await run("burst");
  expect(planOnBook.result.success).toBe(false);
  expect(planOnBook.text).toContain("graduated to the order book");
  await run("plan clear");

  // Burst: all four trades signed up front, sent together, all confirmed.
  // The fixture expires the blockhash after every landed transaction, so the
  // first wave can only ever carry one — the fresh-blockhash retry wave is
  // what completes the burst here. On devnet, where a blockhash lives ~60s,
  // the first wave carries them all.
  const burst = await run("burst 4 1 11");
  expect(burst.result.success, burst.text).toBe(true);
  // The live table: a header, and every row ends in its confirmed state.
  expect(burst.text).toContain("#   actor  action");
  expect(burst.text).toContain("re-sent with a fresh blockhash");
  expect(burst.text).toMatch(/✓ confirmed/);
  expect(burst.text).toMatch(/4\/4 confirmed .* tx\/s/);

  // Export prints a base58 secret a wallet can import; clear forgets it.
  const exported = await run("actors export 1");
  expect(exported.result.success).toBe(true);
  expect(exported.text).toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/);
  await run("actors clear");
  expect((await run("actors")).text).toContain("No actors");

  // Balance reads through the same session.
  const bal = await run("balance");
  expect(bal.result.success).toBe(true);
  expect(bal.text).toContain("USDC");

  // ── Resolution: deadline → lock → attest → veto → settle → redeem ──
  // The adjudicator runs their own terminal; the fixture names the creator.
  const creatorSdk = new SoothSDK(0, null, null, smoke.creator.publicKey.toBase58(), {
    adapter,
    userRef: encodePubkeyRef(smoke.creator.publicKey),
    signer: {
      publicKey: smoke.creator.publicKey.toBase58(),
      signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => {
        const tx = Transaction.from(raw);
        tx.partialSign(smoke.creator);
        return tx.serialize({ verifySignatures: false, requireAllSignatures: false });
      },
    },
    marketRef: null,
    connected: true,
  });
  await creatorSdk.executeCommand(`setmarket ${smoke.marketPda.toBase58()}`);
  const runAsCreator = async (cmd: string) => {
    const r = await creatorSdk.executeCommand(cmd);
    return { ...r, text: r.output.map((l) => l.text).join("\n") };
  };

  const warpTo = async (unixSec: bigint) => {
    const pre = await smoke.ctx.banksClient.getClock();
    smoke.ctx.warpToSlot(pre.slot + 1n);
    const post = await smoke.ctx.banksClient.getClock();
    smoke.ctx.setClock(
      new Clock(post.slot, post.epochStartTimestamp, post.epoch, post.leaderScheduleEpoch, unixSec),
    );
  };

  // Before the deadline, the resolution readout says so and points at lock.
  const early = await run("resolution");
  expect(early.text).toContain("Lifecycle:   Open");
  expect(early.text).toContain("lock — permissionless once the deadline");

  const soothRef = encodePubkeyRef(smoke.marketPda);
  const deadline = (await adapter.readResolutionState(soothRef))!.deadline;
  await warpTo(deadline + 1n);

  // lock is permissionless — the trader's terminal can do it.
  const locked = await run("lock");
  expect(locked.result.success, locked.text).toBe(true);
  expect((await run("resolution")).text).toContain("Lifecycle:   Locked");

  // attest is not: the trader is refused, the adjudicator is not.
  const wrongSigner = await run("attest yes");
  expect(wrongSigner.result.success).toBe(false);
  const attested = await runAsCreator("attest yes");
  expect(attested.result.success, attested.text).toBe(true);

  const inVeto = await run("resolution");
  expect(inVeto.text).toContain("Attested:    YES");
  expect(inVeto.text).toContain("120s window");
  expect(inVeto.text).toContain("Next: settle");

  // settle inside the window must fail; past it, anyone settles.
  const tooEarly = await run("settle");
  expect(tooEarly.result.success, tooEarly.text).toBe(false);
  const state = await adapter.readResolutionState(soothRef);
  await warpTo((state!.adjudicatorEntry!.attestedAt ?? 0n) + 121n);
  const settled = await run("settle");
  expect(settled.result.success, settled.text).toBe(true);
  expect((await run("resolution")).text).toContain("winning outcome YES");

  // redeem pays the trader's YES shares.
  const redeemed = await run("redeem");
  expect(redeemed.result.success, redeemed.text).toBe(true);
}, 120_000);
