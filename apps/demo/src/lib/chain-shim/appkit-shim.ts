// chain-shim/appkit-shim.ts — stand-in for `@reown/appkit/react`. Upstream
// uses these hooks to open a wallet-connect modal and read the active
// account. We route them to `@solana/wallet-adapter-react-ui`'s modal.

import { useCallback } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";

export function useAppKit() {
  const { setVisible } = useWalletModal();
  const open = useCallback((_args?: unknown) => setVisible(true), [setVisible]);
  const close = useCallback(() => setVisible(false), [setVisible]);
  return { open, close };
}

export function useAppKitAccount() {
  const wallet = useWallet();
  const address = wallet.publicKey?.toBase58();
  return {
    address,
    caipAddress: address ? `solana:${address}` : undefined,
    isConnected: !!wallet.connected,
    embeddedWalletInfo: undefined,
    status: wallet.connected ? "connected" : "disconnected",
  };
}

// `createAppKit` is invoked once at module-init time by upstream `main.tsx`.
// The Solana fork's `main.tsx` is hand-written and does NOT call this; we
// keep the symbol exported so any stray import resolves.
export function createAppKit(_args: unknown): void {
  /* no-op */
}

// `WagmiAdapter` from @reown/appkit-adapter-wagmi — collapse to a stub.
export class WagmiAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wagmiConfig: any = {};
  constructor(_args?: unknown) {}
}

// `AppKitNetwork` is a structural type — alias to a permissive shape.
export type AppKitNetwork = {
  id: number | string;
  name: string;
  [k: string]: unknown;
};
