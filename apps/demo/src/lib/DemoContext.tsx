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
import { useSolanaLiveRefresh } from "./useSolanaLiveRefresh";

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
  /** Additional markets to list. There is no on-chain registry, so a market
   *  created outside the seed script is invisible without this. */
  extraMarketRefs: string[];
  connected: boolean;
  isOverride: boolean;
}

// Exported (in addition to the `useDemo` hook) so the chain-shim layer can
// peek at the adapter without imposing the "throw if unmounted" constraint
// that `useDemo` enforces — `usePublicClient` is called from contexts that
// pre-date DemoProvider during initial render and must degrade gracefully.
export const DemoContextObj = createContext<DemoCtx | null>(null);

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
      // An override (tests, e2e) names one market explicitly.
      extraMarketRefs: [],
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

  // Push-based freshness. Without this nothing invalidates on on-chain
  // activity: upstream's live updates all hang off EVM events, and the
  // chain-shim's `useWatchContractEvent` is a no-op, so the app ran on polling
  // alone — a trade could land and leave the page stale until the next tick.
  //
  // One program subscription covers every book, AMM state and position. That
  // is cheaper than it sounds because the redesigned book is ONE account per
  // market rather than one per price level, so a market's whole orderbook —
  // ladder, seats, credit, escrow — is a single account change.
  const watchedPrograms = useMemo(
    () => [demoConfig.node.programs?.soothCore].filter(Boolean) as string[],
    [],
  );
  const watchedAccounts = useMemo(
    // The wallet itself, so a SOL balance change lands without waiting for the
    // next poll. Its USDC ATA is covered by the token program, which is not
    // worth a subscription — the balance query already polls.
    () => (wallet.publicKey ? [wallet.publicKey.toBase58()] : []),
    [wallet.publicKey],
  );

  useSolanaLiveRefresh({
    connection: connection as unknown as Connection,
    accounts: watchedAccounts,
    programs: watchedPrograms,
    enabled: !!connection,
  });

  const value: DemoCtx = {
    adapter,
    userRef,
    signer,
    marketRef: demoConfig.marketRef,
    extraMarketRefs: demoConfig.extraMarketRefs,
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
