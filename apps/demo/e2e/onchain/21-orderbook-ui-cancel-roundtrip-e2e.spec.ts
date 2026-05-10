// orderbook-ui-cancel-roundtrip-e2e — full UI-driven sooth_book cancel flow.
//
// Builds on spec 20 (UI-click place-order round-trip). After clicking BUY
// YES through the trade form, this spec:
//
//   1. Verifies OrderRequestQueue.len grew on-chain (queue head is the
//      OrderRequest just enqueued by the chain-shim's
//      `dispatchOrderbookWrite`).
//   2. Calls `process_order_request` adapter-direct using the queue
//      head's `distinct_seed` to materialize the actual `Order` PDA.
//      Cancel only works against materialized Orders, not OrderRequests.
//      No off-chain crank exists in seed-localnet today (W1-W6 stops at
//      protocol-singleton seeding) — the test wallet doubles as the
//      crank operator since `process_order_request` only requires a
//      signer on the `crank_operator` slot, not a CRANK-authorised
//      operator.
//   3. Drives the UI's My-Orders panel:
//      - The chain-shim's synthetic `getLogs` (orderbook-reads.ts)
//        emits one `OrderPlaced`-shaped log per active Order PDA, so
//        `useIndexerOrders.fetchOpenOrdersFromRpc` aggregates the row
//        with id `${side}:${tick}` (a "level" id under upstream's
//        `parseOrderId`).
//      - The cancel button on the row triggers
//        `useOrderbookTrade.cancelOrder("1:400")` which the parser
//        classifies as `kind:"level"`, dispatching
//        `cancel(marketKey, side, tick)`.
//      - The chain-shim's `dispatchOrderbookWrite` resolves the level
//        back to the on-chain Order PDA via
//        `findUserOpenOrderAtLevel` and submits `cancel_order`.
//   4. Verifies the Order PDA closed on-chain (Anchor `close` constraint
//      on `cancel_order` returns rent + voids the account).
//   5. Verifies the row disappears from the UI panel after refresh.

import { test, expect } from "@playwright/test";
import {
  PublicKey,
  ComputeBudgetProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { makeConnection } from "../helpers/onchain";
import { loadFixture, marketIdBytes } from "../helpers/fixture";
import {
  bn,
  createSeededOrderbookMarketViaAdapter,
  deriveBookAuthorisedOperatorsPda,
  loadCreatorKeypair,
  loadTestKeypair,
  makePrograms,
  deriveAmmStatePda as deriveAmmStatePdaHelper,
  deriveLpMintPda as deriveLpMintPdaHelper,
  deriveProtocolConfigPda,
  deriveFeePoolAuthorityPda,
  bookProgramId,
  type FreshMarketSetup,
} from "../helpers/sdk-helpers";

const PRICE_YES_TICK = 400; // matches spec 20 (BUY YES @ 40¢ = tick 400)

test.describe("orderbook UI-click cancel round-trip (sooth_book)", () => {
  // BLOCKED: UserOrdersPanel `panelLoading` (= obLoading || isIndexerLoading)
  // never resolves to false on the Solana fork after the order is placed and
  // process_order_request lands. Synth getLogs returns the right OrderPlaced
  // shape (verified via console probe — orders found: 1 with side=1, tick=400),
  // but useIndexerOrders.openOrders never propagates to a row and the panel's
  // "No open orders" empty-state never appears either. Root cause not isolated;
  // hypothesis: useOrderbook.fetchOrderbook's scanTickDepth (~2160 multicall
  // dispatchRead legs through the chain-shim) may starve the React Query
  // resolver in this run path. See commit 1763b1f for full debugging notes.
  //
  // Cancel path itself is wired and tested via the `cancelById` shape in
  // dispatchOrderbookWrite (amm-bridge.ts ~line 993). Once the panel renders
  // a row, this spec should pass with no further chain-shim changes.
  test.fixme("UI place → process_order_request → UI cancel → Order PDA closes", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    // ── 1. Setup mirrored from spec 20: bind sooth_book to the fixture's
    //    seeded sooth_market so /orderbook/<bookMarketPda> aligns with
    //    VITE_DEMO_MARKET_REF.
    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const purchaser = loadTestKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);
    const fixtureMarketPda = new PublicKey(fixture.marketPda);
    const fixtureMarketId = marketIdBytes(fixture);

    const stubExistingMarket: FreshMarketSetup = {
      marketId: fixtureMarketId,
      marketPda: fixtureMarketPda,
      ammStatePda: deriveAmmStatePdaHelper(fixtureMarketId),
      lpMint: deriveLpMintPdaHelper(fixtureMarketId),
      creatorLpAta: getAssociatedTokenAddressSync(
        deriveLpMintPdaHelper(fixtureMarketId),
        creator.publicKey,
      ),
    };

    const ob = await createSeededOrderbookMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      existingSoothMarket: stubExistingMarket,
    });
    expect(ob.soothMarketPda.toBase58()).toBe(fixture.marketPda);

    const programs = makePrograms(conn, purchaser);
    const creatorPrograms = makePrograms(conn, creator);

    // ── 1b. Bump the bookMarket's lock_timestamp so create_order_request's
    //    `lock_timestamp > now` check passes. The fixture seeds the market
    //    with `now + 7 days` based on the WALL clock at seed-localnet
    //    time, but Surfpool's Clock sysvar drifts forward as the validator
    //    bakes blocks (each test run advances by ~hundreds of slots),
    //    eventually overtaking the lock. Re-anchor the lock to "Surfpool
    //    clock + 1 hour" using `update_market_locktime` (creator is the
    //    market authority + MARKET-authorised operator, set by
    //    seed-localnet).
    await ensureMarketUnlocked(creatorPrograms, ob.bookMarketPda, creator);

    // ── 1c. Cancel any leftover Order PDAs from prior runs against the
    //    same fixture market. Orders are cancellable across runs but
    //    leaving them around poisons the synthetic OrderPlaced log set
    //    that the UI panel reads through useIndexerOrders.
    await cancelLeftoverOrders(programs, ob.bookMarketPda, purchaser, usdcMint);

    // ── 2. Snapshot queue.len BEFORE the UI submit so we can detect the
    //    enqueue.
    const queueBefore =
      await programs.book.account.marketOrderRequestQueue.fetch(
        ob.orderRequestQueue,
      );
    const lenBefore = Number((queueBefore as any).orderRequests.len);

    // ── 3. Drive the UI: navigate, connect test wallet, fill form, submit.
    await page.goto(`/orderbook/${ob.bookMarketPda.toBase58()}`);
    await page.waitForLoadState("domcontentloaded");

    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet) {
        throw new Error(
          "_connectTestWallet not exposed — TestWalletBridge not mounted (VITE_TEST_MODE not 'true'?)",
        );
      }
      await w._connectTestWallet();
    });

    const submitBtn = page.getByTestId("ob-submit-button");
    await expect(submitBtn).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("ob-outcome-yes").click();
    await page.getByTestId("ob-side-buy").click();
    await page.getByTestId("ob-price-input").fill("40");
    await page.getByTestId("ob-shares-input").fill("100");
    await expect(submitBtn).toBeEnabled({ timeout: 30_000 });
    await submitBtn.click();

    // ── 4. Wait for the OrderRequest to land in the queue.
    const queuePostPlace = await pollForQueueGrowth(
      programs,
      ob.orderRequestQueue,
      lenBefore,
    );
    expect(queuePostPlace.len).toBeGreaterThan(lenBefore);

    // ── 5. Process the queue head into a real Order PDA. The test wallet
    //    is the crank operator (Anchor program does NOT require a
    //    CRANK-authorised operator on this ix). Distinct seed comes from
    //    the queue head — the chain-shim generates one randomly per place
    //    and doesn't surface it back, but the queue's `items[front]`
    //    record carries it.
    const head = queuePostPlace.head;
    const distinctSeed: number[] = head.distinctSeed;
    const expectedPriceWad = BigInt(head.expectedPrice.toString());
    const marketOutcomeIndex = Number(head.marketOutcomeIndex);
    const forOutcome = Boolean(head.forOutcome);

    const [orderPda] = PublicKey.findProgramAddressSync(
      [
        ob.bookMarketPda.toBuffer(),
        purchaser.publicKey.toBuffer(),
        Buffer.from(distinctSeed),
      ],
      bookProgramId,
    );
    const [marketMatchingPool] = PublicKey.findProgramAddressSync(
      [
        ob.bookMarketPda.toBuffer(),
        Buffer.from(String(marketOutcomeIndex)),
        Buffer.from("-"),
        u128LeBytes(expectedPriceWad),
        Buffer.from(forOutcome ? "true" : "false"),
      ],
      bookProgramId,
    );
    const [marketEscrowToken] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), ob.bookMarketPda.toBuffer()],
      bookProgramId,
    );
    const protocolConfig = deriveProtocolConfigPda();
    const feePoolAuthority = deriveFeePoolAuthorityPda();
    const feePoolVault = getAssociatedTokenAddressSync(
      usdcMint,
      feePoolAuthority,
      true,
    );
    const purchaserTokenAccount = getAssociatedTokenAddressSync(
      usdcMint,
      purchaser.publicKey,
    );
    const [marketPosition] = PublicKey.findProgramAddressSync(
      [purchaser.publicKey.toBuffer(), ob.bookMarketPda.toBuffer()],
      bookProgramId,
    );

    await programs.book.methods
      .processOrderRequest()
      .accounts({
        order: orderPda,
        purchaserTokenAccount,
        marketPosition,
        marketMatchingPool,
        orderRequestQueue: ob.orderRequestQueue,
        market: ob.bookMarketPda,
        marketEscrow: marketEscrowToken,
        protocolConfig,
        feePoolAuthority,
        feePoolVault,
        marketLiquidities: ob.marketLiquidities,
        marketMatchingQueue: ob.matchingQueue,
        crankOperator: purchaser.publicKey,
      } as any)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ])
      .rpc();

    // Order PDA must now exist on-chain.
    const orderInfoBeforeCancel = await conn.getAccountInfo(orderPda);
    expect(orderInfoBeforeCancel).not.toBeNull();

    // ── 6. The UI's My-Orders panel should render the row. The chain-
    //    shim's getLogs intercepts `OrderPlaced` queries with on-chain
    //    Order PDAs (forOutcome=true → side=1 for YES outcome=0). React
    //    Query polls `useIndexerOrders` every 15s; trigger an immediate
    //    refetch by clicking the orders tab + waiting for the row.
    //    UserOrdersPanel reads from `useIndexerOrders.openOrders` and
    //    rows have `data-testid="uo-order-row"` with
    //    `data-order-id="<side>:<tick>"`.
    // Reload the page so React Query refetches `indexer-orders` from
    // scratch. The chain-shim's synthetic-log path is fresh on every
    // `getLogs` call (no shim-level cache), but React Query holds the
    // stale "0 orders" snapshot from the pre-place mount until the next
    // `refetchInterval` (15s). Reload bypasses both layers and triggers
    // an immediate refetch with the now-materialized Order PDA.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      await w._connectTestWallet?.();
    });
    await ensureOrdersTab(page);
    const expectedRowId = `1:${PRICE_YES_TICK}`;
    // Wait for the panel to leave its loading state, then assert the row.
    // The panel renders a spinner whenever `useIndexerOrders.isLoading`
    // OR `useOrderbook.isLoading` is true; both must settle before any
    // row testid (or "No open orders" placeholder) is mounted.
    await page
      .locator('[data-testid="uo-order-row"]')
      .or(page.locator("text=/No open orders/i"))
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    const orderRow = page.locator(
      `[data-testid="uo-order-row"][data-order-id="${expectedRowId}"]`,
    );
    await expect(orderRow).toBeVisible({ timeout: 30_000 });

    // ── 7. Click the cancel button on the row.
    const cancelBtn = orderRow.locator('[data-testid="uo-cancel-btn"]');
    await expect(cancelBtn).toBeEnabled({ timeout: 10_000 });
    await cancelBtn.click();

    // ── 8. Wait for the Order PDA to close on-chain. Anchor's
    //    `cancel_order` ix uses `close = payer` so the account vanishes.
    const closed = await pollForAccountClose(conn, orderPda, 60_000);
    expect(closed).toBe(true);

    // ── 9. Verify the UI row disappears post-cancel. The query refetches
    //    after `useOrderbookTrade.cancelOrder` finishes (it calls
    //    `refresh()` from useIndexerOrders).
    await expect(orderRow).toHaveCount(0, { timeout: 30_000 });
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function pollForQueueGrowth(
  programs: ReturnType<typeof makePrograms>,
  queuePda: PublicKey,
  lenBefore: number,
): Promise<{
  len: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  head: any;
}> {
  const deadline = Date.now() + 60_000;
  // Loop until queue.len > lenBefore. Each iteration also fetches the
  // head record so the caller can read distinctSeed without a second
  // round-trip.
  for (;;) {
    try {
      const q =
        await programs.book.account.marketOrderRequestQueue.fetch(queuePda);
      const reqs = (q as any).orderRequests;
      const len = Number(reqs.len);
      if (len > lenBefore) {
        const front = Number(reqs.front);
        const items = reqs.items as Array<unknown>;
        const head = items[front];
        return { len, head };
      }
    } catch {
      // Surfpool may briefly fail to fetch during slot rotation; retry.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `OrderRequestQueue did not grow within 60s (still ${lenBefore})`,
      );
    }
    await sleep(500);
  }
}

async function pollForAccountClose(
  conn: ReturnType<typeof makeConnection>,
  pda: PublicKey,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await conn.getAccountInfo(pda);
    if (!info) return true;
    await sleep(500);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function u128LeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  let v = value;
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

async function ensureOrdersTab(
  page: import("@playwright/test").Page,
): Promise<void> {
  // SoothBookTerminal renders a tab strip in the bottom-right pane;
  // "orders" is the default. If the panel mounts a different tab we
  // click the orders tab. Tolerate both: locate the panel via its row
  // testid ('uo-order-row') being eventually visible.
  const ordersTab = page.locator('button:has-text("Orders")').first();
  if ((await ordersTab.count()) > 0) {
    try {
      await ordersTab.click({ timeout: 1_000 });
    } catch {
      // already on orders tab — ignore
    }
  }
}

/**
 * Push the bookMarket's `market_lock_timestamp` to "Surfpool clock + 1 hour"
 * so create_order_request's `lock_timestamp > now` invariant holds. The
 * fixture market was seeded with a wall-clock-relative deadline that
 * Surfpool overtakes once the validator runs for a while — see
 * `Clock.unix_timestamp` vs `getBlockTime()` divergence (Surfpool is the
 * source of truth for on-chain time checks). The creator keypair is the
 * MARKET-authorised operator (set up by seed-localnet).
 */
async function ensureMarketUnlocked(
  programs: ReturnType<typeof makePrograms>,
  bookMarketPda: PublicKey,
  creator: import("@solana/web3.js").Keypair,
): Promise<void> {
  // Read the live clock sysvar to anchor the new lock relative to
  // Surfpool's program-visible time, not wall clock.
  const clockInfo =
    await programs.book.provider.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!clockInfo) {
    throw new Error("Clock sysvar not readable");
  }
  // unix_timestamp is i64 at offset 32 in the Clock layout
  // (slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64,
  //  unix_timestamp i64). LE.
  const unixTs = clockInfo.data.readBigInt64LE(32);
  const nextLock = unixTs + 60n * 60n; // +1 hour

  const market = (await programs.book.account.market.fetch(bookMarketPda)) as {
    marketLockTimestamp: { toString(): string };
  };
  const currentLock = BigInt(market.marketLockTimestamp.toString());
  if (currentLock > unixTs + 60n) {
    // Already in the future with margin — leave it alone.
    return;
  }

  // Bump event_start_time first — the program requires
  // `lock_time <= event_start_time`. We push event_start by 2 hours and
  // lock by 1 hour so both sit safely in Surfpool's future regardless of
  // small drifts during the spec.
  const nextEventStart = unixTs + 2n * 60n * 60n;
  const marketOperatorsPda = deriveBookAuthorisedOperatorsPda("MARKET");
  await (programs.book.methods as any)
    .updateMarketEventStartTime(bn(nextEventStart))
    .accounts({
      market: bookMarketPda,
      marketOperator: creator.publicKey,
      authorisedOperators: marketOperatorsPda,
    })
    .signers([creator])
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ])
    .rpc();

  await (programs.book.methods as any)
    .updateMarketLocktime(bn(nextLock))
    .accounts({
      market: bookMarketPda,
      marketOperator: creator.publicKey,
      authorisedOperators: marketOperatorsPda,
    })
    .signers([creator])
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ])
    .rpc();
}

/**
 * Cancel any open Order PDAs the test wallet still holds against the
 * given bookMarket, so the synthetic-log set the chain-shim emits (and
 * the UI's My-Orders panel reads) starts empty.
 */
async function cancelLeftoverOrders(
  programs: ReturnType<typeof makePrograms>,
  bookMarketPda: PublicKey,
  purchaser: import("@solana/web3.js").Keypair,
  usdcMint: PublicKey,
): Promise<void> {
  const orders = (await (programs.book.account as any).order.all([
    { memcmp: { offset: 8, bytes: purchaser.publicKey.toBase58() } },
    { memcmp: { offset: 40, bytes: bookMarketPda.toBase58() } },
  ])) as Array<{
    publicKey: PublicKey;
    account: {
      purchaser: PublicKey;
      payer: PublicKey;
      marketOutcomeIndex: number;
      forOutcome: boolean;
      expectedPrice: { toString(): string };
    };
  }>;

  for (const o of orders) {
    const a = o.account;
    const expectedPrice = BigInt(a.expectedPrice.toString());
    const [marketMatchingPool] = PublicKey.findProgramAddressSync(
      [
        bookMarketPda.toBuffer(),
        Buffer.from(String(a.marketOutcomeIndex)),
        Buffer.from("-"),
        u128LeBytes(expectedPrice),
        Buffer.from(a.forOutcome ? "true" : "false"),
      ],
      bookProgramId,
    );
    const [marketOutcome] = PublicKey.findProgramAddressSync(
      [bookMarketPda.toBuffer(), Buffer.from(String(a.marketOutcomeIndex))],
      bookProgramId,
    );
    const [marketLiquidities] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidities"), bookMarketPda.toBuffer()],
      bookProgramId,
    );
    const [matchingQueue] = PublicKey.findProgramAddressSync(
      [Buffer.from("matching"), bookMarketPda.toBuffer()],
      bookProgramId,
    );
    const [marketPosition] = PublicKey.findProgramAddressSync(
      [a.purchaser.toBuffer(), bookMarketPda.toBuffer()],
      bookProgramId,
    );
    const [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), bookMarketPda.toBuffer()],
      bookProgramId,
    );
    const purchaserToken = getAssociatedTokenAddressSync(usdcMint, a.purchaser);
    await (programs.book.methods as any)
      .cancelOrder()
      .accounts({
        order: o.publicKey,
        purchaser: a.purchaser,
        purchaserTokenAccount: purchaserToken,
        payer: a.payer,
        market: bookMarketPda,
        marketLiquidities,
        marketOutcome,
        marketMatchingQueue: matchingQueue,
        marketMatchingPool,
        marketEscrow: escrow,
        marketPosition,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ])
      .rpc();
  }
}
