// One adapter, one signer, no translation layer.
//
// This file is the entire "integration" with the programs: construct the SDK
// adapter once, and wrap the connected wallet as the SignerRef every build*
// method accepts. Compare with the demo's 3,810-line chain-shim — the price
// of speaking wagmi to a Solana program. Pulse doesn't.
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { SolanaChainAdapter } from "@sooth/sdk-solana";

import {
  AMM_MINT,
  BOOK_MINT,
  PROGRAM_ID,
  RPC_URL,
  TEST_KEYPAIR_BYTES,
  TEST_MODE,
} from "../config";

export interface SignerRef {
  publicKey: string;
  signTransaction(bytes: Uint8Array): Promise<Uint8Array>;
}

interface Ctx {
  adapter: SolanaChainAdapter;
  connection: Connection;
  /** Connected wallet as a `sol:` ref, or null. */
  userRef: string | null;
  signer: SignerRef | null;
}

const AdapterContext = createContext<Ctx | null>(null);

// Test mode: the same env-injected keypair the e2e suites drive, so
// Playwright exercises Pulse exactly as it does the other surfaces.
const testKeypair =
  TEST_MODE && TEST_KEYPAIR_BYTES
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(TEST_KEYPAIR_BYTES)))
    : null;

if (testKeypair) {
  (globalThis as Record<string, unknown>)._connectTestWallet = async () => {
    (globalThis as Record<string, unknown>).__pulseTestWallet = true;
    window.dispatchEvent(new Event("pulse-test-wallet"));
  };
}

function subscribeTestWallet(cb: () => void) {
  window.addEventListener("pulse-test-wallet", cb);
  return () => window.removeEventListener("pulse-test-wallet", cb);
}
function testWalletActive(): boolean {
  return (globalThis as Record<string, unknown>).__pulseTestWallet === true;
}

export function AdapterProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const testActiveNow = useSyncExternalStore(
    subscribeTestWallet,
    testWalletActive,
    () => false,
  );

  const base = useMemo(() => {
    const connection = new Connection(RPC_URL, "confirmed");
    const adapter = new SolanaChainAdapter({
      node: {
        id: "pulse",
        chainKind: "solana",
        chainId: "solana:devnet",
        rpcUrl: RPC_URL,
        programs: {
          soothCore: PROGRAM_ID,
          usdcMint: BOOK_MINT.toBase58(),
          ammMint: AMM_MINT.toBase58(),
        },
      },
      connection,
    } as never);
    return { adapter, connection };
  }, []);

  const value = useMemo<Ctx>(() => {
    if (testActiveNow && testKeypair) {
      return {
        ...base,
        userRef: `sol:${testKeypair.publicKey.toBase58()}`,
        signer: {
          publicKey: testKeypair.publicKey.toBase58(),
          async signTransaction(bytes) {
            const tx = Transaction.from(bytes);
            tx.partialSign(testKeypair);
            return tx.serialize();
          },
        },
      };
    }
    if (!wallet.publicKey || !wallet.signTransaction) {
      return { ...base, userRef: null, signer: null };
    }
    const pk = wallet.publicKey;
    const signTx = wallet.signTransaction;
    return {
      ...base,
      userRef: `sol:${pk.toBase58()}`,
      signer: {
        publicKey: pk.toBase58(),
        async signTransaction(bytes) {
          const tx = Transaction.from(bytes);
          const signed = await signTx(tx);
          return signed.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
          });
        },
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, wallet.publicKey, wallet.signTransaction, wallet.connected, testActiveNow]);

  return (
    <AdapterContext.Provider value={value}>{children}</AdapterContext.Provider>
  );
}

export function useAdapter(): Ctx {
  const ctx = useContext(AdapterContext);
  if (!ctx) throw new Error("useAdapter outside AdapterProvider");
  return ctx;
}
