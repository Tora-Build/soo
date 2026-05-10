// dynamic-create-graduate-orderbook-e2e — full Solana-fork market lifecycle.
//
// Exercises the path that ties the launchpad UI, AMM bonding-curve graduation,
// and sooth_book orderbook all together for a SINGLE user-created market —
// the dynamic counterpart to spec 20 (which uses the global-setup fixture
// market). Five phases:
//
//   Phase 1 — UI create:
//     /launchpad form → click LAUNCH → chain-shim's dispatchCreateMarket lands
//     `sooth_launchpad::create_market` (4 inner CPIs). The chain-shim stashes
//     the new Market PDA on `globalThis.__lastCreatedMarketPda` because the
//     EVM-shaped Hash return upstream's Launchpad.tsx awaits cannot carry a
//     base58 pubkey through `decodeEventLog`.
//
//   Phase 2 — graduation:
//     The slider's $10 deposit floor (Launchpad.tsx:513) maps to b ≈ 14.43·WAD
//     at p=0.5. Real graduation needs `fee_b_base_wad ≥ b·ln(2) ≈ 10·WAD`;
//     with `fee_bps=100` each buy adds at most ~0.005·WAD, requiring ~2,000
//     buys — well past the q-overflow ceiling (`q > 170·WAD` overflows
//     `wad_div`). Spec 14 covers the real graduation path under a small-b
//     adapter-direct setup. Here we force `AmmState.is_graduated = true` via
//     Surfpool's `surfnet_setAccount` cheatcode so the spec asserts the
//     orderbook lifecycle wiring without re-litigating AMM mechanics.
//
//   Phase 3 — bind sooth_book to the new market:
//     `createSeededOrderbookMarketViaAdapter({ existingSoothMarket })` runs
//     the per-market init sequence on `sooth_book` (create_market +
//     initialize_market_outcome × 2 + open_market) against the freshly-
//     created sooth_market. Verifies the helper accepts a dynamic market —
//     not just the globalSetup fixture.
//
//   Phase 4 — orderbook UI mount + on-chain order placement:
//     Navigate to `/orderbook/<bookMarketPda>` and assert the
//     SoothBookTerminal mounts (submit button visible) — proves the URL
//     dispatcher resolved the dynamic bookMarketPda end-to-end. The actual
//     order placement is then driven adapter-direct against the new market's
//     `OrderRequestQueue` because the chain-shim's orderbook write path uses
//     `ctx.marketRef` (sourced from `import.meta.env.VITE_DEMO_MARKET_REF`,
//     i.e., the FIXTURE market) — which doesn't match the URL on this spec.
//     The protocol-level lifecycle is what matters here; the UI submit path
//     is already covered by spec 20 against the fixture-bound queue.
//
//   Phase 5 — on-chain verification:
//     The new market's `MarketOrderRequestQueue.len` grows by ≥1, proving
//     the full lifecycle landed against a dynamic UI-created market.

import { test, expect } from "@playwright/test";
import {
  ComputeBudgetProgram,
  PublicKey,
  type AccountInfo,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { randomBytes } from "node:crypto";
import { makeConnection } from "../helpers/onchain";
import { loadFixture } from "../helpers/fixture";
import {
  bn,
  createSeededOrderbookMarketViaAdapter,
  deriveAmmStatePda,
  deriveLpMintPda,
  fetchMarket,
  fetchAmmState,
  loadCreatorKeypair,
  loadTestKeypair,
  makePrograms,
  marketProgramId,
  type FreshMarketSetup,
} from "../helpers/sdk-helpers";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";

// `surfnet_setAccount` cheatcode wrapper. Surfpool's `data` field accepts a
// hex-encoded string per `crates/sdk/src/cheatcodes/mod.rs:set_account`
// (`hex::encode(data)` on the Rust side). The errors we worked through —
// "expected u8" then "Invalid hex data: Odd number of digits" — confirmed
// the JSON-RPC handler hex-decodes the string into the raw account bytes.
async function surfnetSetAccount(
  pubkey: PublicKey,
  info: AccountInfo<Buffer>,
  mutated: Buffer,
): Promise<void> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [
        pubkey.toBase58(),
        {
          lamports: info.lamports,
          owner: info.owner.toBase58(),
          data: mutated.toString("hex"),
          executable: info.executable,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`surfnet_setAccount: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { error?: { message: string } };
  if (json.error) {
    throw new Error(`surfnet_setAccount failed: ${json.error.message}`);
  }
}

test.describe("dynamic create → graduate → orderbook trade (full lifecycle)", () => {
  test("UI-create market → cheatcode-graduate → bind sooth_book → orderbook page mounts → adapter-direct order grows queue", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const creator = loadCreatorKeypair();
    const purchaser = loadTestKeypair();
    const usdcMint = new PublicKey(fixture.usdcMint);

    // ── Phase 1: UI-driven create via /launchpad ──────────────────────────
    await page.goto(`/launchpad`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet) {
        throw new Error(
          "_connectTestWallet not exposed (VITE_TEST_MODE=true?)",
        );
      }
      await w._connectTestWallet();
    });

    // Question must be ≥10 chars per launchpad's canCreateMarket gate.
    await page
      .getByTestId("launchpad-question-input")
      .fill(`Will spec 22 graduate this market ${Date.now()}?`);
    await page.getByTestId("launchpad-expiration-30d").click();
    await page.getByTestId("launchpad-adjudicator-manual").click();

    const launchBtn = page.getByTestId("launchpad-launch-button");
    await expect(launchBtn).toBeEnabled({ timeout: 15_000 });
    await launchBtn.click();

    // Pull the new Market PDA off the side-channel global the chain-shim
    // stashes *before* tx confirmation (Solana has no equivalent of
    // `decodeEventLog`, so the synthetic Hash return can't carry the PDA —
    // see chain-shim/amm-bridge.ts:dispatchCreateMarket).
    const newMarketPdaStr = await page.evaluate(async () => {
      const w = globalThis as unknown as { __lastCreatedMarketPda?: string };
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        if (w.__lastCreatedMarketPda) return w.__lastCreatedMarketPda;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(
        "globalThis.__lastCreatedMarketPda not set within 60s — createMarket dispatch likely failed",
      );
    });
    expect(newMarketPdaStr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const newMarketPda = new PublicKey(newMarketPdaStr);

    // Poll until the on-chain Market account materialises.
    let market = await fetchMarket(conn, newMarketPda);
    const pollDeadline = Date.now() + 60_000;
    while (market === null && Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      market = await fetchMarket(conn, newMarketPda);
    }
    expect(market).not.toBeNull();
    expect(market!.lifecycle).toBe(1); // Open
    const marketAcc = await conn.getAccountInfo(newMarketPda);
    expect(marketAcc).not.toBeNull();
    expect(marketAcc!.owner.toBase58()).toBe(marketProgramId.toBase58());

    // marketId is the random 16-byte tag the launchpad embeds at offset 8.
    const newMarketId = Buffer.from(marketAcc!.data.subarray(8, 24));

    // ── Phase 2: graduate the new market via cheatcode ────────────────────
    //
    // AmmState layout (per packages/programs-core/programs/sooth_amm/src/state/amm_state.rs):
    //   disc(8) + market(32 @8) + q_yes/q_no/b/seed_q_yes/seed_q_no (16 each @40..120)
    //   + fee_b_base_wad(16 @120) + trial_end_at(i64 @136)
    //   + is_graduated(u8 @144) + is_dismissed(u8 @145) + bump(u8 @146)
    //
    // Mutate byte 144 → 1.
    const ammStatePda = deriveAmmStatePda(newMarketId);
    const ammInfoBefore = await conn.getAccountInfo(ammStatePda);
    expect(ammInfoBefore).not.toBeNull();
    const mutated = Buffer.from(ammInfoBefore!.data);
    mutated.writeUInt8(1, 144); // is_graduated = true
    await surfnetSetAccount(ammStatePda, ammInfoBefore!, mutated);
    const ammPost = await fetchAmmState(conn, ammStatePda);
    expect(ammPost?.isGraduated).toBe(true);

    // ── Phase 3: bind sooth_book to the freshly-created market ────────────
    //
    // The helper supports `existingSoothMarket` so we skip its fresh-market
    // create_market call and run only the sooth_book per-market init
    // (create_market on the book program + initialize_market_outcome × 2
    // + open_market). The escrow YES/NO ATAs are also seeded.
    const newMarketSetup: FreshMarketSetup = {
      marketId: newMarketId,
      marketPda: newMarketPda,
      ammStatePda,
      lpMint: deriveLpMintPda(newMarketId),
      creatorLpAta: getAssociatedTokenAddressSync(
        deriveLpMintPda(newMarketId),
        creator.publicKey,
      ),
    };
    const ob = await createSeededOrderbookMarketViaAdapter({
      conn,
      creator,
      usdcMint,
      existingSoothMarket: newMarketSetup,
    });
    expect(ob.soothMarketPda.toBase58()).toBe(newMarketPda.toBase58());

    // The new market's bookMarketPda must exist on-chain — proves phase 3
    // wired correctly against a dynamic market (not the seed-localnet
    // fixture).
    const newBookInfo = await conn.getAccountInfo(ob.bookMarketPda);
    expect(newBookInfo).not.toBeNull();

    // ── Phase 4: orderbook page mounts + adapter-direct order placement ───
    //
    // Navigate to the dynamic market's orderbook URL and assert the
    // SoothBookTerminal mounts (the submit button is the canonical proof
    // that gate B — `isMarketRegistered` — resolved against the freshly-
    // initialised bookMarketPda). This proves the chain-shim's
    // `dispatchAmmRead("isMarketRegistered")` path correctly recognises
    // a dynamic market on the URL.
    //
    // The on-chain order placement itself goes through the adapter-direct
    // sooth_book ix (mirrors spec 19) because the chain-shim's orderbook
    // *write* path derives bookMarketPda from `ctx.marketRef`
    // (= `import.meta.env.VITE_DEMO_MARKET_REF`, the fixture market).
    // Routing UI submits to the dynamic market would require restarting
    // Vite with a different env, which the brief explicitly forbids.
    // Spec 20 covers UI-form-click against the fixture; this spec proves
    // the lifecycle integration end-to-end against a fresh market.
    const programs = makePrograms(conn, purchaser);
    const queueBefore =
      await programs.book.account.marketOrderRequestQueue.fetch(
        ob.orderRequestQueue,
      );
    const lenBefore = Number((queueBefore as any).orderRequests.len);

    await page.goto(`/orderbook/${ob.bookMarketPda.toBase58()}`);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(async () => {
      const w = window as unknown as {
        _connectTestWallet?: () => Promise<void>;
      };
      if (!w._connectTestWallet) {
        throw new Error(
          "_connectTestWallet not exposed — TestWalletBridge not mounted",
        );
      }
      await w._connectTestWallet();
    });

    // Assert SoothBookTerminal mounts. The submit button being visible is
    // the canonical signal that:
    //   1. `isMarketRegistered` returned true for the dynamic bookMarketPda
    //   2. SoothBookTerminal cleared its gated fallback (no
    //      "Market not yet on SoothBook" copy)
    //   3. The wallet adapter wired through and the form rendered.
    const submitBtn = page.getByTestId("ob-submit-button");
    await expect(submitBtn).toBeVisible({ timeout: 30_000 });

    // Place the order adapter-direct on the dynamic market's queue. Mirrors
    // spec 19 — same accounts, same args. We use a fresh distinctSeed so the
    // reservedOrderPda is unique per call (multiple spec runs against the
    // same Surfpool ledger).
    const distinctSeed = Array.from(randomBytes(16));
    const [reservedOrderPda] = PublicKey.findProgramAddressSync(
      [
        ob.bookMarketPda.toBuffer(),
        purchaser.publicKey.toBuffer(),
        Buffer.from(distinctSeed),
      ],
      programs.book.programId,
    );
    const [marketPosition] = PublicKey.findProgramAddressSync(
      [purchaser.publicKey.toBuffer(), ob.bookMarketPda.toBuffer()],
      programs.book.programId,
    );

    // createMarketPosition is the per-(user, bookMarket) account that holds
    // running totals + outstanding-order pointers. Idempotent against an
    // already-created position via Anchor's init-if-needed shape only when
    // the ix says so; this one isn't, so we attempt + swallow `already in
    // use` if a previous spec run already initialised it.
    try {
      await programs.book.methods
        .createMarketPosition()
        .accounts({
          marketPosition,
          market: ob.bookMarketPda,
          purchaser: purchaser.publicKey,
          payer: purchaser.publicKey,
        } as any)
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ])
        .rpc();
    } catch (e) {
      // Re-throw unless the failure is a benign "already initialised" race.
      const msg = String((e as Error).message ?? "");
      if (!/already in use|0x0/i.test(msg)) {
        throw e;
      }
    }

    const PRICE_WAD_TICK = 10n ** 15n; // W4 default ladder step
    const PRICE_YES = 400n * PRICE_WAD_TICK; // 0.40·WAD
    const STAKE = 100n * 1_000_000n; // 100 USDC (6-decimal SPL)

    const sig = await programs.book.methods
      .createOrderRequest({
        marketOutcomeIndex: 0, // YES
        forOutcome: true,
        stake: bn(STAKE),
        price: bn(PRICE_YES),
        distinctSeed,
        expiresOn: null,
      } as any)
      .accounts({
        reservedOrder: reservedOrderPda,
        orderRequestQueue: ob.orderRequestQueue,
        marketPosition,
        payer: purchaser.publicKey,
        purchaser: purchaser.publicKey,
        purchaserToken: getAssociatedTokenAddressSync(
          usdcMint,
          purchaser.publicKey,
        ),
        market: ob.bookMarketPda,
        marketOutcome: ob.outcomeYesPda,
        priceLadder: ob.priceLadderPda,
        marketEscrow: ob.escrowAuthority,
      } as any)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc();
    expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{40,}$/);

    // ── Phase 5: on-chain verification — OrderRequestQueue grew ───────────
    const finalLen = await new Promise<number>((resolve, reject) => {
      const deadline = Date.now() + 60_000;
      const tick = async () => {
        try {
          const q = await programs.book.account.marketOrderRequestQueue.fetch(
            ob.orderRequestQueue,
          );
          const n = Number((q as any).orderRequests.len);
          if (n > lenBefore) return resolve(n);
        } catch {
          // queue may briefly fail to fetch during slot transitions; retry
        }
        if (Date.now() > deadline) {
          return reject(
            new Error(
              `OrderRequestQueue did not grow within 60s (still ${lenBefore})`,
            ),
          );
        }
        setTimeout(tick, 500);
      };
      tick();
    });
    expect(finalLen).toBeGreaterThan(lenBefore);

    // UI health invariant — page surface must not contradict on-chain
    // state. Catches receipt-status / chain-shim regressions.
    await expect(
      page.locator("text=/Transaction reverted on-chain/i"),
    ).toHaveCount(0);
    await expect(page.locator("text=/Application error/i")).toHaveCount(0);

    // Suppress unused-import warnings on adapters left in the helpers we
    // reference but don't directly call here. Anchor's tree-shake is strict
    // and TOKEN_PROGRAM_ID / ASSOCIATED_TOKEN_PROGRAM_ID are pulled in by
    // the helper's escrow-ATA branch — keep the symbols referenced so type
    // checkers don't strip them on tighter configs.
    void TOKEN_PROGRAM_ID;
    void ASSOCIATED_TOKEN_PROGRAM_ID;
  });
});
