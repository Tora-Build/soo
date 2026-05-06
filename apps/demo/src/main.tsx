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

  // `autoConnect` is intentionally OFF. Silent autoConnect failures (e.g.
  // wallet on the wrong network, or the dapp loaded before the extension
  // injected) are the most common cause of "the connect button does
  // nothing." Requiring an explicit click keeps the failure path visible
  // and ties any error to the wallet-adapter modal where the user can act.
  return (
    <ConnectionProvider endpoint={demoConfig.node.rpcUrl}>
      <WalletProvider wallets={wallets} autoConnect={false}>
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
