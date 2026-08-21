/** Barrel for the demo's chain-reading hooks. */

// ============================================================
// Market/AMM Hooks
// ============================================================

export { useAmmMarket, useAmmTradeCost } from "./useAmmMarket";
export type { AmmMarketData, AmmTradeCostData } from "./useAmmMarket";




export { useMarketStatsMath } from "./useMarketStatsMath";

// ============================================================
// Direct Read Hooks (more reliable than multicall)
// ============================================================
export {
  useDirectRead,
  readContractSafe,
  useInvalidateQueries,
} from "./useDirectRead";

export { useTruthMarketDirect } from "./useTruthMarketDirect";
export { useAmmMarketDirect } from "./useAmmMarketDirect";
export { useLaunchpadMarketDirect } from "./useLaunchpadMarketDirect";
export { useAMMPositionDirect } from "./useAMMPositionDirect";
export { useAMMQuoteDirect } from "./useAMMQuoteDirect";

// ============================================================
// Spendable Proceeds Hooks
// ============================================================
export { useAvailableBalance } from "./useAvailableBalance";
export type { AvailableBalanceData } from "./useAvailableBalance";
export { useTokenBalances } from "./useTokenBalances";

// ============================================================
// Launchpad Hooks
// ============================================================
export { useLaunchpadMarkets } from "./useLaunchpadMarkets";
export { useLockedProceeds } from "./useLockedProceeds";
export { useOnChainMarkets, useOnChainMarketCount } from "./useOnChainMarkets";
export { useVisibleMarkets } from "./useVisibleMarkets";
export { useNodeModeration } from "./useNodeModeration";
export type { OnChainMarket } from "./useOnChainMarkets";

// ============================================================
// Portfolio Hooks
// ============================================================
export { useActivePositions } from "./useActivePositions";
export { useLPPositions } from "./useLPPositions";
export { useLockedFunds } from "./useLockedFunds";
export { useTraderVault } from "./useTraderVault";

// ============================================================
// Utility Hooks
// ============================================================
export { useDeployments, getDeployments } from "./useDeployments";
export { useOrderbook } from "./useOrderbook";
export { useOrderbookTrade } from "./useOrderbookTrade";
