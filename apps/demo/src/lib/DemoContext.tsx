// `DemoProvider` wires the SolanaChainAdapter into React. Two modes:
//
//   1. Production / dev: builds a real `Connection` from `demoConfig.node`,
//      reads the active wallet pubkey from `@solana/wallet-adapter-react`'s
//      `useWallet()`. The signer comes from `wallet.adapter`.
//
//   2. Test injection: the test wraps the app in `<DemoProvider override={...}>`
//      passing a pre-built adapter (with a BankrunConnection) plus a
//      programmatic signer. This keeps the React tree free of wallet-adapter
//      UI in the test path while still exercising the same `<App>` and
//      `<MarketDetail>` components that production renders.
//
// The "test" mode is intentionally surfaced as one prop, not a separate
// provider. The demo tests are the load-bearing deliverable; we don't
// branch the component tree.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { Connection, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  SolanaChainAdapter,
  encodePubkeyRef,
  type SignerRef,
} from "@sooth/sdk-solana";

import { demoConfig } from "./config";
import { buildAdapter } from "../adapter/client";

export interface DemoOverride {
  // Test-injected: a fully-constructed adapter (BankrunConnection inside).
  adapter: SolanaChainAdapter;
  // Test-injected: the user's Solana ref (sol:<base58>).
  userRef: string;
  // Test-injected: signer that wraps a Keypair (the test owns it).
  signer: SignerRef;
  // Test-injected: the market the demo lands on.
  marketRef: string;
}

interface DemoCtx {
  adapter: SolanaChainAdapter;
  userRef: string | null;
  signer: SignerRef | null;
  marketRef: string | null;
  connected: boolean;
  // True when the test injected its own adapter+signer via `override={...}`.
  // Components that would normally read from wallet-adapter hooks
  // (`useWallet`, `useConnection`) check this and skip those hooks — the
  // test path doesn't mount the wallet-adapter providers.
  isOverride: boolean;
}

const DemoContextObj = createContext<DemoCtx | null>(null);

export interface DemoProviderProps {
  children: ReactNode;
  override?: DemoOverride;
}

export function DemoProvider({ children, override }: DemoProviderProps) {
  if (override) {
    const value: DemoCtx = {
      adapter: override.adapter,
      userRef: override.userRef,
      signer: override.signer,
      marketRef: override.marketRef,
      connected: true,
      isOverride: true,
    };
    return (
      <DemoContextObj.Provider value={value}>
        {children}
      </DemoContextObj.Provider>
    );
  }

  return <ProductionDemoProvider>{children}</ProductionDemoProvider>;
}

// Production path — relies on the wallet-adapter providers being mounted
// upstream in `main.tsx`.
function ProductionDemoProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const wallet = useWallet();

  const adapter = useMemo(
    () =>
      buildAdapter({
        node: demoConfig.node,
        connection: connection as unknown as Connection,
      }),
    [connection],
  );

  const userRef = wallet.publicKey ? encodePubkeyRef(wallet.publicKey) : null;

  // Wrap wallet-adapter's signTransaction in the SignerRef shape (raw bytes
  // in / raw bytes out). The adapter passes serialized legacy transactions.
  const signMessage = wallet.signMessage;
  const signTx = wallet.signTransaction;
  const signer: SignerRef | null = useMemo(() => {
    if (!wallet.publicKey || !signTx) return null;
    return {
      publicKey: wallet.publicKey.toBase58(),
      signMessage: signMessage
        ? async (msg: Uint8Array) => signMessage(msg)
        : undefined,
      signTransaction: async (raw: Uint8Array) => {
        const tx = Transaction.from(raw);
        const signed = await signTx(tx);
        return signed.serialize({
          verifySignatures: false,
          requireAllSignatures: false,
        });
      },
    };
  }, [wallet.publicKey, signTx, signMessage]);

  const value: DemoCtx = {
    adapter,
    userRef,
    signer,
    marketRef: demoConfig.marketRef,
    connected: !!wallet.connected,
    isOverride: false,
  };

  return (
    <DemoContextObj.Provider value={value}>{children}</DemoContextObj.Provider>
  );
}

export function useDemo(): DemoCtx {
  const ctx = useContext(DemoContextObj);
  if (!ctx) {
    throw new Error("useDemo: missing <DemoProvider>");
  }
  return ctx;
}

// Convenience: a stable callback that returns the adapter — keeps consumers
// from re-rendering when only the wallet shape changes.
export function useAdapter(): SolanaChainAdapter {
  return useDemo().adapter;
}
