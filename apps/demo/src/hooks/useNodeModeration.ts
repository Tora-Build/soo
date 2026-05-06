import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_CHAIN_ID } from "../lib/chains";
import {
  fetchRegistryCapabilities,
  fetchHiddenMarkets,
  fetchRegistryNodeForDeployment,
} from "../lib/registry";
import { useChainStore } from "../store/useChainStore";
import { useDeployments } from "./useDeployments";

type Address = `0x${string}`;

export function useNodeModeration() {
  const { selectedChainId } = useChainStore();
  const parsedChainId =
    typeof selectedChainId === "number"
      ? selectedChainId
      : Number(selectedChainId);
  const chainId = Number.isFinite(parsedChainId)
    ? parsedChainId
    : DEFAULT_CHAIN_ID;
  const deployments = useDeployments();
  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | Address
    | undefined;

  const nodeQuery = useQuery({
    queryKey: ["registry-node", chainId, launchpadEngineAddress],
    enabled: !!launchpadEngineAddress && !!chainId,
    staleTime: 60_000,
    queryFn: () => fetchRegistryNodeForDeployment(chainId, launchpadEngineAddress!),
  });

  const nodeId = nodeQuery.data?.id;

  const capabilitiesQuery = useQuery({
    queryKey: ["registry-capabilities"],
    staleTime: Infinity,
    queryFn: fetchRegistryCapabilities,
  });
  const hiddenMarketsSupported =
    capabilitiesQuery.data?.hiddenMarkets ?? false;

  const moderationQuery = useQuery({
    queryKey: ["registry-hidden-markets", nodeId],
    enabled: !!nodeId && hiddenMarketsSupported,
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: () => fetchHiddenMarkets(nodeId!),
  });

  const hiddenMarkets = moderationQuery.data?.hiddenMarkets ?? [];
  const hiddenMarketSet = useMemo(
    () => new Set(hiddenMarkets.map((address) => address.toLowerCase())),
    [hiddenMarkets],
  );

  return {
    chainId,
    nodeId,
    node: nodeQuery.data,
    hiddenMarketsSupported,
    hiddenMarkets,
    hiddenMarketSet,
    updatedAt: moderationQuery.data?.updatedAt ?? null,
    isHidden: (address?: string | null) =>
      !!address && hiddenMarketSet.has(address.toLowerCase()),
    isLoading:
      nodeQuery.isLoading ||
      capabilitiesQuery.isLoading ||
      moderationQuery.isLoading,
    refetch: moderationQuery.refetch,
  };
}
