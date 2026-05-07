import { useState, useEffect } from "react";
import { useChainId } from "@/lib/chain-shim";
import { getChainById, isSolanaChain } from "@/lib/chains";

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
  // Solana shapes are reserved but unused — no Solana indexer ships
  // until P3 (namespace strategy) is resolved per docs/decision-log.md.
  solanaMainnet?: IndexerChainStatus;
  solanaDevnet?: IndexerChainStatus;
  solanaLocalnet?: IndexerChainStatus;
}

const INDEXER_URL =
  import.meta.env.VITE_INDEXER_URL || "http://localhost:42069";
const POLL_INTERVAL_MS = 10_000;

export function useIndexerStatus() {
  const chainId = useChainId();
  const chain = getChainById(chainId);
  // The indexer (Ponder over eth_getLogs) only knows EVM chains. On the
  // Solana fork the polling loop would just spam ECONNREFUSED at
  // localhost:42069 every 10s — short-circuit and surface a typed
  // "not configured" state so the footer can render a clear gate
  // instead of "Indexer offline" (which implies a transient failure).
  // Once P3 lands, swap the short-circuit for a real Solana fetch.
  const isSolana = chain ? isSolanaChain(chain) : false;

  const [status, setStatus] = useState<IndexerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(!isSolana);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isSolana) {
      setStatus(null);
      setIsLoading(false);
      setError(null);
      return;
    }

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
  }, [isSolana]);

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
                : chainId === 900
                  ? status.solanaMainnet
                  : chainId === 901
                    ? status.solanaDevnet
                    : chainId === 902
                      ? status.solanaLocalnet
                      : null
    : null;

  return {
    status,
    currentChainStatus,
    isLoading,
    error,
    notConfigured: isSolana,
  };
}
