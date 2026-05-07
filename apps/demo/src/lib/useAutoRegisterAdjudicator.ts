// One-shot auto-registration of the connected wallet on the adjudicator
// allowlist. Without this, every new wallet that tries to call
// `createMarket` or operator settle/attest paths fails on-chain with
// `sooth_market::AdjudicatorNotAllowlisted` (6012). Manual workaround is
// running `addAdjudicator` from a CLI signed by the allowlist authority —
// surfaces a sharp edge for first-time users on localnet.
//
// Localnet only: relies on `VITE_TEST_AUTHORITY_BYTES` being set in
// `.env.local` (written by `seed-localnet.mjs`). On devnet/mainnet the env
// is unset and the hook is a no-op; ops should register adjudicators
// out-of-band there.
//
// Idempotent — the chain-shim's `dispatchAddAdjudicator` swallows
// `AdjudicatorAlreadyAllowlisted` so re-running on every page reload is
// safe; we only call it once per pubkey per session via a ref.

import { useEffect, useRef } from "react";
import { useWriteContract, useAccount } from "@/lib/chain-shim";

export function useAutoRegisterAdjudicator(): void {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const lastRegistered = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected || !address) return;
    if (lastRegistered.current === address) return;
    const env = (
      import.meta as unknown as { env?: Record<string, string | undefined> }
    ).env;
    if (!env?.VITE_TEST_AUTHORITY_BYTES) return; // devnet/mainnet — no-op

    lastRegistered.current = address;
    void (async () => {
      try {
        const sig = await writeContractAsync({
          functionName: "addAdjudicator",
          // chain-shim ignores the EVM-shaped address slot; pass the
          // base58 pubkey as the first arg explicitly so the dispatcher
          // registers exactly the connected wallet.
          args: [String(address).replace(/^0x/, "")],
        });
        // eslint-disable-next-line no-console
        console.log("[auto-register-adjudicator] OK for", address, "sig:", sig);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          "[auto-register-adjudicator] failed (non-fatal):",
          (e as Error).message,
        );
      }
    })();
  }, [address, isConnected, writeContractAsync]);
}
