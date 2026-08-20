import { defineConfig, loadEnv } from "vite";
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

export default defineConfig(({ command, mode }) => {
  // Refuse to bake secrets into a production bundle. Vite inlines every
  // VITE_-prefixed var it loads — including from .env.local, which
  // process.env never sees — so the gate must read the same resolved env
  // the build will bake. VITE_TEST_KEYPAIR_BYTES and
  // VITE_TEST_AUTHORITY_BYTES are secret keys for funded devnet wallets;
  // a bundle containing them publishes those wallets. Build with the vars
  // overridden empty in the shell (shell env wins over .env files):
  //   VITE_TEST_MODE=false VITE_TEST_KEYPAIR_BYTES= VITE_TEST_AUTHORITY_BYTES= pnpm build
  // VITE_TEST_MINT_AUTHORITY_BYTES is deliberately NOT gated: it is the
  // faucet's mint key for the valueless devnet mock token, and minting
  // freely is the faucet's entire purpose.
  if (command === "build") {
    const env = loadEnv(mode, __dirname, "VITE_");
    const resolved = { ...env, ...process.env };
    if (resolved.VITE_TEST_MODE === "true") {
      throw new Error(
        "Refusing to build with VITE_TEST_MODE=true. The LocalKeypairAdapter must NEVER ship in a production bundle.",
      );
    }
    for (const k of ["VITE_TEST_KEYPAIR_BYTES", "VITE_TEST_AUTHORITY_BYTES"]) {
      if (resolved[k]) {
        throw new Error(
          `Refusing to build with ${k} set — it is a wallet secret key and would be baked into the public bundle. Override it empty: ${k}= pnpm build`,
        );
      }
    }
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
