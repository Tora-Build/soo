// React root for the Solana fork. Hybrid of upstream's main.tsx and the
// Solana wallet-adapter wiring:
//
//   - Same React-Query / React-Router / Toaster providers and route table
//   - Wagmi/AppKit providers replaced with @solana/wallet-adapter-react's
//     <ConnectionProvider> + <WalletProvider> + <WalletModalProvider>
//   - autoConnect={false} on purpose — silent autoConnect failures hide
//     the connect error UX. Explicit click → wallet-adapter modal → error
//     visible on the modal.
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
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

import "./lib/i18n";
import { DemoProvider } from "./lib/DemoContext";
import { demoConfig } from "./lib/config";

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
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <React.StrictMode>
      <ConnectionProvider endpoint={demoConfig.node.rpcUrl}>
        <WalletProvider wallets={wallets} autoConnect={false}>
          <WalletModalProvider>
            <QueryClientProvider client={queryClient}>
              <DemoProvider>
                <BrowserRouter>
                  <QuickTradeProvider>
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
                  </QuickTradeProvider>
                </BrowserRouter>
              </DemoProvider>
            </QueryClientProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </React.StrictMode>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Root />);
