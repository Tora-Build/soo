// Reference: Vite + main.tsx test-mode toggle for the LocalKeypairAdapter.
//
// Two pieces:
//   1. vite.config.ts — refuse to build with VITE_TEST_MODE=true (security
//      guard). Production must never bundle the test adapter.
//   2. main.tsx — swap the wallets array based on VITE_TEST_MODE.

// ────────────────────────────────────────────────────────────────────────
// vite.config.ts (excerpt)
// ────────────────────────────────────────────────────────────────────────

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  if (command === "build" && process.env.VITE_TEST_MODE === "true") {
    throw new Error(
      "Refusing to build with VITE_TEST_MODE=true. The LocalKeypairAdapter must NEVER ship in a production bundle.",
    );
  }
  return {
    plugins: [react()],
    server: { port: 5175, strictPort: true },
    define: {
      // Make the env var available to the test adapter at runtime
      "import.meta.env.VITE_TEST_MODE": JSON.stringify(
        process.env.VITE_TEST_MODE ?? "false",
      ),
    },
  };
});

// ────────────────────────────────────────────────────────────────────────
// main.tsx (excerpt — wallets array swap + TestWalletBridge mount)
// ────────────────────────────────────────────────────────────────────────

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";

// Static import is fine — Vite's tree-shaker drops the LocalKeypairAdapter
// from production bundles when VITE_TEST_MODE !== "true" (the conditional
// `new` call is dead code under the production define).
import {
  LocalKeypairAdapter,
  TestWalletBridge,
} from "./lib/testWalletAdapter";

const IS_TEST_MODE = import.meta.env.VITE_TEST_MODE === "true";

export function Root() {
  const wallets = useMemo(() => {
    if (IS_TEST_MODE) {
      return [new LocalKeypairAdapter()];
    }
    return [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
  }, []);

  return (
    <ConnectionProvider endpoint={import.meta.env.VITE_SOLANA_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          {/* In test mode, mount the bridge so window._connectTestWallet
              is available to Playwright. The bridge no-ops in production. */}
          {IS_TEST_MODE && <TestWalletBridge />}
          {/* ... rest of the app ... */}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
