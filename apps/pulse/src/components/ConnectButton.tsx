import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";

export function ConnectButton({ full }: { full?: boolean }) {
  const { setVisible } = useWalletModal();
  const { publicKey, connected } = useWallet();
  const label =
    connected && publicKey
      ? `${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-4)}`
      : "Connect wallet";
  return (
    <button
      onClick={() => setVisible(true)}
      className={`border border-rule bg-inset px-4 py-2 font-mono text-xs text-ink hover:border-accent ${full ? "w-full py-3" : ""}`}
    >
      {label}
    </button>
  );
}
