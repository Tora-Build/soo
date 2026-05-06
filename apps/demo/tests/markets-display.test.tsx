// Markets-list display integration test.
//
// Mounts upstream's `<Markets />` page under the production provider stack
// with a bankrun-backed `SolanaChainAdapter` injected via `<DemoProvider
// override>`. Once the portfolio-bridge surfaces the seeded market through
// `LaunchpadEngine.getMarkets()`, the page should:
//
//   1. Exit the "No markets found" empty state and render exactly one card.
//   2. Show non-zero liquidity (sourced from `AmmState.b` via the amm-bridge
//      `markets()` synthesis).
//   3. Show a YES probability percentage rendered by the embedded
//      `<PriceBar>` (from `useAmmMarketDirect.amm.yesProbability` →
//      `getMarketState` → amm-bridge).
//
// Constraints:
// - The chain-shim only knows about the markets injected via
//   `DemoProvider.override.marketRef` — so the test seeds a single market
//   and the rendered Markets page contains exactly one row.
// - The supporting hooks (`useGraduationRing`, `useAmmMarketDirect`) read
//   through the chain-shim dispatch chain that the markets-bridge plugs
//   into. No upstream hook code is mocked.

import { afterEach, beforeAll, expect, test } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { Transaction, type Connection } from "@solana/web3.js";

import {
  SolanaChainAdapter,
  encodePubkeyRef,
  WAD,
  type SignerRef,
} from "@sooth/sdk-solana";
import { bootSmoke } from "../../../packages/sdk-solana/tests/fixtures/setup";
import { BankrunConnection } from "../../../packages/sdk-solana/tests/fixtures/bankrun-connection";

beforeAll(() => {
  // happy-dom shims (matchMedia / ResizeObserver) — same as the other
  // upstream-page integration tests.
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

test("Markets page renders the seeded market with bridged metadata", async () => {
  const t0 = Date.now();
  // bWad chosen to make the rendered "$<liquidity>" cell visibly non-zero
  // (1000 → "$1000" after `formatUnits(b, 18) → toFixed(0)`).
  const smoke = await bootSmoke({
    bWad: 1_000n * WAD,
    userUsdcBaseUnits: 100_000_000n,
  });

  const conn = new BankrunConnection(smoke.ctx);
  const adapter = new SolanaChainAdapter({
    node: {
      id: "demo-bankrun",
      chainKind: "solana",
      chainId: "test",
      rpcUrl: "http://localhost:8899",
    },
    programIds: smoke.programs,
    usdcMint: smoke.usdcMint,
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

  // Seed one buy so qYes > 0 and the price bar moves off the 50/50 anchor.
  const buyShares = 5n * WAD;
  const buyReq = await adapter.buildTrade(marketRef, {
    side: "buy",
    outcome: 1,
    deltaShares: buyShares,
    maxCostWad: 100n * WAD,
    // @ts-expect-error — Solana-only meta channel; see adapter.ts.
    user: userRef,
  });
  await adapter.submit(buyReq, signer);

  const { Markets } = await import("../src/pages/Markets");
  const { DemoProvider } = await import("../src/lib/DemoContext");
  // The Markets page calls `useQuickTrade()` (via the cards' click-to-trade
  // shortcut). In production, `main.tsx` wraps the entire `<Routes>` tree
  // in `<QuickTradeProvider>` — mirror that wrapping here so the hook
  // resolves the context. Bringing it in lazily so module-init code (i18n,
  // upstream hooks) sees the polyfills installed in `beforeAll`.
  const { QuickTradeProvider } =
    await import("../src/components/features/market/QuickTradeProvider");

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });

  render(
    <MemoryRouter initialEntries={["/markets"]}>
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
              <QuickTradeProvider>
                <Routes>
                  <Route path="/markets" element={<Markets />} />
                </Routes>
              </QuickTradeProvider>
            </DemoProvider>
          </QueryClientProvider>
        </WalletProvider>
      </ConnectionProvider>
    </MemoryRouter>,
  );

  // Wait for the empty-state to clear (the "No markets found" headline goes
  // away when `useOnChainMarkets` returns the bridged single-market list).
  await waitFor(
    () => {
      expect(screen.queryByText(/No markets found/i)).toBeNull();
    },
    { timeout: 20_000 },
  );

  // Liquidity cell is `${liquidity.toFixed(0)}` against `b = 1000·WAD`,
  // i.e. "$1000". Wait for the bridged value to land.
  await waitFor(
    () => {
      // Surface ≥1 cell whose text matches the bridged liquidity. The
      // string appears under <Zap …/>${liquidity.toFixed(0)} in MarketCard.
      expect(screen.getAllByText(/\$1000/).length).toBeGreaterThan(0);
    },
    { timeout: 20_000 },
  );

  // YES price comes from `useAmmMarketDirect.amm.yesProbability`. With
  // qYes = 5·WAD, qNo = 0, b = 1000·WAD the probability nudges above 50%
  // — the PriceBar renders it as `(yesPrice * 100).toFixed(0)%`. Match
  // any 2-3 digit percent so we don't pin to a specific LMSR rounding.
  await waitFor(
    () => {
      const probs = screen.getAllByText(/^\d{1,3}%$/);
      expect(probs.length).toBeGreaterThan(0);
    },
    { timeout: 20_000 },
  );

  const tTotal = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`markets-display timing: total=${tTotal}ms`);
}, /* timeout */ 60_000);
