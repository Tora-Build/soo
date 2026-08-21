export interface RegistryNode {
  id: string;
  chainId: number;
  deployedBy: `0x${string}`;
  contracts: {
    launchpadEngine: `0x${string}`;
  };
}

export interface HiddenMarketsConfig {
  nodeId: string;
  hiddenMarkets: string[];
  updatedAt: string | null;
}

const DEFAULT_REGISTRY_URL = "https://registry.sooth.market";

export function getRegistryUrl() {
  return import.meta.env.VITE_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

export async function fetchRegistryCapabilities() {
  const res = await fetch(`${getRegistryUrl()}/v1`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { endpoints?: string[] };
  const endpoints = payload.endpoints ?? [];
  return {
    hiddenMarkets: endpoints.some((endpoint) =>
      endpoint.includes("/v1/nodes/:id/hidden-markets"),
    ),
  };
}

export async function fetchRegistryNodeForDeployment(
  chainId: number,
  launchpadEngine: string,
) {
  const params = new URLSearchParams({ chainId: String(chainId) });
  const res = await fetch(`${getRegistryUrl()}/v1/nodes?${params.toString()}`);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch registry nodes for chain ${chainId}: HTTP ${res.status}`,
    );
  }
  const payload = (await res.json()) as { data?: RegistryNode[] };
  const normalizedLaunchpadEngine = launchpadEngine.toLowerCase();
  return (
    payload.data?.find(
      (node) =>
        node.chainId === chainId &&
        node.contracts.launchpadEngine.toLowerCase() ===
          normalizedLaunchpadEngine,
    ) ?? null
  );
}

export async function fetchHiddenMarkets(nodeId: string) {
  const res = await fetch(
    `${getRegistryUrl()}/v1/nodes/${nodeId}/hidden-markets`,
  );
  if (res.status === 404) {
    return {
      nodeId,
      hiddenMarkets: [],
      updatedAt: null,
    };
  }
  if (!res.ok) {
    throw new Error(
      `Failed to fetch hidden markets for node ${nodeId}: HTTP ${res.status}`,
    );
  }
  const payload = (await res.json()) as { data?: HiddenMarketsConfig };
  return (
    payload.data ?? {
      nodeId,
      hiddenMarkets: [],
      updatedAt: null,
    }
  );
}

export async function updateHiddenMarkets(
  nodeId: string,
  hiddenMarkets: string[],
  adminToken: string,
) {
  const res = await fetch(
    `${getRegistryUrl()}/v1/nodes/${nodeId}/hidden-markets`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hiddenMarkets }),
    },
  );

  const payload = (await res.json()) as {
    data?: HiddenMarketsConfig;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(
      payload.error || `Failed to update hidden markets: HTTP ${res.status}`,
    );
  }

  return (
    payload.data ?? {
      nodeId,
      hiddenMarkets,
      updatedAt: new Date().toISOString(),
    }
  );
}
