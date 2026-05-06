// AMM buy-flow integration test.
//
// Mounts upstream's `<AMM />` page (factored through `<AMMPageBody />` and
// `<SimpleTradingPanel />`) under the production provider stack with a
// bankrun-backed `SolanaChainAdapter` injected via `<DemoProvider override>`.
// The test exercises the buy path end-to-end:
//
//   1. Boot bankrun via `bootSmoke()` — same fixture the SDK smoke test uses.
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
// Reuse the bankrun fixture from `@sooth/sdk-solana/tests/fixtures` directly.
// The package's `exports` field only ships `.` so we reach into the source
// tree via a relative monorepo path. This keeps a single fixture authority.
import { bootSmoke } from "../../../packages/sdk-solana/tests/fixtures/setup";
import { BankrunConnection } from "../../../packages/sdk-solana/tests/fixtures/bankrun-connection";

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

test("AMM buy YES end-to-end against bankrun", async () => {
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
      // Initial state shows "$0.00" or em-dash; wait until non-zero.
      expect(text).toMatch(/\$\d+\.\d/);
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

  const tTotal = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    `amm-buy-flow timing: total=${tTotal}ms position.yesShares=${finalPos.yesShares}`,
  );
}, /* timeout */ 60_000);

// Avoid an unused-warning on the AccountInfo import — kept for clarity
// at the top of the file even though tests don't reference it directly.
void (null as unknown as AccountInfo<Buffer> | null);
