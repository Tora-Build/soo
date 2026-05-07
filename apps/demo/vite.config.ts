import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vite + React + Tailwind. The Solana wallet-adapter expects `process.env`
// and a few Node globals (Buffer, process) to be polyfilled in the browser.
// `src/lib/polyfills.ts` shims what's needed at runtime; main.tsx imports
// it first thing.
//
// `@` path alias matches upstream's import style — `@/lib/chain-shim`
// resolves to `src/lib/chain-shim`. The chain-shim is the ONE place EVM
// hook signatures touch the Solana adapter.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => {
  // Refuse to build with VITE_TEST_MODE=true. The LocalKeypairAdapter signs
  // with a Keypair from VITE_TEST_KEYPAIR_BYTES — under no circumstances
  // should it ship in a production bundle. Dev (`vite`) is fine; only
  // `vite build` is gated.
  if (command === "build" && process.env.VITE_TEST_MODE === "true") {
    throw new Error(
      "Refusing to build with VITE_TEST_MODE=true. The LocalKeypairAdapter must NEVER ship in a production bundle.",
    );
  }
  return {
    plugins: [react()],
    resolve: {
      alias: {
        buffer: "buffer/",
        "@": path.resolve(__dirname, "./src"),
      },
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV ?? "development",
      ),
      global: "globalThis",
    },
    optimizeDeps: {
      include: ["buffer"],
    },
    server: {
      // Proxy parity with upstream — these proxies forward to Polymarket /
      // Kalshi APIs for the data-feed dropdowns. Harmless if unused.
      proxy: {
        "/api/polymarket": {
          target: "https://gamma-api.polymarket.com",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/polymarket/, ""),
          secure: true,
        },
        "/api/kalshi": {
          target: "https://api.elections.kalshi.com",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/kalshi/, ""),
          secure: true,
        },
      },
      port: 5175,
      strictPort: true,
    },
  };
});
