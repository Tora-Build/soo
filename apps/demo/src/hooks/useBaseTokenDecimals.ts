import { useEffect } from "react";
import { useChainId, useReadContract } from "@/lib/chain-shim";
import { ERC20_ABI } from "../config/abis";
import { useDeployments } from "./useDeployments";
import { useChainStore } from "../store/useChainStore";

const DEFAULT_USDC_DECIMALS = 6;
const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string, details: Record<string, unknown>) {
  if (!import.meta.env.DEV || warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message, details);
}

/**
 * Returns BaseToken decimals. Uses the value baked into deployments.json
 * as the synchronous default (no flicker on chain switch), then confirms
 * with an on-chain read that is cached forever — decimals() is immutable.
 */
export function useBaseTokenDecimals(): number {
  const { contracts } = useDeployments();
  const walletChainId = useChainId();
  const { selectedChainId } = useChainStore();
  const chainId = Number(selectedChainId) || walletChainId;
  const baseToken = contracts?.MockUSDC as `0x${string}` | undefined;
  const registryDefault =
    contracts?.baseTokenDecimals ?? DEFAULT_USDC_DECIMALS;

  const { data } = useReadContract({
    address: baseToken,
    abi: ERC20_ABI,
    functionName: "decimals",
    chainId,
    query: {
      enabled: !!baseToken,
      staleTime: Infinity,
      gcTime: Infinity,
      refetchInterval: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  });

  useEffect(() => {
    if (!baseToken) return;

    if (contracts?.baseTokenDecimals === undefined) {
      warnOnce(
        `missing:${chainId}:${baseToken}`,
        "[useBaseTokenDecimals] baseTokenDecimals missing from deployments",
        {
          chainId,
          baseToken,
          fallback: DEFAULT_USDC_DECIMALS,
        },
      );
    }

    if (data !== undefined && Number(data) !== registryDefault) {
      warnOnce(
        `mismatch:${chainId}:${baseToken}:${registryDefault}:${String(data)}`,
        "[useBaseTokenDecimals] baseTokenDecimals mismatch",
        {
          chainId,
          baseToken,
          registry: registryDefault,
          onchain: Number(data),
        },
      );
    }
  }, [baseToken, chainId, contracts?.baseTokenDecimals, data, registryDefault]);

  return data === undefined ? registryDefault : Number(data);
}
