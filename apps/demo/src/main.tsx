// React root for the Solana fork. Hybrid of upstream's main.tsx and the
// Solana wallet-adapter wiring:
//
//   - Same React-Query / React-Router / Toaster providers and route table
//   - Wagmi/AppKit providers replaced with @solana/wallet-adapter-react's
//     <ConnectionProvider> + <WalletProvider> + <WalletModalProvider>
//   - `autoConnect` is required — despite the name, in
//     @solana/wallet-adapter-react v0.15.x it gates the modal's
//     select-then-connect flow, not just silent reconnect on reload
//     (anza-xyz/wallet-adapter#307). With autoConnect={false} every
//     modal wallet click stores the choice but never calls
//     adapter.connect() — the user sees no popup and the modal silently
//     closes.
//   - `wallets={[]}` in production: Phantom/Solflare/Backpack/MetaMask/
//     Magic Eden register via Wallet Standard and are auto-discovered
//     by `useStandardWalletAdapters`. Including legacy adapter classes
//     here causes the warning "X was registered as a Standard Wallet —
//     can be removed from your app".
//
// Polyfills first — wallet-adapter-base touches Buffer at module-init.

import "./lib/polyfills";

import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

import "./lib/i18n";
import { DemoProvider } from "./lib/DemoContext";
import { demoConfig } from "./lib/config";
import { LocalKeypairAdapter, TestWalletBridge } from "./lib/testWalletAdapter";

// Test mode swaps the Phantom/Solflare adapters for a single LocalKeypair
// adapter that signs with VITE_TEST_KEYPAIR_BYTES. The bridge exposes
// window._connectTestWallet for Playwright. Production builds tree-shake
// the adapter (vite.config.ts also throws on `build` with VITE_TEST_MODE
// for defense in depth).
const IS_TEST_MODE =
  ((import.meta as unknown as { env?: Record<string, string> }).env ?? {})
    .VITE_TEST_MODE === "true";

// Pages — copied verbatim from upstream.
import { AppLayout } from "./layouts/AppLayout";
import { Faucet } from "./pages/Faucet";
import { AMM } from "./pages/AMM";
import { Launchpad } from "./pages/Launchpad";
import { Orderbook } from "./pages/Orderbook";
import { Portfolio } from "./pages/Portfolio";
import { Operator } from "./pages/Operator";
import { Learn } from "./pages/Learn";
import { Markets } from "./pages/Markets";
import { Liquidity } from "./pages/Liquidity";
import { LPForecast } from "./pages/LPForecast";
import { Geek } from "./pages/Geek";
import HealthCheckPage from "./pages/HealthCheckPage";
import { QuickTradeProvider } from "./components/features/market/QuickTradeProvider";

import "./index.css";

const queryClient = new QueryClient();

function Root() {
  const wallets = useMemo(
    () => (IS_TEST_MODE ? [new LocalKeypairAdapter()] : []),
    [],
  );

  return (
    // StrictMode is intentionally INSIDE the wallet providers, not wrapping
    // them. Wrapping ConnectionProvider/WalletProvider in StrictMode causes
    // double-mount cleanup to call adapter.disconnect() between the two
    // mount cycles, which leaves StandardWalletAdapter._connected = false
    // even though useWallet().publicKey is still populated. The next
    // wallet.signTransaction() then throws "not connected"
    // (anza-xyz/wallet-adapter#686).
    <ConnectionProvider endpoint={demoConfig.node.rpcUrl}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {IS_TEST_MODE && <TestWalletBridge />}
          <QueryClientProvider client={queryClient}>
            <DemoProvider>
              <BrowserRouter>
                <QuickTradeProvider>
                  <React.StrictMode>
                    <Toaster
                      position="bottom-right"
                      toastOptions={{
                        style: {
                          background: "#0f172a",
                          color: "#e2e8f0",
                          border: "1px solid #1e293b",
                          fontFamily: "JetBrains Mono, monospace",
                        },
                      }}
                    />
                    <Routes>
                      <Route
                        path="/"
                        element={<Navigate to="/markets" replace />}
                      />
                      <Route path="/__check" element={<HealthCheckPage />} />
                      <Route element={<AppLayout />}>
                        <Route path="/learn" element={<Learn />} />
                        <Route path="/amm" element={<AMM />} />
                        <Route path="/amm/:marketAddress" element={<AMM />} />
                        <Route path="/orderbook" element={<Orderbook />} />
                        <Route
                          path="/orderbook/:marketAddress"
                          element={<Orderbook />}
                        />
                        <Route path="/create" element={<Launchpad />} />
                        <Route path="/launchpad" element={<Launchpad />} />
                        <Route path="/portfolio" element={<Portfolio />} />
                        <Route path="/operator" element={<Operator />} />
                        <Route path="/faucet" element={<Faucet />} />
                        <Route path="/markets" element={<Markets />} />
                        <Route path="/liquidity" element={<Liquidity />} />
                        <Route path="/lp-forecast" element={<LPForecast />} />
                        <Route path="/geek" element={<Geek />} />
                        <Route
                          path="*"
                          element={<Navigate to="/markets" replace />}
                        />
                      </Route>
                    </Routes>
                  </React.StrictMode>
                </QuickTradeProvider>
              </BrowserRouter>
            </DemoProvider>
          </QueryClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Root />);
