import { useState, useEffect } from "react";
import { useChainId } from "@/lib/chain-shim";

interface IndexerChainStatus {
  id: number;
  block: {
    number: number;
    timestamp: number;
  };
}

interface IndexerStatus {
  monadTestnet?: IndexerChainStatus;
  baseSepolia?: IndexerChainStatus;
  ethereumSepolia?: IndexerChainStatus;
  arcTestnet?: IndexerChainStatus;
  megaETHTestnet?: IndexerChainStatus;
  hyperEVMTestnet?: IndexerChainStatus;
}

const INDEXER_URL =
  import.meta.env.VITE_INDEXER_URL || "http://localhost:42069";
const POLL_INTERVAL_MS = 10_000;

export function useIndexerStatus() {
  const chainId = useChainId();
  const [status, setStatus] = useState<IndexerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    let timeoutId: number | undefined;

    const fetchStatus = async () => {
      try {
        const response = await fetch(`${INDEXER_URL}/status`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (isMounted) {
          setStatus(data);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to fetch");
          setIsLoading(false);
        }
      }

      if (isMounted) {
        timeoutId = window.setTimeout(fetchStatus, POLL_INTERVAL_MS);
      }
    };

    fetchStatus();

    return () => {
      isMounted = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  const currentChainStatus = status
    ? chainId === 84532
      ? status.baseSepolia
      : chainId === 11155111
        ? status.ethereumSepolia
      : chainId === 10143
        ? status.monadTestnet
        : chainId === 5042002
          ? status.arcTestnet
          : chainId === 6343
            ? status.megaETHTestnet
            : chainId === 998
              ? status.hyperEVMTestnet
              : null
    : null;

  return {
    status,
    currentChainStatus,
    isLoading,
    error,
  };
}
