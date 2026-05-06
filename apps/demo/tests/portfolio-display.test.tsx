// Portfolio display integration test.
//
// Mounts upstream's `<Portfolio />` page under the production provider stack
// with a bankrun-backed `SolanaChainAdapter` injected via `<DemoProvider
// override>`. After seeding a market and executing a buy via the adapter,
// the portfolio bridge should:
//
//   1. Surface the seeded market through `LaunchpadEngine.getMarkets()` →
//      `useOnChainMarkets` → `useLaunchpadMarkets` → `useActivePositions`.
//   2. Resolve `AMMEngine.getPosition(market, user)` to the on-chain Position
//      PDA via the AMM bridge.
//   3. Render an active-position row with YES shares matching the trade.
//
// Constraints:
// - The chain-shim only knows about the markets injected via
//   `DemoProvider.override.marketRef` — so the test seeds a single market
//   and the rendered Portfolio shows exactly one row.
// - We don't exercise the buy path through React in this test; the AMM page
//   already covers that. Instead we drive `adapter.buildTrade` /
//   `adapter.submit` directly and then assert the Portfolio reflects the
//   resulting Position PDA.

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
  // happy-dom shims (matchMedia / ResizeObserver) — same as amm-buy-flow.
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

test("Portfolio renders the user's AMM position from bankrun", async () => {
  const t0 = Date.now();
  const smoke = await bootSmoke({
    bWad: 1_000n * WAD,
    userUsdcBaseUnits: 100_000_000n, // 100 USDC
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

  // ─── Seed the position before mounting ───────────────────────────────────
  // Drive the adapter directly to produce a Position PDA worth 10 YES shares.
  // The Portfolio page should pick this up through the bridge.
  const buyShares = 10n * WAD;
  const buyReq = await adapter.buildTrade(marketRef, {
    side: "buy",
    outcome: 1,
    deltaShares: buyShares,
    maxCostWad: 100n * WAD,
    // @ts-expect-error — Solana-only meta channel; see adapter.ts.
    user: userRef,
  });
  await adapter.submit(buyReq, signer);

  // Sanity: position is on-chain before we mount React.
  const seeded = await adapter.readPosition(marketRef, userRef);
  expect(seeded.yesShares).toBe(buyShares);

  // Lazy-imports after polyfills so module-init code (i18n) sees them.
  const { Portfolio } = await import("../src/pages/Portfolio");
  const { DemoProvider } = await import("../src/lib/DemoContext");

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });

  render(
    <MemoryRouter initialEntries={["/portfolio"]}>
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
                <Route path="/portfolio" element={<Portfolio />} />
              </Routes>
            </DemoProvider>
          </QueryClientProvider>
        </WalletProvider>
      </ConnectionProvider>
    </MemoryRouter>,
  );

  // The Portfolio page renders YES shares as `walletYes.toFixed(4)` — for
  // a 10·WAD position that's exactly "10.0000". Wait for the row to mount.
  await waitFor(
    () => {
      const matches = screen.getAllByText("10.0000");
      // At least one match — the YES shares cell. (NO shares is "0.0000".)
      expect(matches.length).toBeGreaterThan(0);
    },
    { timeout: 20_000 },
  );

  // Belt-and-braces: NO shares should render as "0.0000".
  expect(screen.getAllByText("0.0000").length).toBeGreaterThan(0);

  // The "Total Shares" line is unique to a populated position row — its
  // absence would indicate the empty-state branch (which renders a
  // "Browse markets to start trading" link instead). Match on the "Total
  // Shares: 10.0000" prefix, ignoring i18n-key dependent surroundings.
  expect(screen.getByText(/Total Shares: 10\.0000/)).toBeTruthy();
  // YES Price: 50.0% — derived from balanced (qYes=10·WAD, qNo=0) book.
  // Buying 10 YES from a balanced book moves the yes-price above 50%; we
  // assert the price string format is present (allowing any value).
  expect(screen.getByText(/YES Price: \d+\.\d+%/)).toBeTruthy();

  const tTotal = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`portfolio-display timing: total=${tTotal}ms`);
}, /* timeout */ 60_000);
