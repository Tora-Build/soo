// Playwright config for the on-chain e2e suite.
//
// Drives the demo via vite (test mode) against a real solana-test-validator
// (or devnet, with caveats). Spec assumes the validator is already running
// with the 4 program .so binaries deployed and the demo's protocol
// singletons + a market initialised — see e2e/onchain/README in the spec
// header for the boot sequence.
//
// Key choices:
//   - workers: 1 — serial avoids same-blockhash double-submit races.
//   - timeout: 120s/spec — Solana confirm is fast (1-2s), but BlockhashNotFound
//     retries + indexer lag can push past 60s.
//   - reuseExistingServer: true — convenient when the operator has the dev
//     server already running (test-mode vite). CI should set false.
//   - port 5176 (not 5175) so the e2e doesn't fight a local dev server.

import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5176);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const VITE_TEST_KEYPAIR_BYTES = process.env.VITE_TEST_KEYPAIR_BYTES;

if (!VITE_TEST_KEYPAIR_BYTES) {
  throw new Error(
    "VITE_TEST_KEYPAIR_BYTES env var required. Generate via `solana-keygen new -o /tmp/sooth-test-kp.json --no-bip39-passphrase --silent` and `export VITE_TEST_KEYPAIR_BYTES=$(cat /tmp/sooth-test-kp.json)`",
  );
}

export default defineConfig({
  testDir: "./e2e/onchain",
  globalSetup: "./e2e/helpers/global-setup.ts",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    headless: true,
    baseURL: BASE_URL,
  },
  webServer: {
    command: `VITE_TEST_MODE=true VITE_TEST_KEYPAIR_BYTES='${VITE_TEST_KEYPAIR_BYTES}' node node_modules/vite/bin/vite.js --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
