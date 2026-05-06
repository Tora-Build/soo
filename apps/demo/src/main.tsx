// React root for the Solana-only demo. Wires up wallet-adapter providers
// (Phantom + Solflare), the DemoProvider, and the router.
//
// Important: import polyfills FIRST. @solana/web3.js + wallet-adapter rely
// on `Buffer` / `process` being defined as globals (Node-isms that leak
// through). vite doesn't shim these by default.

import "./lib/polyfills";

import { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";

// Wallet-adapter UI styles. Imported once at the root.
import "@solana/wallet-adapter-react-ui/styles.css";

import { App } from "./App";
import { DemoProvider } from "./lib/DemoContext";
import { demoConfig } from "./lib/config";
import "./index.css";

function Root() {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={demoConfig.node.rpcUrl}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <DemoProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </DemoProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Root />);
