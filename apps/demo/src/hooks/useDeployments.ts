import { useEffect } from "react";
import { DEFAULT_CHAIN_ID } from "../lib/chains";
import { useChainStore } from "../store/useChainStore";
import deploymentsJson from "../config/deployments.json";

// Define the shape of deployments for a single chain
export interface ChainDeployments {
  MockUSDC: string;
  baseTokenDecimals?: number;
  LaunchpadEngine?: string;
  SoothBook?: string;
  AMMEngine?: string;
  OrderEngine?: string;
  TruthMarket?: string;
  FeeRouter?: string;
  AdjudicatorRegistry?: string;
  // Optional entries — absent from v0.1.0+ deployments.
  Collateralizer?: string;
  ProtocolConfig?: string;
  USDC?: string;
  [key: string]: string | number | undefined;
}

type NetworkEntry = {
  chainId: number;
  contracts: Record<string, string | number>;
  markets?: string[];
};

const networks = deploymentsJson.networks as Record<string, NetworkEntry>;

function getDeployment(
  chainId: number,
): { contracts: Record<string, string | number> } | undefined {
  for (const network of Object.values(networks)) {
    if (network.chainId === chainId) {
      return { contracts: network.contracts };
    }
  }
  return undefined;
}

/**
 * Return EVERY deployment that matches the chainId, in declaration order.
 * Multi-node-per-chain (e.g. Base Sepolia hosts both v0.2.0 and v0.1.2)
 * means a single chain can have multiple LaunchpadEngines. Lookups for a
 * specific market need to probe each engine until they find the one that
 * actually has the market.
 */
export function getAllDeploymentsForChain(
  chainId: number,
): Array<{ contracts: Record<string, string | number> }> {
  const matches: Array<{ contracts: Record<string, string | number> }> = [];
  for (const network of Object.values(networks)) {
    if (network.chainId === chainId) {
      matches.push({ contracts: network.contracts });
    }
  }
  return matches;
}

export function useDeployments() {
  const { selectedChainId } = useChainStore();
  const chainId = Number(selectedChainId) || DEFAULT_CHAIN_ID;

  const deployment = getDeployment(chainId) ?? getDeployment(DEFAULT_CHAIN_ID);
  const configVersion = deploymentsJson.version;

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("sooth_config_version", configVersion);
    }
  }, [configVersion]);

  if (!deployment) {
    console.error(
      `[useDeployments] No deployments found for chain ${chainId} or default ${DEFAULT_CHAIN_ID}.`,
    );
    return {
      contracts: {} as ChainDeployments,
      config: { contracts: {} as ChainDeployments },
    };
  }

  const contracts = deployment.contracts as unknown as ChainDeployments;
  return { contracts, config: { contracts } };
}

export function getDeployments(chainId: number) {
  const deployment = getDeployment(chainId) ?? getDeployment(DEFAULT_CHAIN_ID);
  return (deployment?.contracts ?? {}) as unknown as ChainDeployments;
}
