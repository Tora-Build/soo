// Chain-locked feature: the upstream HealthCheck component validates EVM
// contract addresses on a per-deployment basis (function selector probe,
// owner check, etc.) — none of that maps to Solana programs. The Solana
// fork renders a placeholder that matches upstream's loading-state shape.

import { usePublicClient } from "@/lib/chain-shim";
import { useChainStore } from "../store/useChainStore";
import { DEFAULT_CHAIN_ID } from "../lib/chains";

export default function HealthCheckPage() {
  const { selectedChainId } = useChainStore();
  const chainId = Number(selectedChainId) || DEFAULT_CHAIN_ID;
  const publicClient = usePublicClient({ chainId });

  if (!publicClient) {
    return (
      <div className="min-h-screen bg-inset p-6 font-mono text-muted">
        No public client for chain {chainId}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-inset p-6 font-mono text-muted">
      <h1 className="text-h1 text-ink">Health check</h1>
      <p className="mt-4">
        EVM contract health checks are not available in the Solana fork.
      </p>
      <p className="mt-2">
        For Solana program-account validation, see{" "}
        <code>solana-test-validator</code> +{" "}
        <code>scripts/dev-localnet.sh</code>.
      </p>
    </div>
  );
}
