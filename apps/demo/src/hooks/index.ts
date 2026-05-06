/**
 * Hooks Index - Flat structure
 *
 * All hooks are now at the root level with clear naming.
 * No versioned folders (v5/, v8/, v9/) - use descriptive names instead.
 */

// ============================================================
// Market/AMM Hooks
// ============================================================
export { useTruthMarket } from "./useTruthMarket";
export type { TruthMarketData } from "./useTruthMarket";

export { useAmmMarket, useAmmTradeCost } from "./useAmmMarket";
export type { AmmMarketData, AmmTradeCostData } from "./useAmmMarket";

export { useLaunchpadMarket } from "./useLaunchpadMarket";
export type { LaunchpadMarketData } from "./useLaunchpadMarket";

export { useCollateralizer, useOutcomeToken } from "./useCollateralizer";
export type { CollateralizerData, OutcomeTokenData } from "./useCollateralizer";

export { useCreatorPosition, useIsCreator } from "./useCreatorPosition";
export type { CreatorPositionData } from "./useCreatorPosition";

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
export { useLaunchpadPositionDirect } from "./useLaunchpadPositionDirect";
export { useAMMPositionDirect } from "./useAMMPositionDirect";
export { useCollateralizerDirect } from "./useCollateralizerDirect";
export { useAMMQuoteDirect } from "./useAMMQuoteDirect";
export { useDynamicFee } from "./useDynamicFee";
export { useMarketKey } from "./useMarketKey";

// ============================================================
// Spendable Proceeds Hooks
// ============================================================
export { useAvailableBalance } from "./useAvailableBalance";
export type { AvailableBalanceData } from "./useAvailableBalance";
export { useLockQueue } from "./useLockQueue";
export type { LockQueueData, LockEntry } from "./useLockQueue";
export { useClaimableAmount } from "./useClaimableAmount";
export type { ClaimableAmountData } from "./useClaimableAmount";
export { useClaimUnlocked } from "./useClaimUnlocked";
export type { ClaimUnlockedData } from "./useClaimUnlocked";
export { useTokenBalances } from "./useTokenBalances";

// ============================================================
// Launchpad Hooks
// ============================================================
export { useLaunchpadMarkets } from "./useLaunchpadMarkets";
export { useLaunchpadSwap } from "./useLaunchpadSwap";
export { useLaunchpadTradeQuote } from "./useLaunchpadTradeQuote";
export { useLPHolders } from "./useLPHolders";
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
export { useSoothBookMarket } from "./useSoothBook";
export { useSoothBookFeed } from "./useSoothBookFeed";
export { useSoothBookMarkets } from "./useSoothBookMarkets";
export type { IndexedMarket } from "./useSoothBookMarkets";
export type { SoothBookMarketState, SoothBookPrices } from "./useSoothBook";

// ============================================================
// Price History Hooks
// ============================================================
export { useSoothBookPriceHistory } from "./useSoothBookPriceHistory";
export type { CandleInterval, PriceCandle } from "./useSoothBookPriceHistory";
export { useAmmPriceHistory } from "./useAmmPriceHistory";
