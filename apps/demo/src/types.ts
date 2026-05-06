/**
 * Core Protocol Types for Sooth Protocol V10
 * 
 * These types represent on-chain data structures and should match
 * the Solidity contracts exactly.
 */

// =============================================================================
// OUTCOME TYPES
// =============================================================================

/** Protocol-wide outcome encoding (matches TruthMarket.sol) */
export const OUTCOME = {
  NO: 0,
  YES: 1,
  INVALID: 2,
} as const;

export type OutcomeType = typeof OUTCOME[keyof typeof OUTCOME];

export type AdjudicatorKind =
  | 'UMA'
  | 'CHAINLINK'
  | 'TELLOR'
  | 'MULTISIG'
  | 'GOVERNANCE'
  | 'manual'
  | (string & {});

export interface MarketConfig {
  id: string;
  id_numeric?: number;
  version?: string;
  mode: 'demo' | 'real' | 'live';
  chainId?: number;
  name: string;
  symbol?: string;
  question?: string;
  description?: string;
  adjudicatorKind: AdjudicatorKind;
  adjudicatorLabel?: string;
  openEnded?: boolean;
  contractAddress?: `0x${string}`;
  outcomeTokenAddress?: `0x${string}`;
  adjudicatorId?: string;
  eventId?: string;
  initialStatus?: 'trading' | 'settled' | 'cooldown' | 'pending' | 'live' | 'expired';
  initialYes?: number;
  riskLevel?: string;
  bParam?: bigint | string;
}

export interface Market extends MarketConfig {
  status: 'trading' | 'settled' | 'cooldown' | 'pending' | 'live' | 'expired';
  priceYes: number;
  priceNo: number;
  bParam: bigint;
  virtualYesStake?: number;
  virtualNoStake?: number;
  userYesShares: number;
  userNoShares: number;
  userYesLocked?: number;
  userNoLocked?: number;
  userYesWallet?: number;
  userNoWallet?: number;
  userYesOutcomeTokens: number;
  userNoOutcomeTokens: number;
  userYesTotal?: number;
  userNoTotal?: number;
  unlockTime?: number;
  userAvgEntryYes: number | null;
  userAvgEntryNo: number | null;
  adjudicatorProofUploaded?: boolean;
  qYes: bigint;
  qNo: bigint;
  fee?: number;
  isLaunchpad?: boolean;
  isGraduated?: boolean;
  deadline?: number;
}

export interface PoolConfig {
  id: string;
  label: string;
  token: string;
  adjudicatorKind: AdjudicatorKind;
  mode?: 'demo' | 'real' | 'live';
}

export interface Pool extends PoolConfig {
  tvl: number;
  locked: number;
  apy: number;
  marketsExposed: number;
  userLpBalance: number;
}

export interface ProtocolConfig {
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface MarketsConfigJson {
  version?: string;
  markets: MarketConfig[];
}

// =============================================================================
// MARKET TYPES
// =============================================================================

/** Market lifecycle states (matches TruthMarket.sol) */
export type MarketState = 'CREATED' | 'ACTIVE' | 'SETTLING' | 'SETTLED';

/** TruthMarket on-chain data */
export interface TruthMarket {
  address: `0x${string}`;
  question: string;
  creator: `0x${string}`;
  adjudicator: `0x${string}`;
  guardian: `0x${string}`;
  deadline: bigint;
  startTime: bigint;
  state: MarketState;
  winningOutcome: OutcomeType;
  isSettled: boolean;
  isLive: boolean;
}

/** LaunchpadEngine market state (matches MarketState struct) */
export interface LaunchpadMarketState {
  market: `0x${string}`;
  creator: `0x${string}`;
  creatorDeposit: bigint;
  feesAccrued: bigint;
  lpTotalSupply: bigint;
  createdAt: bigint;
  graduatedAt: bigint;
  isGraduated: boolean;
}

// =============================================================================
// ORDER TYPES
// =============================================================================

export interface RangeOrder {
  id: bigint;
  owner: `0x${string}`;
  outcome: OutcomeType;
  tickLower: number;
  tickUpper: number;
  sharesTotal: bigint;
  filledShares: bigint;
  claimedShares: bigint;
  collateralWad: bigint;
  active: boolean;
  liquidityRemoved: boolean;
}

/** Order with computed tick info (UI helper) */
export interface OrderWithTicks extends RangeOrder {
  priceLow: number;
  priceHigh: number;
  avgPrice: number;
  remainingShares: bigint;
  fillPercent: number;
}

export interface SpotSellOrder {
  id: bigint;
  owner: `0x${string}`;
  outcome: OutcomeType;
  tickLower: number;
  tickUpper: number;
  sharesOffered: bigint;
  active: boolean;
  proceedsWad: bigint;
}

// =============================================================================
// POSITION TYPES
// =============================================================================

/** User position in AMM (pre-graduation) */
export interface AMMPosition {
  yesShares: bigint;
  noShares: bigint;
}

export interface VaultPosition {
  availableUsdc: bigint;
  reservedUsdc: bigint;
  yesShares: bigint;
  noShares: bigint;
}

/** LP position in LaunchpadEngine */
export interface LPPosition {
  lpTokens: bigint;
  depositedUsdc: bigint;
  currentValue: bigint;
}

// =============================================================================
// PRICE & LIQUIDITY TYPES
// =============================================================================

/** Tick represents a price level (1-999 = 0.1% to 99.9%) */
export type Tick = number;

/** Convert tick to price percentage (0.1 to 99.9) */
export function tickToPrice(tick: Tick): number {
  return tick / 10;
}

/** Convert price percentage to tick */
export function priceToTick(price: number): Tick {
  return Math.round(price * 10);
}

/** Liquidity bucket for orderbook visualization */
export interface LiquidityBucket {
  low: number;
  high: number;
  yesLiquidity: bigint;
  noLiquidity: bigint;
  totalLiquidity: bigint;
  dominantSide: 'yes' | 'no' | 'neutral';
}

// =============================================================================
// TRANSACTION TYPES
// =============================================================================

/** Trade direction */
export type TradeDirection = 'buy' | 'sell';

/** Order type for UI */
export type OrderType = 'market' | 'limit' | 'range';

/** Trade parameters */
export interface TradeParams {
  market: `0x${string}`;
  outcome: OutcomeType;
  shares: bigint;
  maxCost: bigint;
  tickLower?: Tick;
  tickUpper?: Tick;
}

// =============================================================================
// WAD MATH HELPERS
// =============================================================================

/** 1e18 - standard WAD precision */
export const WAD = 10n ** 18n;

/** 1e6 - USDC precision */
export const USDC_DECIMALS = 6;

/** Convert WAD to USDC (divide by 1e12) */
export function wadToUsdc(wad: bigint): bigint {
  return wad / 10n ** 12n;
}

/** Convert USDC to WAD (multiply by 1e12) */
export function usdcToWad(usdc: bigint): bigint {
  return usdc * 10n ** 12n;
}

/** Format WAD as display number */
export function formatWad(wad: bigint, decimals = 2): string {
  const num = Number(wad) / 1e18;
  return num.toFixed(decimals);
}

/** Format USDC as display number */
export function formatUsdc(usdc: bigint, decimals = 2): string {
  const num = Number(usdc) / 1e6;
  return num.toFixed(decimals);
}

// =============================================================================
// CONTRACT ADDRESSES TYPE
// =============================================================================

/** Deployed contract addresses for a chain */
export interface DeployedContracts {
  LaunchpadEngine: `0x${string}`;
  SoothBook?: `0x${string}`;
  AMMEngine: `0x${string}`;
  Collateralizer: `0x${string}`;
  MockUSDC: `0x${string}`;
}

// =============================================================================
// CHAIN TYPES
// =============================================================================

/** Supported chain IDs */
export type SupportedChainId = 84532 | 10143 | 6343 | 5042002;

/** Chain names */
export const CHAIN_NAMES: Record<SupportedChainId, string> = {
  84532: 'Base Sepolia',
  10143: 'Monad Testnet',
  6343: 'MegaETH Testnet',
  5042002: 'Arc Testnet',
};
