import { useMemo } from "react";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "@/lib/chain-shim";

type Address = `0x${string}`;

/**
 * Compute market key from pool key components
 * marketKey = keccak256(abi.encode(truthMarket, yesToken, noToken))
 * Must match the on-chain market key derivation formula
 */
export function computeMarketKey(
  truthMarket: Address,
  yesToken: Address,
  noToken: Address
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address, address, address"),
      [truthMarket, yesToken, noToken]
    )
  );
}

/**
 * Hook to compute and cache the market key
 */
export function useMarketKey(
  truthMarket: Address | undefined,
  yesToken: Address | undefined,
  noToken: Address | undefined
) {
  const marketKey = useMemo(() => {
    if (!truthMarket || !yesToken || !noToken) return undefined;
    return computeMarketKey(truthMarket, yesToken, noToken);
  }, [truthMarket, yesToken, noToken]);

  return { marketKey };
}
