// Top-level router. Two real routes (market list + buy flow) and a Stub
// catch-all per the fork's "fail gracefully on unimplemented surface" rule.

import { Routes, Route, Navigate, Link } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { MarketList } from "./pages/MarketList";
import { MarketDetail } from "./pages/MarketDetail";
import { Stub } from "./pages/Stub";
import { WalletButton } from "./components/WalletButton";
import { RpcStatus } from "./components/RpcStatus";

export function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between gap-3">
        <Link
          to="/"
          className="font-mono text-sm text-slate-100"
          data-testid="brand"
        >
          sooth · solana demo
        </Link>
        <div className="flex items-center gap-3">
          <RpcStatus />
          <WalletButton />
        </div>
      </header>
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<MarketList />} />
          <Route path="/m/:marketId" element={<MarketDetail />} />
          <Route
            path="/portfolio"
            element={
              <Stub
                feature="Portfolio"
                reason="readPortfolio is NotImplemented in @sooth/sdk-solana"
              />
            }
          />
          <Route
            path="/orderbook"
            element={
              <Stub
                feature="Orderbook"
                reason="buildOrderbook* are NotImplemented in @sooth/sdk-solana"
              />
            }
          />
          <Route
            path="/launchpad"
            element={
              <Stub
                feature="Launchpad / Create Market"
                reason="buildCreateMarket is NotImplemented in @sooth/sdk-solana"
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}
