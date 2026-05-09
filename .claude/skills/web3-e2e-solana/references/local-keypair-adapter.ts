// Reference implementation: LocalKeypairAdapter for E2E testing.
//
// Drop into apps/<your-dapp>/src/lib/testWalletAdapter.ts and import only
// when VITE_TEST_MODE === "true". The adapter signs Solana transactions
// with a Keypair loaded from VITE_TEST_KEYPAIR_BYTES (64-byte JSON array).
//
// Why a custom adapter instead of @solana/wallet-adapter-base/MockWallet:
//   - MockWallet doesn't sign — it only fakes connection state.
//   - Real signing is required for the e2e to verify on-chain effects.
//   - This adapter implements BaseSignerWalletAdapter so it integrates
//     into the wallet-adapter-react context exactly like Phantom would.
//
// SECURITY:
//   - VITE_TEST_KEYPAIR_BYTES MUST be in .env.local (gitignored).
//   - vite.config.ts SHOULD throw on `build` with VITE_TEST_MODE=true.
//   - Production builds tree-shake the adapter via dynamic import.

import {
  BaseSignerWalletAdapter,
  WalletReadyState,
  type SupportedTransactionVersions,
} from "@solana/wallet-adapter-base";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

const ADAPTER_NAME = "Local Keypair";

function resolveTestKeypair(): Keypair {
  const json = import.meta.env.VITE_TEST_KEYPAIR_BYTES as string | undefined;
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
  // 1×1 transparent SVG. Replace with your own icon if you want a proper
  // UI presence; the modal will show this in the wallet selection list.
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

// ────────────────────────────────────────────────────────────────────────
// Test-process bridge: exposes window._connectTestWallet so Playwright can
// connect the wallet without driving the WalletModal UI.
// ────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import {
  useWallet,
  type WalletContextState,
} from "@solana/wallet-adapter-react";

let walletCtxRef: WalletContextState | null = null;

function exposeBridge() {
  if (
    typeof window === "undefined" ||
    import.meta.env.VITE_TEST_MODE !== "true"
  ) {
    return;
  }
  (window as unknown as Record<string, unknown>)._connectTestWallet =
    async () => {
      if (!walletCtxRef) throw new Error("Wallet context not registered");
      if (walletCtxRef.connected) return;
      // wallet-adapter-react: select() is sync but state updates async; yield
      // the microtask so connect() sees the new active adapter.
      walletCtxRef.select(ADAPTER_NAME);
      await new Promise((r) => setTimeout(r, 0));
      await walletCtxRef.connect();
    };
}

export function TestWalletBridge() {
  const wallet = useWallet();
  useEffect(() => {
    if (import.meta.env.VITE_TEST_MODE !== "true") return;
    walletCtxRef = wallet;
    exposeBridge();
  }, [wallet]);
  return null;
}
