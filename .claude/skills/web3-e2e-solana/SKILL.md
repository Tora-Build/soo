---
name: solana-web3-e2e
description: Write and run real E2E tests for Solana dApps using Playwright + on-chain verification via @solana/web3.js. Bypasses Phantom/Solflare with a local-keypair WalletAdapter that signs real transactions. Tests verify both UI state and on-chain account state changes. Use this skill when building E2E tests for any Solana dApp.
---

# Solana Web3 E2E Testing

Real end-to-end testing for Solana dApps: UI action → on-chain tx → on-chain state verification → UI reflects change.

This is the Solana counterpart to the EVM `web3-e2e` skill. The architectural shape is identical; the wallet plumbing, error model, and verification primitives are different.

## When to Use

- Testing wallet-dependent flows (buy, sell, mint complete set, redeem, settle, attest, dispute)
- Verifying on-chain account state changes match UI
- QA rounds that need to catch real bugs (not just "page doesn't crash")
- Any dApp flow that calls `sendTransaction` / `signTransaction`

## Core Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Playwright  │────▶│  Vite Dev    │────▶│ Solana RPC  │
│  (headless)  │     │  (test mode) │     │ (devnet/    │
└─────────────┘     └──────────────┘     │  test-      │
       │                    │            │  validator) │
       │           wallet-adapter        └─────────────┘
       │            ┌──────────────┐             ▲
       └───────────▶│ LocalKeypair │─────────────┘
                    │   Adapter    │  signs with
                    │  (Keypair    │  TEST_KEYPAIR
                    │   from env)  │  (64-byte JSON)
                    └──────────────┘

┌──────────────────┐
│ @solana/web3.js  │──── reads on-chain account state independently
│ Connection       │     before/after UI actions
└──────────────────┘
```

## Why NOT Phantom / Solflare via UI automation

Phantom's browser extension popup opens in a separate Chromium window with its own service-worker isolation. Playwright can interact with extension popups in theory, but:

- The extension page lifecycle is unpredictable across versions (4× breaking changes in 2024)
- Chrome MV3 service worker hibernation kills mid-test signing flows non-deterministically
- The unlock flow needs persistent localStorage across runs; CI runners reset it
- The wallet-adapter modal has its own state machine that races the Playwright `click()`

The `LocalKeypairAdapter` bypasses all this — it's a real `BaseSignerWalletAdapter` that signs with a Keypair, identically to how a real wallet would, but with no popup.

## Setup

### 1. Local-Keypair Wallet Adapter

Create a custom adapter that signs with a Keypair from env:

```typescript
// src/lib/testWalletAdapter.ts
import {
  BaseSignerWalletAdapter,
  WalletReadyState,
  type SupportedTransactionVersions,
  type TransactionOrVersionedTransaction,
} from "@solana/wallet-adapter-base";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

function resolveTestKeypair(): Keypair {
  const json = import.meta.env.VITE_TEST_KEYPAIR_BYTES;
  if (!json) throw new Error("VITE_TEST_KEYPAIR_BYTES not set");
  const bytes = JSON.parse(json) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error("VITE_TEST_KEYPAIR_BYTES must be 64-byte JSON array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

const LOCAL_NAME = "Local Keypair";

export class LocalKeypairAdapter extends BaseSignerWalletAdapter {
  name = LOCAL_NAME;
  url = "https://example.com/local-keypair";
  icon =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
  supportedTransactionVersions: SupportedTransactionVersions = new Set([
    "legacy",
    0,
  ]);
  readyState = WalletReadyState.Installed;

  private _keypair: Keypair;
  private _connecting = false;
  private _publicKey: PublicKey | null = null;

  constructor(keypair?: Keypair) {
    super();
    this._keypair = keypair ?? resolveTestKeypair();
  }

  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return this._connecting;
  }
  get connected() {
    return this._publicKey !== null;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this._connecting = true;
    try {
      this._publicKey = this._keypair.publicKey;
      this.emit("connect", this._publicKey);
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this._publicKey = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends TransactionOrVersionedTransaction>(
    tx: T,
  ): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this._keypair]);
    } else {
      (tx as Transaction).partialSign(this._keypair);
    }
    return tx;
  }

  async signAllTransactions<T extends TransactionOrVersionedTransaction>(
    txs: T[],
  ): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, this._keypair.secretKey);
  }
}
```

### 2. Test Mode Toggle

In `main.tsx`, swap the wallets array when `VITE_TEST_MODE=true`:

```typescript
import { useMemo } from "react";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";

function Root() {
  const wallets = useMemo(() => {
    if (import.meta.env.VITE_TEST_MODE === "true") {
      // Dynamic import keeps test code out of production bundle
      const { LocalKeypairAdapter } = require("./lib/testWalletAdapter");
      return [new LocalKeypairAdapter()];
    }
    return [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
  }, []);

  return (
    <ConnectionProvider endpoint={demoConfig.node.rpcUrl}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {/* ... */}
      </WalletProvider>
    </ConnectionProvider>
  );
}
```

If you use ESM-only `import` (Vite default), the dynamic-import variant:

```ts
const wallets = useMemo(() => {
  if (import.meta.env.VITE_TEST_MODE === "true") {
    // Top-level static import is fine because vite tree-shakes it out of
    // production builds when VITE_TEST_MODE !== "true" via the define plugin.
    return [new LocalKeypairAdapter()];
  }
  return [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
}, []);
```

**CRITICAL SECURITY:**

- NEVER hardcode a Keypair in source. Use `VITE_TEST_KEYPAIR_BYTES` env var (64-byte JSON array, in `.env.local`, gitignored).
- Generate via `solana-keygen new -o /tmp/throwaway.json` then `cat /tmp/throwaway.json` and paste as `VITE_TEST_KEYPAIR_BYTES='[1,2,3,...]'`.
- Add a build-time guard in `vite.config.ts`:

```typescript
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => {
  if (command === "build" && process.env.VITE_TEST_MODE === "true") {
    throw new Error("Refusing to build with VITE_TEST_MODE=true");
  }
  return {
    /* ... */
  };
});
```

### 3. Expose Connect Function on `window`

The `wallet-adapter-react` modal is React-internal; the test process needs a programmatic way to connect:

```typescript
// src/lib/testWalletAdapter.ts (continued)
import type { WalletContextState } from "@solana/wallet-adapter-react";

let walletCtxRef: WalletContextState | null = null;

export function registerTestWalletContext(ctx: WalletContextState) {
  walletCtxRef = ctx;
  if (
    typeof window !== "undefined" &&
    import.meta.env.VITE_TEST_MODE === "true"
  ) {
    (window as unknown as Record<string, unknown>)._connectTestWallet =
      async () => {
        if (!walletCtxRef) throw new Error("Wallet context not registered");
        if (walletCtxRef.connected) return;
        walletCtxRef.select(LOCAL_NAME);
        await walletCtxRef.connect();
      };
  }
}
```

Mount the registration once near the wallet provider (e.g., a `<TestWalletBridge />` component that calls `useWallet()` and `registerTestWalletContext()` in a `useEffect`):

```typescript
// src/lib/testWalletAdapter.ts (continued)
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect } from "react";

export function TestWalletBridge() {
  const wallet = useWallet();
  useEffect(() => {
    if (import.meta.env.VITE_TEST_MODE !== "true") return;
    registerTestWalletContext(wallet);
  }, [wallet]);
  return null;
}
```

```tsx
// main.tsx
<WalletProvider wallets={wallets} autoConnect={false}>
  <WalletModalProvider>
    {import.meta.env.VITE_TEST_MODE === "true" && <TestWalletBridge />}
    {/* ... */}
  </WalletModalProvider>
</WalletProvider>
```

### 4. On-Chain Helpers — use `@solana/web3.js` directly

`@solana/web3.js`'s `Connection` is the equivalent of viem's `PublicClient`. It's reliable, typed, and has none of the shell-out issues that the EVM `cast` CLI has.

```typescript
// e2e/helpers/onchain.ts
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

export function makeConnection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

export async function getUsdcBalance(
  conn: Connection,
  owner: PublicKey,
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
  try {
    const acc = await getAccount(conn, ata);
    return acc.amount;
  } catch {
    return 0n;
  }
}

export async function getAccountData(
  conn: Connection,
  pubkey: PublicKey,
): Promise<Buffer | null> {
  const info = await conn.getAccountInfo(pubkey);
  return info?.data ?? null;
}

/**
 * Read a u64 little-endian field from an Anchor account at a known offset.
 * Use this when you don't want to load the full Anchor IDL into the test
 * environment — for invariants like Position.yes_shares it's enough.
 */
export function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

export function readI128LE(buf: Buffer, offset: number): bigint {
  // Two-step read because Buffer doesn't have BigInt 128-bit reads
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

/**
 * Polls a read function until the condition is true or timeout.
 * Use this after a UI action — Solana confirmation is fast (1-2s typical
 * on devnet, sub-second on local) but the dapp's optimistic UI may lag.
 */
export async function waitForOnChainChange<T>(
  read: () => Promise<T>,
  condition: (v: T) => boolean,
  timeoutMs = 30_000,
  pollMs = 1000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await read();
    if (condition(value)) return value;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForOnChainChange timed out after ${timeoutMs}ms`);
}

/** Pre-condition setup: airdrop SOL to a wallet (devnet only). */
export async function airdrop(
  conn: Connection,
  pubkey: PublicKey,
  sol: number,
) {
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

/** Pre-condition setup: mint USDC to the test wallet. */
export async function mintUsdc(
  conn: Connection,
  mintAuthority: Keypair,
  recipient: PublicKey,
  amount: bigint,
) {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, recipient);
  const ataInfo = await conn.getAccountInfo(ata);
  const tx = new Transaction();
  if (!ataInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        mintAuthority.publicKey,
        ata,
        recipient,
        USDC_MINT,
      ),
    );
  }
  tx.add(
    createMintToInstruction(USDC_MINT, ata, mintAuthority.publicKey, amount),
  );
  await sendAndConfirmTransaction(conn, tx, [mintAuthority]);
}
```

## Writing Tests

### Real E2E Pattern (the only pattern that catches real bugs)

```typescript
import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import {
  makeConnection,
  getUsdcBalance,
  getAccountData,
  readU64LE,
  waitForOnChainChange,
} from "../helpers/onchain";

const TEST_PUBKEY = new PublicKey(process.env.TEST_PUBKEY!);
const SOOTH_AMM_ID = new PublicKey(process.env.SOOTH_AMM_ID!);
const MARKET_ID_BYTES = Buffer.from(process.env.MARKET_ID_HEX!, "hex");
const POSITION_YES_SHARES_OFFSET = 72;

function derivePositionPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pos"), MARKET_ID_BYTES, TEST_PUBKEY.toBuffer()],
    SOOTH_AMM_ID,
  );
  return pda;
}

test("buy YES shares: on-chain Position increases", async ({ page }) => {
  test.setTimeout(120_000);
  const conn = makeConnection();
  const positionPda = derivePositionPda();

  // 1. Read on-chain state BEFORE
  const dataBefore = await getAccountData(conn, positionPda);
  const yesBefore = dataBefore
    ? readU64LE(dataBefore, POSITION_YES_SHARES_OFFSET)
    : 0n;
  const usdcBefore = await getUsdcBalance(conn, TEST_PUBKEY);

  // 2. Navigate + connect wallet
  await page.goto(`${BASE_URL}/amm/${MARKET_ADDRESS}`);
  await page.waitForTimeout(1000);
  await page.evaluate(() =>
    (
      window as unknown as { _connectTestWallet: () => Promise<void> }
    )._connectTestWallet(),
  );
  await page.waitForTimeout(2000);

  // 3. Interact with UI
  await page.getByTestId("shares-input").fill("10");
  await page.getByRole("button", { name: /^buy$/i }).click();

  // 4. Wait for on-chain state change
  const yesAfter = await waitForOnChainChange(
    async () => {
      const data = await getAccountData(conn, positionPda);
      return data ? readU64LE(data, POSITION_YES_SHARES_OFFSET) : 0n;
    },
    (v) => v > yesBefore,
    60_000,
    1500,
  );

  // 5. Assert exact delta (10 shares = 10 * 10^18 in WAD)
  expect(yesAfter - yesBefore).toBe(10n * 10n ** 18n);

  // 6. Verify USDC was debited
  const usdcAfter = await getUsdcBalance(conn, TEST_PUBKEY);
  expect(usdcAfter).toBeLessThan(usdcBefore);

  // 7. Verify UI reflects the change
  await page.waitForTimeout(3000);
  const uiText = await page.getByTestId("position-display").textContent();
  expect(uiText).toContain("10");
});
```

### Key Rules

1. **Always read on-chain state BEFORE the UI action** — compare deltas, not absolutes.
2. **Use `waitForOnChainChange` with a condition** — don't use fixed sleep. Solana confirmation is fast but variable.
3. **Assert exact deltas** — `posAfter - posBefore === expected`, not just "increased".
4. **Test wallet must have funds** — SOL for tx fees + USDC (or other SPL token) for trades.
5. **Use `test.setTimeout(120_000)`** — Solana txs land in 1-15s but RPC throttling can stretch this.
6. **PDA seeds matter** — derive expected PDAs in the test, don't hardcode addresses (program-id rotation breaks hardcoded values).
7. **EVERY user-facing action MUST go through the UI** — same rule as the EVM skill. Pre-condition setup (airdrop, mint USDC) goes through `Connection` directly; the action under test goes through Playwright clicks.
8. **Use `Connection` with commitment level `"confirmed"` or `"finalized"`** — `processed` shows uncommitted state and gives flaky assertions.

### Smoke Tests vs Real E2E

|                       | Smoke (`*.spec.ts`) | Real E2E (`*-e2e.spec.ts`)      |
| --------------------- | ------------------- | ------------------------------- |
| Clicks buttons        | Yes                 | Yes                             |
| Asserts page renders  | Yes                 | Yes                             |
| Sends real tx         | Maybe (swallowed)   | Yes (signed + confirmed)        |
| Checks on-chain state | No                  | Yes (Connection.getAccountInfo) |
| Catches real bugs     | Rarely              | Always                          |

## Debugging

When a test times out at `waitForOnChainChange`:

1. **Add browser console logging:**

```typescript
page.on("console", (msg) => console.log(`[browser]`, msg.text()));
```

2. **Capture the last submitted tx hash from the browser:**

```typescript
await page.addInitScript(() => {
  const origFetch = window.fetch;
  (window as any).__lastSig = null;
  window.fetch = async (...args) => {
    const body = typeof args[1]?.body === "string" ? args[1].body : "";
    if (body.includes("sendTransaction")) {
      const res = await origFetch(...args);
      const clone = res.clone();
      try {
        const json = await clone.json();
        if (json.result) (window as any).__lastSig = json.result;
      } catch {}
      return res;
    }
    return origFetch(...args);
  };
});
```

After a click that should send a tx:

```typescript
await page.waitForTimeout(2000);
const sig = await page.evaluate(() => (window as any).__lastSig);
if (sig) {
  const status = await conn.getSignatureStatus(sig);
  console.log("Tx", sig, "status:", status?.value);
}
```

3. **Decode Anchor errors:**

Anchor errors come back as `{ Custom: <code> }` in `confirmTransaction` results. Map to the IDL:

```typescript
import idl from "../../packages/sdk-solana/src/anchor/sooth_amm.json";

function decodeAnchorError(code: number): string {
  const err = (idl as any).errors?.find(
    (e: { code: number }) => e.code === code,
  );
  return err ? `${err.name}: ${err.msg}` : `Unknown error code ${code}`;
}
```

4. **Common silent failures:**

- `wallet.connect()` succeeds but `wallet.publicKey` is null → adapter race; await a microtask
- Tx never sent → caller didn't `await` the wallet's `signTransaction` properly
- "BlockhashNotFound" on retry → blockhash from prior attempt expired; the SDK should refetch (the `submit()` retry loop in `@sooth/sdk-solana` does this)
- "Custom program error: 0xN" → look up `N` in the IDL's `errors` array
- Computed-budget exhausted → some Anchor programs need >200k CU; prepend `ComputeBudgetInstruction::set_compute_unit_limit(400_000)` to the tx

## Playwright Config

```typescript
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  projects: [
    {
      name: "onchain-specs",
      testDir: "./e2e/specs",
      use: { headless: true, baseURL: "http://localhost:5173" },
    },
  ],
  workers: 1, // serial — avoid duplicate-tx races on the same blockhash
  timeout: 120_000,
  webServer: {
    command:
      "VITE_TEST_MODE=true VITE_TEST_KEYPAIR_BYTES=$VITE_TEST_KEYPAIR_BYTES pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
```

## Running

```bash
# Generate a throwaway test keypair
solana-keygen new -o /tmp/test-kp.json --no-bip39-passphrase --silent

# Export as a 64-byte JSON array env var (vite reads this at build/dev time)
export VITE_TEST_KEYPAIR_BYTES=$(cat /tmp/test-kp.json)
export TEST_PUBKEY=$(solana-keygen pubkey /tmp/test-kp.json)

# Pre-fund the test wallet (devnet only)
solana airdrop 2 $TEST_PUBKEY --url devnet

# Mint USDC if the dapp needs it (against your local USDC mint or a faucet)
# ... (see e2e/helpers/preconditions.ts)

# Terminal 1: dev server in test mode
VITE_TEST_MODE=true VITE_TEST_KEYPAIR_BYTES="$VITE_TEST_KEYPAIR_BYTES" pnpm dev

# Terminal 2: run e2e specs
TEST_PUBKEY=$TEST_PUBKEY \
SOLANA_RPC_URL=https://api.devnet.solana.com \
npx playwright test e2e/specs/*-e2e.spec.ts --project=onchain-specs --workers=1
```

## End-of-Run Report (REQUIRED)

Same rule as the EVM skill: **E2E output is for the product owner, not the dev.** After every E2E run produce a structured report.

```markdown
## E2E Run Report — <branch> — <cluster> — <YYYY-MM-DD HH:MM>

### Summary

- Total specs: N (passed M, failed K, skipped S)
- Duration: <mm:ss>
- Commit: <short SHA>
- Cluster: <devnet|testnet|localnet|mainnet-beta>
- RPC: <endpoint>
- Dev server: <url>
- Test wallet: <pubkey> (<why this wallet>)
- Programs (resolved IDs): sooth_amm=<id>, sooth_market=<id>, ...

### Pass / Fail Table

| #   | Spec           | Status  | On-chain delta verified?  | Notes                                    |
| --- | -------------- | ------- | ------------------------- | ---------------------------------------- |
| 1   | buy-e2e (AMM)  | ✅ pass | +10·WAD YES, USDC -5.0125 | —                                        |
| 2   | sell-e2e (AMM) | ❌ fail | —                         | UI never submitted tx; see Failures §1   |
| 3   | redeem-e2e     | ⚠️ skip | —                         | market not settled (precondition missed) |

### Failures

1. **sell-e2e (AMM)** — Sell button disabled after 5s wait
   - Market PDA: `aPkM…aJyx`
   - UI state: `trading-panel` visible, `sell-button` aria-disabled=true
   - Browser console tail: `[wagmi-shim] useReadContract: getPosition returned 0n`
   - Network: no `sendTransaction` RPC call observed
   - On-chain Position before: yesShares=0, noShares=0
   - Likely cause: spec didn't pre-fund a YES position; sell has nothing to sell
   - Last known signature: —

### On-Chain State Changes Observed

- Wallet USDC: <before> → <after> (Δ <delta>)
- Position on <market PDA>: yesShares <before> → <after>, noShares <before> → <after>
- LockEntry PDAs created: <count>, addresses: [...]
- Markets created this run: <count>

### What This Means (plain English, 2-4 lines)

- Which user-facing flows are now proven to work end-to-end on <cluster>.
- Which are broken and what that blocks for a real user.
- Whether the environment (RPC, validator, indexer) contributed to failures.

### Recommended Next Action

- One sentence. Not a menu.
```

## Prerequisites

- A test Keypair (64-byte JSON array) — generate with `solana-keygen new`
- `VITE_TEST_KEYPAIR_BYTES` and `TEST_PUBKEY` in `.env` (gitignored)
- SOL on the test wallet for tx fees (devnet airdrop or pre-funded mainnet wallet for paid testing)
- Any other tokens (USDC, project-specific SPL) the dapp needs — fund via `mintUsdc()` helper if you control the mint authority, or fund manually
- `solana-cli` on PATH for `solana account` / `solana program show` / airdrops
- `@solana/web3.js` and `@solana/spl-token` in the test dev-deps (already a dep of any wallet-adapter app)
- Dev server running with `VITE_TEST_MODE=true` and `VITE_TEST_KEYPAIR_BYTES`

## Lessons Learned (Solana-specific)

- **Phantom MV3 is broken for E2E** — service worker hibernates mid-tx, popup race conditions. Use the LocalKeypairAdapter.
- **wallet-adapter's `mock` adapter exists but doesn't sign** — same as wagmi's `mock()`. You need a real Keypair.
- **`processed` commitment shows uncommitted state** — flaky assertions. Use `confirmed` minimum.
- **`recent_blockhash` expires in ~60s** — if the test takes too long between sign and submit, the tx fails with `BlockhashNotFound`. The SDK's submit retry loop should refetch; verify it does.
- **Anchor compute budget** — programs that do heavy math (LMSR, encryption) need >200k CU. The dapp should prepend `ComputeBudgetInstruction::set_compute_unit_limit(N)` if Anchor's auto-budget isn't enough.
- **Devnet airdrop is rate-limited** — typically 2 SOL per 24h per IP. Use a pre-funded test wallet for CI; only airdrop on first setup.
- **PDA seeds depend on program-id** — if you redeploy with a new program-id, every PDA address changes. Test code that hardcodes PDAs breaks. Always derive PDAs in-test from the program-id env var.
- **`getAccountInfo` returns `null` for uninitialized accounts** — handle this; don't crash on missing PDAs in the "before" reading.
- **BigInt precision** — Solana uses u64 / u128 / i128 in Anchor. Use BigInt throughout JS; never cast to Number for amounts.
- **Confirmation level vs visibility** — a tx is `confirmed` after ~1 slot (~400ms), `finalized` after 32 slots (~13s). For UI-displayed state, `confirmed` is what the dapp sees; for invariant checks (e.g. "this can't be rolled back"), use `finalized`.
- **Headless mode** — set `headless: true` so Chromium doesn't steal focus.
- **Don't run multiple specs in parallel against the same wallet** — they'll race on `recent_blockhash` and one will fail with already-processed-or-expired errors. `workers: 1` is the safe default.

## Hard-Won Patterns

### 1. WalletProvider's `select()` race

`wallet-adapter-react`'s `WalletContextState.select(walletName)` is sync (sets the active adapter) but `connect()` is async. If you call them in sequence too fast, `connect()` runs against the previous adapter (often `null`) and throws "no wallet selected".

Fix: `await new Promise((r) => setTimeout(r, 0))` between `select()` and `connect()`, OR use a `useEffect` to detect the wallet change before calling connect.

### 2. `autoConnect` race

If the WalletProvider has `autoConnect={true}` and the test wallet is the only adapter, autoConnect tries to call `connect()` before the LocalKeypairAdapter's `readyState` is set. Use `autoConnect={false}` and trigger explicitly.

### 3. The `signTransaction` shim must produce the exact tx the program expects

The dapp's chain-shim (or wagmi-shim if forked from an EVM dapp) constructs `TransactionInstruction` objects. Each must match the IDL exactly:

- Account order matters — Anchor's account-derive macro generates a specific order; the test must pass them in that order
- Instruction data starts with the 8-byte discriminator (sha256("global:<name>")[..8])
- Args are Borsh-serialized; numeric types must match (u64 vs u128 vs i128)

If the IDL is hand-edited (because `anchor idl build` is broken on your toolchain), the discriminators in the JSON might drift from sha256. Always recompute and assert in CI:

```typescript
// e2e/helpers/discriminators.ts
import { createHash } from "node:crypto";

export function expectedDiscriminator(method: string): Uint8Array {
  return createHash("sha256")
    .update(`global:${method}`)
    .digest()
    .subarray(0, 8);
}
```

### 4. `getAccountInfo` race vs UI state

When a tx confirms, Solana's commitment cascade is `processed → confirmed → finalized`. The dapp typically subscribes via WebSocket and updates UI on `confirmed`. Your `getAccountInfo({ commitment: "confirmed" })` will see the same state. But:

- If you read at `processed`, you might see uncommitted state that gets rolled back (rare on devnet but possible)
- If you read at `finalized`, you'll wait ~13s after the tx confirms — too slow for most assertions

Default to `confirmed` for E2E reads.

### 5. Indexer-fed UIs need indexer coverage gates

Same as the EVM skill: if the dapp reads market lists / leaderboards / order history from a Solana indexer (Triton, Helius, your own), the indexer can lag the chain. Test pre-conditions should verify the indexer has caught up, OR the test should bypass the indexer by reading the chain directly.

### 6. Diagnostic dumps when click does nothing

When the BUY button click doesn't move on-chain state:

1. **CTA text + disabled state** right before click — proves the button is the right one and is enabled.
2. **`window.__lastSig` after click** — was a tx fired at all?
3. **Toast contents** — error message? "Transaction confirmed"? Empty?
4. **Receipt status** — fetch `getSignatureStatus(__lastSig)`; check `.value.err` is null.
5. **Decode Anchor error** — if `.value.err.InstructionError = [n, { Custom: code }]`, map `code` against the IDL.
6. **Recent blockhash** — `getRecentBlockhash()` (or `getLatestBlockhash()`) before the click; compare to the tx's blockhash if available.

The pattern: rule out "button didn't fire" → "tx didn't send" → "tx reverted (Custom error)" → "tx succeeded but spec read wrong PDA" in that order.

### 7. ComputeBudgetInstruction is mandatory for heavy programs

Anchor 0.30+ doesn't auto-set CU budget. Programs that exceed 200k CU per instruction need an explicit `ComputeBudgetInstruction::set_compute_unit_limit(N)` prepended. If the dapp doesn't prepend it (oversight), the tx fails with `Computational budget exceeded`. The fix is in the dapp's tx-builder; the test should assert via the receipt that the failure mode isn't this if a budget error is observed.

### 8. Multi-leg flows: confirm each leg before the next

Patterns like create_market (4 init CPIs in one outer ix) bundle the legs atomically. But user-facing flows like sell→claim_unlocked are 2 separate user actions across a 24h window. The test for the second leg must skip if the first leg's effect (LockEntry) isn't on-chain yet. Use `getAccountInfo(lockEntryPda)` as a precondition gate.

### 9. Local-validator vs devnet for E2E

|                              | localnet (test-validator)        | devnet                       |
| ---------------------------- | -------------------------------- | ---------------------------- |
| Setup                        | one command, ephemeral state     | already running              |
| Speed                        | sub-second slot                  | 400ms slot                   |
| Reset                        | `--reset` per run                | impossible                   |
| Pre-deployed programs        | manually via `--bpf-program`     | reuse production-like state  |
| USDC mint                    | create your own                  | use canonical devnet mint    |
| Airdrop limits               | unlimited                        | 2 SOL/24h/IP                 |
| Indexer/registry coverage    | need to run/mock yours           | upstream's may already cover |
| Race conditions w/ blockhash | rare (you control the validator) | rare but real                |

For deterministic CI, prefer `solana-test-validator` with the production .so files preloaded. For acceptance testing against a real cluster, use devnet with a pre-funded wallet.

### 10. Pre-conditions are setup, not feature tests

Funding the wallet, creating an ATA, minting USDC, initializing the protocol singletons, seeding a market — none of these is the feature under test. Do them via `Connection` + `sendAndConfirmTransaction` directly (not the UI), and ensure they're idempotent so re-runs don't fail.

For the action being validated, the sequence is: Playwright clicks UI → wallet-adapter signs via LocalKeypairAdapter → web3.js sends the tx → spec observes the on-chain delta AND the UI reflecting it.

If you find yourself reaching for `sendAndConfirmTransaction(...)` in the test body for the feature under test, stop and drive the UI instead.

## Hard-Won Patterns (cont'd)

### 11. Full UI pass requirement — push every wired flow through the dapp

The default failure mode for "real e2e" is to write `*-via-adapter` helpers that build the on-chain ix from Node and call it that way. The helpers are useful for _pre-conditions_ (e.g. "buy 10 YES so the sell spec has a position to sell") but they **must not be the action under test** if the dapp has a UI surface for that action. Reasons:

- The chain-shim layer (wagmi-shim → SDK adapter → on-chain ix) is a real source of regressions; bypassing it makes the tests miss real bugs.
- Video evidence with adapter-direct specs shows nothing visual — just a Node test passing in <1s with no UI activity.
- The product owner watching the recording can't tell if the dapp actually works.

The audit pass: before declaring a suite "real e2e," walk every UI surface (every page, every panel, every CTA) and confirm each has a spec that **clicks the button on the page**. If a flow has no UI surface (e.g. slippage rejection where the panel hard-codes a 5% buffer), document why in the spec header.

For specs whose pre-conditions don't have a UI (e.g. `mint complete-set` needs YES+NO balances first), do the pre-conditions adapter-direct and the action under test through the page. Mixed is fine — adapter-direct-only is not.

### 12. Video evidence with title cards

Playwright records `video.webm` per spec when `use.video = "on"` is set, but only for specs that drive a `page` (UI specs). Adapter-direct specs produce a `trace.zip` (openable at https://trace.playwright.dev/) but no video.

For a single-file evidence artifact for a product-owner review:

```typescript
// Temporary playwright.config edit — revert after the run
use: {
  headless: true,
  baseURL: BASE_URL,
  video: "on",
  viewport: { width: 1280, height: 800 },
  trace: "on",
},
```

Then run, then concat the per-spec videos with title cards into one mp4. Homebrew `ffmpeg` is typically built **without** `--enable-libfreetype`, so `drawtext` is unavailable. Workaround: render title cards as PNGs via the already-installed Playwright Chromium, then concat:

```bash
# 1. Render N title PNGs via headless chromium (one tiny script)
node -e '
const { chromium } = require("…/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright");
const specs = [["00", "Spec 00", "Buy YES — UI", "..."], ...];
(async () => {
  const browser = await chromium.launch();
  for (const [num, head, sub, desc] of specs) {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    const html = `<!DOCTYPE html><html>...<style>…</style></head><body>
      <div class="h">${head}</div><div class="s">${sub}</div>
      <div class="d">${desc}</div><div class="p">✓ PASSED</div>
      </body></html>`;
    await page.setContent(html);
    await page.screenshot({ path: `apps/demo/test-results/title_${num}.png` });
    await page.close();
  }
  await browser.close();
})();
'

# 2. Title PNG → 2s mp4, video.webm → mp4 (matched format), then concat
for n in 00 01 02 …; do
  ffmpeg -y -loop 1 -framerate 25 -i "title_$n.png" -t 2 \
    -vf "scale=800:500,setsar=1" -c:v libx264 -preset fast -crf 23 \
    -pix_fmt yuv420p -r 25 "title_$n.mp4"
  ffmpeg -y -i "<spec-dir>/video.webm" \
    -vf "scale=800:500,setsar=1,fps=25" -c:v libx264 -preset fast -crf 23 \
    -pix_fmt yuv420p -r 25 "spec_$n.mp4"
done
{ for n in 00 01 02 …; do
    echo "file 'title_$n.mp4'"
    echo "file 'spec_$n.mp4'"
  done
} > _concat.txt
ffmpeg -y -f concat -safe 0 -i _concat.txt -c copy -movflags +faststart \
  e2e-ui-walkthrough.mp4
```

Watch out for **zsh array indexing** if you're scripting on macOS: zsh arrays are 1-indexed, bash 0-indexed. `for i in 0 1 2 …` with `${ARR[i]}` silently skips the last element in zsh. Use literal values (`for n in 00 01 02 …`) instead of indexed loops.

### 13. Wallet swap for operator/authority specs

Some panels render only when the connected wallet is a specific authority — e.g. `OperatorActionsPanel` renders only for `Adjudicator.authority`, which is the per-market creator at `register_adjudicator` time, not the default test user. To drive that panel via the UI, the test needs to swap the active LocalKeypair mid-session.

Extend the LocalKeypairAdapter with a `swapKeypair(kp)` method, expose a bridge fn that disconnects → swaps → reconnects:

```typescript
// On LocalKeypairAdapter:
swapKeypair(kp: Keypair): void {
  this._keypair = kp;
  this._publicKey = null;
}

// On the bridge module (adjacent to _connectTestWallet):
let activeAdapterRef: LocalKeypairAdapter | null = null;
// Set activeAdapterRef = this in the adapter constructor.

(window as any)._connectTestWalletAs = async (secretBytes: number[]) => {
  if (walletCtxRef.connected) await walletCtxRef.disconnect();
  activeAdapterRef!.swapKeypair(
    Keypair.fromSecretKey(Uint8Array.from(secretBytes)),
  );
  walletCtxRef.select(ADAPTER_NAME);
  for (let i = 0; i < 50; i++) {
    if (walletCtxRef.wallet) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await walletCtxRef.connect();
};
```

Specs that need creator authority do:

```typescript
const creatorBytes = JSON.parse(
  readFileSync(
    resolve(__dirname, "..", "..", ".localnet", "creator-keypair.json"),
    "utf8",
  ),
);
await page.evaluate(async (bytes) => {
  await (window as any)._connectTestWalletAs(bytes);
}, creatorBytes);
// ... drive the operator panel ...
// Cleanup: swap back to user wallet so downstream specs see the standard authority.
```

Remember: ESM specs lose `__dirname`. Add the standard recipe at the top of the file:

```typescript
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
```

### 14. Panels gating on time must read on-chain Clock, not `Date.now()`

When Surfpool's `surfnet_timeTravel` advances the on-chain Clock without moving wall-clock, any panel that gates a button on `now >= unlock_at` (or similar) using `Date.now()` will stay disabled even though the on-chain ix would succeed. Fix the panel to read SysvarC1ock's `unix_timestamp` (i64 @ offset 32 in the account data) instead:

```typescript
const refreshNow = useCallback(async () => {
  if (!adapter) return setNow(BigInt(Math.floor(Date.now() / 1000)));
  try {
    const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";
    const info = await adapter.connection.getAccountInfo(
      new PublicKey(SYSVAR_CLOCK),
    );
    if (info) return setNow(info.data.readBigInt64LE(32));
  } catch {}
  setNow(BigInt(Math.floor(Date.now() / 1000)));
}, [adapter]);
```

Production behavior is identical (the on-chain Clock is the source of truth for the on-chain `now >= unlock_at` check anyway); the panel just stops drifting.

### 15. Surfpool e2e gotchas

If your e2e suite needs `setClock` (post-deadline trades, 24h sell-lock claims, etc.), Surfpool is the only practical answer (`solana-test-validator` has no equivalent RPC). Several footguns:

- **`surfnet_setAccount`'s `data` field is a hex string, not a `[base64string, "base64"]` tuple.** The dump format `solana account --output json` produces (which test-validator's `--account` flag consumes) doesn't work for surfpool — translate inline:
  ```js
  const dataHex = Buffer.from(acc.data[0], acc.data[1] ?? "base64").toString(
    "hex",
  );
  ```
- **`surfnet_timeTravel`'s `absoluteTimestamp` is in MILLISECONDS** since epoch (matches `Date.now()`). Surfpool converts to the on-chain Clock.unix_timestamp (seconds) internally. Sending seconds where ms was expected fails with `Internal error: Cannot travel to past timestamp`.
- **Time-travel is absolute, not delta.** Repeated calls accumulate the on-chain clock far beyond wall clock. A `timeTravel(60)` helper that does `Date.now() + 60 * 1000` will fail with "past timestamp" once the chain has been advanced past wall by an earlier call. Read the current on-chain Clock first and add the delta to _that_:
  ```typescript
  const info = await rpc<{ value: { data: [string, string] } }>(
    "getAccountInfo",
    [SYSVAR_CLOCK, { encoding: "base64" }],
  );
  const onChainSecs = Number(
    Buffer.from(info.result.value.data[0], "base64").readBigInt64LE(32),
  );
  const targetMs = (onChainSecs + seconds) * 1000;
  ```
- **`surfpool start --ci --offline --manifest-file-path Anchor.toml` does NOT auto-deploy the workspace .so binaries.** It registers program IDs for txtx workflows but the programs themselves stay missing. After surfpool is healthy, airdrop the deploy payer and run `solana program deploy --program-id <kp>.json --use-rpc --url http://localhost:8899` for each program.
- **Anchor programs that CPI into many inner ixs may exhaust the default 200k CU.** Surfpool surfaces this faster than test-validator (slot times are sub-second). Bump the budget on the outer call:
  ```typescript
  await program.methods.createMarket(...).preInstructions([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ]).rpc();
  ```

### 16. State persists between e2e runs against the same surfpool

Specs that mutate state (settle a market, lock funds, etc.) leave the chain in an end-state that breaks subsequent runs. The classic case: spec 10 settles the market; on the next `pnpm test:e2e` without re-booting surfpool, every spec that needs `MarketLifecycle == Open` fails with `MarketNotActive`.

Two acceptable fixes:

- Re-boot surfpool fully between runs (`pnpm dev:surfpool` resets the validator).
- Make `globalSetup` detect terminal state and re-seed a fresh market into `.env.local`.

The cheap fix is "always re-boot." The robust fix is `globalSetup` re-seeding. Pick one; document which.

### 17. Default test keypair path

`loadTestKeypair()` should default to the canonical path the seed script writes (`apps/demo/.localnet/user-keypair.json`), not `/tmp/sooth-test-kp.json` or any other ephemeral location. Also accept `VITE_TEST_KEYPAIR_BYTES` as an env override that wins over the file path — that way the in-browser LocalKeypairAdapter and the spec-side helper see the same wallet without coordination plumbing.

```typescript
export function loadTestKeypair(): Keypair {
  const inlineBytes = process.env.VITE_TEST_KEYPAIR_BYTES;
  if (inlineBytes) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(inlineBytes)));
  }
  const path = process.env.TEST_KEYPAIR_PATH ?? DEFAULT_TEST_KEYPAIR_PATH;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}
```

## See Also

- references/local-keypair-adapter.ts — full reference impl
- references/onchain.ts — full helpers
- references/playwright-config.ts — production-grade config
- references/example-spec.ts — annotated reference spec for AMM buy
- The EVM `web3-e2e` skill — sibling skill; concepts mirror exactly, plumbing differs

## Hard-won lessons (post-T64)

### LMSR i128 saturation

Graduation requires cumulative q ≈ 138·b when `fee_bps=100`, and `wad_div(q, b) = q*WAD/b` saturates i128 once `q > 170·WAD`. Fresh-market e2e specs that need to graduate must therefore use `b <= 1·WAD`. See `packages/programs-core/programs/sooth_amm/src/math/wad.rs` and the fix in `apps/demo/e2e/onchain/14-trade-to-graduate-e2e.spec.ts`.

### `__soothCreatedMarketPdas` sessionStorage mirror

Playwright wipes window globals between `page.goto` navigations, so newly-launched market PDAs disappear when a test hops from `/launchpad` to `/markets`. The chain-shim's `amm-bridge` mirrors `__soothCreatedMarketPdas` to `sessionStorage` after each successful `createMarket` dispatch; `portfolio-bridge` and `markets-bridge` read both sources. See `apps/demo/src/lib/chain-shim/amm-bridge.ts`.

### SDK `submit()` CU-price salt

Two back-to-back identical writes with the same signer, instruction set, and blockhash window hash identically, and the cluster rejects the second send as a duplicate. `SolanaChainAdapter.submit()` adds a per-call microLamports salt via `nextSubmitComputeUnitPrice()` so every submission is unique. See `packages/sdk-solana/src/adapter.ts`.

### Adapter-only specs produce no `video.webm`

Playwright only records when a spec instantiates a `page` (i.e. opens a browser context). Specs that drive the program purely through the adapter — e.g. `03-slippage-rejection-amm-e2e.spec.ts`, `09-trading-window-e2e.spec.ts` — never touch a page, so no video file is produced. Any video-walkthrough builder must detect the missing `video.webm` per spec and substitute a longer "PASSED · ADAPTER-ONLY" title slot rather than failing on the missing file. See the discovery loop in `apps/demo/scripts/build-e2e-walkthrough.mjs`.

### Singleton `lp_yield_vault` carries residue across runs

`lp_yield_authority` is a singleton PDA across the protocol (seeds `[b"lp_yield_authority"]`, no per-market scope), so its USDC ATA accumulates funds across every e2e run that funds it. Tests that assert on the post-redeem vault balance must snapshot the live pre-redeem balance and compute `expectedPayout = vaultBefore * burn / supply` — using the just-minted `yieldAmount` as the denominator drifts by exactly the residue and breaks on the second run. See `apps/demo/e2e/onchain/17-redeem-lp-e2e.spec.ts`.

### UI flow doesn't reliably fire repeated rapid clicks

Upstream's `SimpleTradingPanel` keeps `isPending` / `isTradeSuccess` state across submits and races React-Query refetches when the user clicks the trade button rapidly in succession. The first click lands a real tx; the second click frequently no-ops because the panel hasn't fully cycled state yet. For e2e specs that need many trades in a loop (e.g. `14-trade-to-graduate-e2e.spec.ts`), do **one UI click as proof the panel path works**, then drive the rest of the loop adapter-direct via `buyViaAdapter` / `sellViaAdapter` helpers. The protocol invariant under test (graduation flip, fee accumulator) is the same either way, and the helper has the CU-price salt for dup-tx avoidance.

### Creator's USDC ATA isn't auto-created by `create_market`

`sooth_launchpad::create_market` doesn't pre-create a USDC ATA for the market creator. Tests that read `creatorUsdcAta` (e.g. to assert the redeem-LP payout landed) will hit `TokenAccountNotFoundError` on a fresh keypair. Idempotent-create the ATA up front with mint-authority paying for rent:

```typescript
await sendAndConfirmTransaction(
  conn,
  new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      mintAuthority.publicKey,
      creatorUsdcAta,
      creator.publicKey,
      usdcMint,
    ),
  ),
  [mintAuthority],
);
```

See the setup block in `apps/demo/e2e/onchain/17-redeem-lp-e2e.spec.ts`.

### Video evidence: `E2E_VIDEO=on` + walkthrough builder

The Playwright config gates video recording behind `E2E_VIDEO=on` so it stays off by default (videos add ~1-2 MB per spec and slow CI). To produce a single shareable mp4 of the suite:

```bash
E2E_VIDEO=on pnpm -F @sooth/demo test:e2e
node apps/demo/scripts/build-e2e-walkthrough.mjs
# → apps/demo/test-results/19-suite-walkthrough.mp4
```

The builder renders title-card PNGs via headless Chromium (homebrew ffmpeg ships without `drawtext`, so we can't burn captions in directly), encodes each into a 2.5s h.264 segment, re-encodes each `video.webm` with `setsar=1` to keep concat-demuxer happy, and stitches via `-f concat -c copy`. See `apps/demo/scripts/build-e2e-walkthrough.mjs`.
