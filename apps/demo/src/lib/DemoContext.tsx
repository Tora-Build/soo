// `DemoProvider` wires the SolanaChainAdapter into React. Two modes:
//
//   1. Production / dev: builds a real `Connection` from `demoConfig.node`,
//      reads the active wallet pubkey from `@solana/wallet-adapter-react`'s
//      `useWallet()`. The signer comes from `wallet.adapter`.
//
//   2. Test injection: the test wraps the app in `<DemoProvider override={...}>`
//      passing a pre-built adapter (with a BankrunConnection) plus a
//      programmatic signer. This keeps the React tree free of wallet-adapter
//      UI in the test path.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Connection, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  SolanaChainAdapter,
  encodePubkeyRef,
  type SignerRef,
} from "@sooth/sdk-solana";

import { demoConfig } from "./config";

export interface DemoOverride {
  adapter: SolanaChainAdapter;
  userRef: string;
  signer: SignerRef;
  marketRef: string;
}

interface DemoCtx {
  adapter: SolanaChainAdapter;
  userRef: string | null;
  signer: SignerRef | null;
  marketRef: string | null;
  connected: boolean;
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

function ProductionDemoProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const wallet = useWallet();

  const adapter = useMemo(
    () =>
      new SolanaChainAdapter({
        node: demoConfig.node,
        connection: connection as unknown as Connection,
      }),
    [connection],
  );

  const userRef = wallet.publicKey ? encodePubkeyRef(wallet.publicKey) : null;

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

export function useAdapter(): SolanaChainAdapter {
  return useDemo().adapter;
}
