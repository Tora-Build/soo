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
import { Faucet } from "./pages/Faucet";

const queryClient = new QueryClient();

function Shell({ children }: { children: React.ReactNode }) {
  const nav = [
    ["/", "Markets"],
    ["/me", "Positions"],
    ["/launch", "Launch"],
    ["/faucet", "Faucet"],
  ] as const;
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="sticky top-0 z-10 border-b border-rule bg-canvas/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] w-full max-w-[1200px] items-center justify-between gap-4 px-4 md:px-7">
          <div className="flex min-w-0 items-center gap-7">
            <Link to="/" className="group flex items-center gap-3">
              <img
                src="/eastboard-icon.svg"
                alt=""
                aria-hidden="true"
                className="h-9 w-9 transition-transform group-active:scale-[0.98]"
              />
              <span className="font-mono text-sm font-bold uppercase tracking-[0.2em] text-ink">
                East<span className="text-accent">·</span>Solana
              </span>
            </Link>
            <nav className="hidden gap-5 sm:flex">
              {nav.map(([to, label]) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) =>
                    `font-mono text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors ${
                      isActive ? "text-ink" : "text-faint hover:text-muted"
                    }`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
          <ConnectButton />
        </div>
      </header>
      <div className="border-b border-rule bg-warn-soft px-4 py-2 text-center font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-warn">
        No-value research prototype — one axis: buy YES or buy NO, nothing else
      </div>
      {children}
      <nav className="flex justify-around border-t border-rule py-2 sm:hidden">
        {nav.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `font-mono text-[10px] uppercase tracking-widest ${isActive ? "text-ink" : "text-faint"}`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <footer className="mx-auto flex w-full max-w-[1200px] flex-col gap-2 border-t border-rule px-4 py-7 font-mono text-[10px] uppercase tracking-[0.12em] text-faint md:flex-row md:items-center md:justify-between md:px-7">
        <span>East / Sooth Protocol on Solana</span>
        <span>no approvals · no escrow · one signature per action</span>
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
                    <Route path="/faucet" element={<Faucet />} />
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
