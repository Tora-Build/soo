// Wallet connection button. Production renders the wallet-adapter UI's
// `WalletMultiButton`. Test path skips this entirely (DemoProvider override
// supplies the user/signer programmatically).
//
// We import from `@solana/wallet-adapter-react-ui` directly; its CSS is
// loaded once in `main.tsx`.
//
// UX layers added on top of the bare WalletMultiButton:
//
//   1. If no Solana wallet adapter reports `Installed` readyState, we
//      render a "no wallet detected" notice with a Phantom install link
//      instead of a useless connect button. The wallet-adapter modal
//      *does* show install prompts, but only after a click — surfacing
//      it in the header avoids the silent-failure path.
//
//   2. If the RPC is unreachable, we show a "validator not reachable"
//      hint above the connect button. This catches the most common cause
//      of "I clicked connect and nothing happened" on localnet — the
//      wallet succeeds but `useSnapshot` immediately fails the page.
//
// Hook-call gating: `useWallet` and `useRpcHealth` (which calls
// `useConnection`) only work when their respective providers are mounted.
// The test path skips those providers entirely (the override branch in
// `DemoProvider`), so we split the production component out and render
// the override badge before any wallet-adapter hook runs.

import { useMemo } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { useDemo } from "../lib/DemoContext";
import { useRpcHealth } from "../hooks/useRpcHealth";
import { truncatePubkey } from "../lib/utils";

export function WalletButton() {
  const { userRef, connected, isOverride } = useDemo();

  // In test override mode `userRef` is set without the wallet-adapter UI;
  // render a static badge so the buy form's "connect first" branch isn't
  // accidentally triggered AND so we never call wallet-adapter hooks (the
  // test path doesn't mount the providers).
  if (isOverride) {
    return (
      <div className="px-3 py-2 text-xs font-mono bg-slate-800 border border-slate-700 rounded">
        {connected && userRef
          ? truncatePubkey(userRef.replace(/^sol:/, ""))
          : "test override"}
      </div>
    );
  }

  return <ProductionWalletButton />;
}

function ProductionWalletButton() {
  const { userRef, connected } = useDemo();
  const { wallets } = useWallet();
  const { ok: rpcOk } = useRpcHealth();

  // Already connected — show a compact pubkey badge instead of the full
  // wallet-adapter button. Click-to-disconnect is still wired through the
  // wallet extension UI; the badge is read-only by design.
  if (connected && userRef) {
    return (
      <div className="px-3 py-2 text-xs font-mono bg-slate-800 border border-slate-700 rounded">
        {truncatePubkey(userRef.replace(/^sol:/, ""))}
      </div>
    );
  }

  // Detect "no wallet at all" — every adapter is `NotDetected` /
  // `Unsupported`. `Loadable` (wallet extension that's installed but not
  // yet activated) still counts as installed for our purposes.
  const installed = useMemo(
    () =>
      wallets.filter(
        (w) =>
          w.readyState === WalletReadyState.Installed ||
          w.readyState === WalletReadyState.Loadable,
      ),
    [wallets],
  );

  if (installed.length === 0) {
    return (
      <div
        className="text-xs text-rose-300 flex flex-col items-end gap-1"
        data-testid="wallet-not-detected"
      >
        <span>No Solana wallet detected.</span>
        <a
          href="https://phantom.com/download"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-rose-200"
        >
          Install Phantom
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <WalletMultiButton />
      {rpcOk === false ? (
        <span
          className="text-[10px] font-mono text-rose-400"
          data-testid="wallet-rpc-warn"
        >
          Validator unreachable — connect will succeed but the dapp can't read
          state.
        </span>
      ) : null}
    </div>
  );
}
