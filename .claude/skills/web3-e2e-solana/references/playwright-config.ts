// Reference Playwright config for Solana e2e.
//
// Drop into apps/<your-dapp>/playwright.config.ts. Adjust webServer.command
// and use.baseURL to match your dev server port.
//
// Key choices:
//   - workers: 1 — serial execution avoids same-blockhash double-submit
//     errors when multiple specs sign tx within a few hundred ms of each
//     other.
//   - timeout: 120s per spec — Solana confirmation is fast (1-2s) but
//     RPC throttling, BlockhashNotFound retries, and indexer lag can push
//     a single spec past 60s. 120s gives headroom.
//   - reuseExistingServer: true — convenient for local dev when you've
//     already started `pnpm dev` separately. Set false in CI to ensure
//     a clean server.

import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5175";
const VITE_TEST_KEYPAIR_BYTES = process.env.VITE_TEST_KEYPAIR_BYTES;

if (!VITE_TEST_KEYPAIR_BYTES) {
  throw new Error(
    "VITE_TEST_KEYPAIR_BYTES env var required. Generate via `solana-keygen new -o /tmp/test-kp.json --no-bip39-passphrase --silent` and `export VITE_TEST_KEYPAIR_BYTES=$(cat /tmp/test-kp.json)`",
  );
}

export default defineConfig({
  projects: [
    {
      name: "smoke",
      testDir: "./e2e/smoke",
      use: { headless: true, baseURL: BASE_URL },
    },
    {
      name: "onchain-specs",
      testDir: "./e2e/onchain",
      use: { headless: true, baseURL: BASE_URL },
    },
  ],
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  webServer: {
    command: `VITE_TEST_MODE=true VITE_TEST_KEYPAIR_BYTES='${VITE_TEST_KEYPAIR_BYTES}' pnpm dev`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
