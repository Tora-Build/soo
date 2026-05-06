import { Address } from "@/lib/chain-shim";

export type AdjudicatorType =
  | "ZK_ORACLE"
  | "ZK_RULE"
  | "AI_AGENT"
  | "OPTIMISTIC";

export interface AdjudicatorOption {
  id: string;
  name: string;
  nameKey: string;
  address: Address;
  type: AdjudicatorType;
  badges: string[];
  badgeKeys: string[];
  desc: string;
  descKey: string;
  useCase: string;
  useCaseKey: string;
  extraBadge?: string;
  extraBadgeKey?: string;
  fee: string;
}

// Per-chain adjudicator addresses for the supported v0.2.1 nodes.
//
// ManualAdjudicator: same CREATE3 address everywhere
//   0x024BA5f5d9DED6ded6e073a622C21528F5043C06
//
// ZkTLSAdjudicator: chain-specific because each instance binds the local
// Primus verifier.
//   6343     — 0xEe10…b1E9
//   11155111 — 0x1aF3…191f
//
// optimistic is still zero-address → renders as "coming soon" in the picker UI.
const ADJUDICATOR_ADDRESSES: Record<string, Record<number, Address>> = {
  "zk-oracle": {
    6343: "0xEe1029DCDa225cB15E751fDf61F43367456fb1E9" as Address,
    11155111: "0x1aF3cB8B270Db3e71fC979543c32B87709EA191f" as Address,
  },
  manual: {
    6343: "0x024BA5f5d9DED6ded6e073a622C21528F5043C06" as Address,
    11155111: "0x024BA5f5d9DED6ded6e073a622C21528F5043C06" as Address,
  },
  optimistic: {
    6343: "0x0000000000000000000000000000000000000000" as Address,
    11155111: "0x0000000000000000000000000000000000000000" as Address,
  },
};

export function getAdjudicatorAddress(id: string, chainId: number): Address {
  return (
    ADJUDICATOR_ADDRESSES[id]?.[chainId] ||
    ADJUDICATOR_ADDRESSES["zk-oracle"]?.[chainId] ||
    ("0x0000000000000000000000000000000000000000" as Address)
  );
}

/**
 * Look up the adjudicator option by on-chain address for a given chain.
 * Returns undefined if the address doesn't match any registered adjudicator.
 */
export function getAdjudicatorByAddress(
  address: string | undefined,
  chainId: number,
): AdjudicatorOption | undefined {
  if (!address) return undefined;
  const lower = address.toLowerCase();
  for (const [id, chainMap] of Object.entries(ADJUDICATOR_ADDRESSES)) {
    if (chainMap[chainId]?.toLowerCase() === lower) {
      return ADJUDICATOR_REGISTRY.find((a) => a.id === id);
    }
  }
  return undefined;
}

export const ADJUDICATOR_REGISTRY: AdjudicatorOption[] = [
  {
    id: "manual",
    name: "Manual Adjudicator",
    nameKey: "launchpad.adjudicator.manual",
    address: "0x024BA5f5d9DED6ded6e073a622C21528F5043C06" as Address,
    type: "OPTIMISTIC",
    badges: ["Trusted Resolver"],
    badgeKeys: ["launchpad.adjudicator.trustedResolver"],
    fee: "0%",
    desc: "A trusted resolver (EOA) drives the resolve → attest → settle flow manually. Minimum ceremony; good for development and markets with a known, trusted curator.",
    descKey: "launchpad.adjudicator.manualDesc",
    useCase: "Development, curated markets with trusted resolvers",
    useCaseKey: "launchpad.adjudicator.manualUseCase",
  },
  {
    id: "zk-oracle",
    name: "ZK Oracle",
    nameKey: "launchpad.adjudicator.zkOracle",
    address: "0xEe1029DCDa225cB15E751fDf61F43367456fb1E9" as Address, // runtime lookup still selects per-chain address
    type: "ZK_ORACLE",
    badges: ["Web2 API Prove", "Primus"],
    badgeKeys: [
      "launchpad.adjudicator.web2ApiProve",
      "launchpad.adjudicator.primus",
    ],
    fee: "2.5%",
    desc: "Uses zkTLS to prove that a Web2 API response is authentic and untampered. An attestation step is inserted between resolve and settle — the resolver must provide a cryptographic proof that the off-chain data source returned the claimed result.",
    descKey: "launchpad.adjudicator.zkOracleDesc",
    useCase:
      "Any market resolved by provable Web2 data — prices, scores, API results",
    useCaseKey: "launchpad.adjudicator.zkOracleUseCase",
  },
  {
    id: "zk-rule",
    name: "ZK Rule",
    nameKey: "launchpad.adjudicator.zkRule",
    address: "0x0000000000000000000000000000000000000000" as Address, // Not deployed on Base Sepolia yet
    type: "ZK_RULE",
    badges: ["Trustless", "Brevis"],
    badgeKeys: [
      "launchpad.adjudicator.trustless",
      "launchpad.adjudicator.brevis",
    ],
    fee: "5%",
    desc: "Pure blockchain event resolution. A pause-protocol event is tracked and verified via ZK proofs — if the on-chain condition occurred, resolution proceeds automatically. The most minimum-trust setup possible.",
    descKey: "launchpad.adjudicator.zkRuleDesc",
    useCase: "Insurance markets, protocol circuit-breaker events",
    useCaseKey: "launchpad.adjudicator.zkRuleUseCase",
  },
  {
    id: "ai-agent",
    name: "Agent Adjudicator",
    nameKey: "launchpad.adjudicator.agentAdjudicator",
    address: "0x0000000000000000000000000000000000000000" as Address, // Not deployed on Base Sepolia yet
    type: "AI_AGENT",
    badges: ["Hardware Trust", "AI"],
    badgeKeys: ["launchpad.adjudicator.hardwareTrust", "AI"],
    fee: "2.5%",
    desc: "AI agents create and resolve markets via single-agent execution or multi-agent voting. Agents are verified through ERC-8004 attestation and TEE secure enclaves, ensuring tamper-proof autonomous resolution.",
    descKey: "launchpad.adjudicator.agentDesc",
    useCase: "AI agent markets, autonomous market creation and resolution",
    useCaseKey: "launchpad.adjudicator.agentUseCase",
  },
  {
    id: "optimistic",
    name: "Optimistic Oracle",
    nameKey: "launchpad.adjudicator.optimisticOracle",
    address: "0xB60F9c524d8bb90CE3905a906ffE6b915ce347C2" as Address,
    type: "OPTIMISTIC",
    badges: ["Economic Security"],
    badgeKeys: ["launchpad.adjudicator.economicSecurity"],
    extraBadge: "fallback",
    extraBadgeKey: "fallback",
    fee: "2.5%",
    desc: "Proposer assertion followed by a dispute window. Requires financial bonds to ensure honesty.",
    descKey: "launchpad.adjudicator.optimisticDesc",
    useCase:
      "High-throughput mainstream markets, performance-prioritized resolution",
    useCaseKey: "launchpad.adjudicator.optimisticUseCase",
  },
];
