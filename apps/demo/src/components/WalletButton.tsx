// Wallet connection button. Production renders the wallet-adapter UI's
// `WalletMultiButton`. Test path skips this entirely (DemoProvider override
// supplies the user/signer programmatically).
//
// We import from `@solana/wallet-adapter-react-ui` directly; its CSS is
// loaded once in `main.tsx`.

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useDemo } from "../lib/DemoContext";
import { truncatePubkey } from "../lib/utils";

export function WalletButton() {
  const { userRef, connected } = useDemo();
  // In test override mode `userRef` is set without the wallet-adapter UI;
  // render a static badge so the buy form's "connect first" branch isn't
  // accidentally triggered.
  if (connected && userRef) {
    return (
      <div className="px-3 py-2 text-xs font-mono bg-slate-800 border border-slate-700 rounded">
        {truncatePubkey(userRef.replace(/^sol:/, ""))}
      </div>
    );
  }
  return <WalletMultiButton />;
}
