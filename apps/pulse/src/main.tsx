// Pulse — Solana-native Sooth frontend. The provider stack is the whole
// infrastructure: wallet-adapter, react-query, the SDK adapter. Nothing else.
import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

import "./index.css";
import { RPC_URL } from "./config";
import { AdapterProvider } from "./hooks/useAdapter";
import { ConnectButton } from "./components/ConnectButton";
import { Feed } from "./pages/Feed";
import { Market } from "./pages/Market";
import { Portfolio } from "./pages/Portfolio";
import { Launch } from "./pages/Launch";

const queryClient = new QueryClient();

function Shell({ children }: { children: React.ReactNode }) {
  const nav = [
    ["/", "Markets"],
    ["/me", "Portfolio"],
    ["/launch", "Launch"],
  ] as const;
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <Link to="/" className="font-mono text-sm font-bold tracking-widest text-ink">
            PULSE<span className="text-accent">·</span>
          </Link>
          <nav className="flex gap-4">
            {nav.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `font-mono text-xs uppercase tracking-wider ${isActive ? "text-ink" : "text-faint hover:text-dim"}`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <ConnectButton />
          </div>
        </div>
      </header>
      {children}
      <footer className="mx-auto max-w-5xl border-t border-line px-4 py-6 font-mono text-[10px] text-faint">
        pulse · sooth on solana · no approvals, no escrow, one signature per action
      </footer>
    </div>
  );
}

function App() {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <QueryClientProvider client={queryClient}>
            <AdapterProvider>
              <BrowserRouter>
                <Shell>
                  <Routes>
                    <Route path="/" element={<Feed />} />
                    <Route path="/m/:pda" element={<Market />} />
                    <Route path="/me" element={<Portfolio />} />
                    <Route path="/launch" element={<Launch />} />
                  </Routes>
                </Shell>
              </BrowserRouter>
            </AdapterProvider>
          </QueryClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
