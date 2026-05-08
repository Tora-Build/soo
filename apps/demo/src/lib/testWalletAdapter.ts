// LocalKeypairAdapter for E2E testing.
//
// This adapter signs Solana transactions with a Keypair loaded from
// VITE_TEST_KEYPAIR_BYTES (a 64-byte JSON array env var). It is wired
// into <WalletProvider> ONLY when VITE_TEST_MODE === "true" — the production
// build refuses to bundle it (vite.config.ts throws).
//
// Why a custom adapter:
//   - @solana/wallet-adapter-base ships a MockWallet that fakes connection
//     state but does not sign — useless for e2e against a real chain.
//   - This adapter implements BaseSignerWalletAdapter so wallet-adapter-react
//     treats it identically to Phantom/Solflare; the rest of the app
//     (DemoContext, chain-shim) needs no changes.
//
// SECURITY:
//   - VITE_TEST_KEYPAIR_BYTES MUST come from .env.local (gitignored).
//   - vite.config.ts throws on `build` with VITE_TEST_MODE=true.
//   - The TestWalletBridge no-ops outside test mode.

import { useEffect } from "react";
import {
  BaseSignerWalletAdapter,
  WalletReadyState,
  type SupportedTransactionVersions,
  type WalletName,
} from "@solana/wallet-adapter-base";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  useWallet,
  type WalletContextState,
} from "@solana/wallet-adapter-react";
import nacl from "tweetnacl";

const ADAPTER_NAME = "Local Keypair" as WalletName<"Local Keypair">;

function resolveTestKeypair(): Keypair {
  const json = (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_TEST_KEYPAIR_BYTES;
  if (!json) {
    throw new Error(
      "VITE_TEST_KEYPAIR_BYTES not set. Generate with `solana-keygen new -o /tmp/test-kp.json --no-bip39-passphrase --silent` and `export VITE_TEST_KEYPAIR_BYTES=$(cat /tmp/test-kp.json)`",
    );
  }
  let bytes: number[];
  try {
    bytes = JSON.parse(json);
  } catch {
    throw new Error("VITE_TEST_KEYPAIR_BYTES is not valid JSON");
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(
      `VITE_TEST_KEYPAIR_BYTES must be a 64-byte JSON array; got length ${
        Array.isArray(bytes) ? bytes.length : "non-array"
      }`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export class LocalKeypairAdapter extends BaseSignerWalletAdapter {
  name = ADAPTER_NAME;
  url = "https://example.com/local-keypair";
  icon =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4=";
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

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get connected(): boolean {
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

  async signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this._keypair]);
    } else {
      (tx as Transaction).partialSign(this._keypair);
    }
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, this._keypair.secretKey);
  }
}

// ─── Test-process bridge ─────────────────────────────────────────────────
//
// Exposes window._connectTestWallet so Playwright can connect the wallet
// without driving the WalletModal UI. The bridge re-mounts the
// `select() → connect()` dance because wallet-adapter-react's
// WalletContextState.select is sync but state updates async; we yield a
// microtask between the two.

let walletCtxRef: WalletContextState | null = null;

function exposeBridge(): void {
  if (typeof window === "undefined") return;
  const env =
    (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  if (env.VITE_TEST_MODE !== "true") return;
  (window as unknown as Record<string, unknown>)._connectTestWallet =
    async () => {
      if (!walletCtxRef) throw new Error("Wallet context not registered");
      if (walletCtxRef.connected) return;
      walletCtxRef.select(ADAPTER_NAME);
      // wallet-adapter-react's select() is sync but the React render that
      // surfaces walletCtxRef.wallet happens on the next microtask. A
      // setTimeout(0) yield isn't always enough — under faster runtimes
      // (surfpool e2e) connect() races the render and throws
      // WalletNotSelectedError. Poll until walletCtxRef.wallet propagates,
      // capped to 1s so we still fail fast if select() did nothing.
      for (let i = 0; i < 50; i++) {
        if (walletCtxRef.wallet) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await walletCtxRef.connect();
    };
}

export function TestWalletBridge(): null {
  const wallet = useWallet();
  useEffect(() => {
    const env =
      (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
    if (env.VITE_TEST_MODE !== "true") return;
    walletCtxRef = wallet;
    exposeBridge();
  }, [wallet]);
  return null;
}
