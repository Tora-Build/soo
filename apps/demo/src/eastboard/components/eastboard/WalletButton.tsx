// Solana wallet button — the same connect flow every other demo surface uses.
import { useAccount, useAppKit } from "@/lib/chain-shim";

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { open } = useAppKit();
  const label =
    isConnected && address
      ? `${address.slice(0, 4)}…${address.slice(-4)}`
      : "Connect";
  return (
    <button
      type="button"
      onClick={() => open()}
      className="border border-rule bg-raised px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink transition-colors hover:border-accent/60"
    >
      {label}
    </button>
  );
}
