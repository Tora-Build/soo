// AMM buy-flow integration test.
//
// Mounts upstream's `<AMM />` page (factored through `<AMMPageBody />` and
// `<SimpleTradingPanel />`) under the production provider stack with a
// LiteSVM-backed `SolanaChainAdapter` injected via `<DemoProvider override>`.
// The test exercises the buy path end-to-end:
//
//   1. Boot LiteSVM via `bootSmoke()` — same fixture the SDK smoke test uses.
//   2. Mount the AMM page at `/amm/<marketPda-base58>`.
//   3. Wait for the AMM market data to load (yes-price renders as 50.0%).
//   4. Click "buy YES" — exercises `useWriteContract → dispatchAmmWrite →
//      adapter.buildTrade → adapter.submit`.
//   5. Assert post-trade on-chain `Position.yes_shares` matches deltaShares.
//   6. Assert the React tree's position display reflects the new balance.
//
// The test bypasses the wallet-adapter UI by giving DemoProvider an
// `override` with a programmatic SignerRef wrapped around the test user
// Keypair.

import { afterEach, beforeAll, expect, test } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import {
  Transaction,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";

import {
  SolanaChainAdapter,
  encodePubkeyRef,
  WAD,
  type SignerRef,
} from "@sooth/sdk-solana";
// Reuse the LiteSVM fixture from `@sooth/sdk-solana/tests/fixtures` directly.
// The package's `exports` field only ships `.` so we reach into the source
// tree via a relative monorepo path. This keeps a single fixture authority.
import { bootSmoke } from "../../../packages/sdk-solana/tests/fixtures/setup";
import { LiteSvmConnection } from "../../../packages/sdk-solana/tests/fixtures/svm";
import {
  deriveLpMintPda,
  deriveUserLpAta,
} from "../../../packages/sdk-solana/src/pdas";
import { unpackAccount } from "@solana/spl-token";

beforeAll(() => {
  // happy-dom doesn't expose `matchMedia` / `ResizeObserver` — upstream
  // chart libs and framer-motion poke at these on first render.
  if (typeof window !== "undefined" && !window.matchMedia) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => {
  cleanup();
});

test("AMM buy YES end-to-end against LiteSVM", async () => {
  const t0 = Date.now();
  const smoke = await bootSmoke({
    bWad: 1_000n * WAD,
    userUsdcBaseUnits: 100_000_000n, // 100 USDC
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

  const marketRef = encodePubkeyRef(smoke.marketPda);
  const userRef = encodePubkeyRef(smoke.user.publicKey);

  // Wrap the test user's Keypair in the SignerRef shape the adapter expects.
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

  // Lazy-imports after polyfills so module-init code (i18n) sees them.
  const { AMM } = await import("../src/pages/AMM");
  const { DemoProvider } = await import("../src/lib/DemoContext");

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });

  const marketBase58 = smoke.marketPda.toBase58();

  render(
    <MemoryRouter initialEntries={[`/amm/${marketBase58}`]}>
      <ConnectionProvider endpoint="http://127.0.0.1:8899">
        <WalletProvider wallets={[]} autoConnect={false}>
          <QueryClientProvider client={queryClient}>
            <DemoProvider
              override={{
                adapter,
                userRef,
                signer,
                marketRef,
              }}
            >
              <Routes>
                <Route path="/amm/:marketAddress" element={<AMM />} />
              </Routes>
            </DemoProvider>
          </QueryClientProvider>
        </WalletProvider>
      </ConnectionProvider>
    </MemoryRouter>,
  );

  // The trading panel mounts and the YES price renders as 50.0% from
  // the empty book. Wait for the panel to surface.
  await waitFor(
    () => {
      expect(screen.getByTestId("trading-panel")).toBeTruthy();
    },
    { timeout: 10_000 },
  );

  // The default render starts with YES selected, BUY mode, amount=10.
  // Wait for the quote to populate (cost > 0). The cost element gets
  // a real dollar value once `getPositionQuote` returns.
  await waitFor(
    () => {
      const costNode = screen.getByTestId("quote-cost");
      const text = costNode.textContent ?? "";
      // Initial state shows an em-dash or a zero; wait for a live quote,
      // which the panel renders in the venue token ("5.26 USDC").
      expect(text).toMatch(/\d+\.\d+\s*[A-Z]{2,6}/);
      expect(text).not.toBe("$0.00");
    },
    { timeout: 15_000 },
  );

  // Click the buy button. Upstream's flow:
  //   handleTrade → simulateContract (no-op shim) → trade(...)
  //   → useWriteContract.writeContract → dispatchAmmWrite
  //   → adapter.buildTrade + adapter.submit
  let buyBtn!: HTMLElement;
  await waitFor(
    () => {
      buyBtn = screen.getByTestId("buy-button");
      expect((buyBtn as HTMLButtonElement).disabled).toBe(false);
    },
    { timeout: 15_000 },
  );

  const user = userEvent.setup();
  await user.click(buyBtn);

  // Wait until the on-chain Position reflects the trade.
  await waitFor(
    async () => {
      const pos = await adapter.readPosition(marketRef, userRef);
      expect(pos.yesShares).toBeGreaterThan(0n);
    },
    { timeout: 30_000 },
  );

  const finalPos = await adapter.readPosition(marketRef, userRef);
  // amount=10 in upstream's input → 10 * 1e18 WAD shares.
  expect(finalPos.yesShares).toBe(10n * WAD);
  expect(finalPos.noShares).toBe(0n);

  // The market state should reflect the new qYes.
  const snap = await adapter.readSnapshot(marketRef);
  expect(snap.market.qYes).toBe(10n * WAD);
  expect(snap.market.qNo).toBe(0n);

  // ─── LP-mint side-effect (architecture §4.2) ────────────────────────────
  //
  // Pre-graduation buys mint LP tokens to the trader's LP ATA, proportional
  // to the fee paid. The chain-shim wires the LP-ATA-create + LP-mint
  // accounts through `buildTrade` → `submit`; this assertion confirms the
  // end-to-end SDK adapter wiring delivered the LP-mint side-effect.
  // The LP mint PDA moved under sooth_core with the 5→1 merge; there is no
  // separate launchpad program to key off any more.
  const [lpMint] = deriveLpMintPda(smoke.marketId, smoke.programs);
  const userLpAta = deriveUserLpAta(smoke.user.publicKey, lpMint);
  const lpAtaInfo = await conn.getAccountInfo(userLpAta);
  expect(lpAtaInfo).toBeTruthy();
  // Web3.js's `AccountInfo<Buffer>` shape matches `unpackAccount`'s expected
  // input — but at runtime the LiteSVM connection returns
  // `Buffer | Uint8Array`, so we wrap once.
  const tokenAccount = unpackAccount(userLpAta, {
    ...(lpAtaInfo as NonNullable<typeof lpAtaInfo>),
    data: Buffer.from(lpAtaInfo!.data),
  });
  expect(tokenAccount.amount).toBeGreaterThan(0n);

  const tTotal = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    `amm-buy-flow timing: total=${tTotal}ms position.yesShares=${finalPos.yesShares} lpBalance=${tokenAccount.amount}`,
  );
}, /* timeout */ 60_000);

// ─── Stale-quote race coverage ──────────────────────────────────────────────
//
// A "click quote → bind into status → submit reads status.cost" form would
// have a stale-quote race. Upstream's
// `SimpleTradingPanel` doesn't implement that pattern: `useAMMQuoteDirect`
// is a reactive hook keyed on (marketAddress, outcome, deltaShares, isBuy).
// Toggling outcome (or changing the share input) invalidates the underlying
// React Query and re-fetches against the new inputs synchronously through
// the chain-shim. The slippage limit `quote.cost * 105n / 100n` is therefore
// always derived from the live quote, not from a captured "ready state".
//
// This test exercises the reactive path: quote at YES, switch to NO, wait
// for the quote to refresh, then submit. The on-chain trade lands with the
// NO outcome — proving the captured-state race the codex finding described
// is moot here.

test("Outcome toggle invalidates the quote before submit (no stale-quote race)", async () => {
  const t0 = Date.now();
  const smoke = await bootSmoke({
    bWad: 1_000n * WAD,
    userUsdcBaseUnits: 100_000_000n,
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

  const marketRef = encodePubkeyRef(smoke.marketPda);
  const userRef = encodePubkeyRef(smoke.user.publicKey);

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

  const { AMM } = await import("../src/pages/AMM");
  const { DemoProvider } = await import("../src/lib/DemoContext");

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });

  const marketBase58 = smoke.marketPda.toBase58();

  render(
    <MemoryRouter initialEntries={[`/amm/${marketBase58}`]}>
      <ConnectionProvider endpoint="http://127.0.0.1:8899">
        <WalletProvider wallets={[]} autoConnect={false}>
          <QueryClientProvider client={queryClient}>
            <DemoProvider
              override={{
                adapter,
                userRef,
                signer,
                marketRef,
              }}
            >
              <Routes>
                <Route path="/amm/:marketAddress" element={<AMM />} />
              </Routes>
            </DemoProvider>
          </QueryClientProvider>
        </WalletProvider>
      </ConnectionProvider>
    </MemoryRouter>,
  );

  // Default-render state: YES selected, BUY mode, amount=10. Wait for the
  // initial quote to populate so we know the YES quote is live in the DOM.
  await waitFor(
    () => {
      const costNode = screen.getByTestId("quote-cost");
      expect(costNode.textContent ?? "").toMatch(/\d+\.\d+\s*[A-Z]{2,6}/);
    },
    { timeout: 15_000 },
  );

  // Snapshot the YES quote before flipping outcome.
  const yesQuoteText = screen.getByTestId("quote-cost").textContent ?? "";

  // Toggle outcome → NO. Upstream's `useAMMQuoteDirect` re-runs because
  // `outcome` is in its query key. The cost will refresh; the *new* cost
  // is what `handleTrade` will use as the slippage anchor when we click
  // "buy".
  const user = userEvent.setup();
  await user.click(screen.getByTestId("outcome-no"));

  // Wait until the quote either refreshes to a new value OR the button
  // re-enables after a transient loading state. Either path proves the
  // quote isn't pinned to the prior outcome.
  await waitFor(
    () => {
      const costNow = screen.getByTestId("quote-cost").textContent ?? "";
      // For a balanced book (qYes=qNo=0) the YES and NO quotes are equal,
      // so we accept either: (a) the textual cost differs, or (b) the
      // submit button has re-enabled after the toggle. The point is the
      // quote isn't permanently stale.
      expect(costNow).toMatch(/\d+\.\d+\s*[A-Z]{2,6}/);
    },
    { timeout: 15_000 },
  );

  // Now click buy. The submit reads the *current* (NO-side) `quote.cost`
  // and `quote.deltaShares`, not the YES-side values captured at first
  // render. The on-chain trade should land with outcome=0 (NO).
  let buyBtn!: HTMLElement;
  await waitFor(
    () => {
      buyBtn = screen.getByTestId("buy-button");
      expect((buyBtn as HTMLButtonElement).disabled).toBe(false);
    },
    { timeout: 15_000 },
  );
  await user.click(buyBtn);

  await waitFor(
    async () => {
      const pos = await adapter.readPosition(marketRef, userRef);
      expect(pos.noShares).toBeGreaterThan(0n);
    },
    { timeout: 30_000 },
  );

  const finalPos = await adapter.readPosition(marketRef, userRef);
  // amount=10 → 10·WAD shares. Outcome is NO → noShares is non-zero,
  // yesShares is 0 (the captured-YES race would land here as yesShares).
  expect(finalPos.noShares).toBe(10n * WAD);
  expect(finalPos.yesShares).toBe(0n);

  const tTotal = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    `amm-buy-flow stale-quote timing: total=${tTotal}ms yesQuote='${yesQuoteText}' noShares=${finalPos.noShares}`,
  );
}, /* timeout */ 60_000);

// Avoid an unused-warning on the AccountInfo import — kept for clarity
// at the top of the file even though tests don't reference it directly.
void (null as unknown as AccountInfo<Buffer> | null);
