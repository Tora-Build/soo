import { parseAbi } from "@/lib/chain-shim";
import {
  AMMEngineABI,
  CollateralizerABI,
  DynamicFeeHookABI,
  LaunchpadEngineABI,
  OutcomeTokenABI,
  TruthMarketABI,
} from "@/lib/chain-shim";

const ERC20_STRINGS = [
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export const ERC20_ABI = parseAbi(ERC20_STRINGS);

export const MOCK_ERC20_ABI = parseAbi([
  ...ERC20_STRINGS,
  "function mint(address to, uint256 amount)",
]);

export const MARKET_V4_ABI = parseAbi([
  "function qYes() view returns (int256)",
  "function qNo() view returns (int256)",
  "function _cost(int256 qYes, int256 qNo, uint256 b) view returns (int256)",
  "function b() view returns (uint256)",
  "function bBase() view returns (uint256)",
  "function feeLMSR() view returns (uint256)",
  "function price(uint8 outcome) view returns (uint256)",
  "function calculateAMMTradeCost(uint8 outcome, uint256 shares, bool isBuy) view returns (int256 cost, uint256 fee, int256 newQYes, int256 newQNo)",
  "function isLive() view returns (bool)",
  "function isSettled() view returns (bool)",
  "function yesBalance(address user) view returns (uint256)",
  "function noBalance(address user) view returns (uint256)",
  "function bestAsk() view returns (uint256)",
  "function bestBid() view returns (uint256)",
  "function orders(uint256 id) view returns (address maker, uint8 outcome, uint256 yesPrice, uint256 amount, bool isBuySide)",
  "function nextOrder(uint256 id) view returns (uint256)",
  "function outcomeToken() view returns (address)",
  "function merge(uint256 amount) returns (uint256 proceeds)",
  "function split(uint256 amount)",
]);

export const SOOTH_ADJUDICATOR_REGISTRY_ABI = parseAbi([
  "function isAdjudicator(address adjudicator) view returns (bool)",
  "function getAdjudicatorClass(address adjudicator) view returns (uint8)",
  "function setAdjudicator(address adjudicator, uint8 classId, bool enabled, bytes32 paramsHash)",
  "event AdjudicatorConfigured(address indexed adjudicator, uint8 classId, bool enabled, bytes32 paramsHash)",
]);

export const LAUNCHPAD_MARKET_ABI = parseAbi([
  "function qYes() view returns (int256)",
  "function qNo() view returns (int256)",
  "function b() view returns (uint256)",
  "function bBase() view returns (uint256)",
  "function price(uint8 outcome) view returns (uint256)",
  "function isLive() view returns (bool)",
  "function isSettled() view returns (bool)",
  "function winningOutcome() view returns (uint8)",
  "function adjudicator() view returns (address)",
  "function tStar() view returns (uint256)",
  "function yesBalance(address user) view returns (uint256)",
  "function noBalance(address user) view returns (uint256)",
  "function outcomeToken() view returns (address)",
  "function merge(uint256 amount) returns (uint256 proceeds)",
  "function split(uint256 amount)",
  "function isGraduated() view returns (bool)",
  "function graduationThreshold() view returns (uint256)",
  "function deadline() view returns (uint40)",
  "function creator() view returns (address)",
  "function factory() view returns (address)",
  "function totalLockedProceeds() view returns (uint256)",
  "function lockedProceeds(address user) view returns (uint256)",
  "function useLockedProceeds(address user, uint256 amount)",
  "function ammAssets() view returns (uint256)",
  "function pureCeilingAssets() view returns (uint256)",
  "function isUnderwater() view returns (bool)",
  "function totalAssets() view returns (uint256)",
  "function totalNetAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function graduate()",
  "function expire()",
  "function liquidate()",
  "function forceGraduate()",
  "function isLiquidated() view returns (bool)",
  "function claimLiquidationRefund(address user)",
  "function redeemLP(uint256 amount)",
  "function previewRedeemLP(uint256 amount) view returns (uint256)",
  "function claimUnlocked() returns (uint256 claimed)",
  "function claimLockedOnMarketEnd(uint256 maxSteps) returns (uint256 claimed)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function finalizeResolution(uint8 outcome, uint256 _tStar)",
  "event MarketGraduated(uint256 totalFeesAccrued, uint256 graduationTimestamp)",
  "event MarketSettled(uint8 outcome, uint256 tStar)",
  "event MarketLiquidated(uint256 liquidationFee, uint256 refundAmount)",
  "event LpTokensRedeemed(address indexed from, uint256 amount, uint256 assets)",
  "event Locked(address indexed user, uint256 amount, uint64 unlockTime)",
  "event TradeAMM(address indexed user, uint8 outcome, int256 deltaShares, int256 cost, uint256 fee)",
]);

export const LAUNCHPAD_QUOTER_ABI = parseAbi([
  "function calculateAMMTradeQuote(address market, uint8 outcome, uint256 shares, bool isBuy) view returns (int256 cost, uint256 fee, uint256 nextFloor, uint256 nextCeiling, uint256 priceImpactBps)",
]);

export const LAUNCHPAD_OUTCOME_TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function market() view returns (address)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function merge(uint256 amount)",
  "function split(uint256 amount)",
  "function yesBalance(address user) view returns (uint256)",
  "function noBalance(address user) view returns (uint256)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]);

export const SOOTH_MANUAL_ADJUDICATOR_ABI = parseAbi([
  "function resolve(address market, uint8 outcome, bytes32 dataHash, uint64 tStar)",
  "function settle(address market)",
  "function adjudicatorClass() view returns (uint8)",
  // AdjudicatorBase.MarketState — used by the operator UI to know which
  // EOA is the per-market resolver for a contract adjudicator. The
  // truthMarket.adjudicator field is the contract address, not the EOA;
  // resolve() reverts unless msg.sender == st.resolver.
  "struct AdjMarketState { uint8 phase; uint8 outcome; uint64 tStar; uint64 deadline; uint64 vetoEndsAt; address resolver; bytes32 dataHash; }",
  "function getMarketState(address market) view returns (AdjMarketState)",
]);

export const SOOTH_OPTIMISTIC_ADJUDICATOR_ABI = parseAbi([
  "function propose(address market, uint8 outcome, bytes32 dataHash, uint64 tStar)",
  "function dispute(address market)",
  "function finalize(address market)",
  "function proposals(address market) view returns (uint8 outcome, uint256 tStar, uint256 timestamp, address proposer, bool disputed)",
  "function adjudicatorClass() view returns (uint8)",
  "function challengeWindow() view returns (uint256)",
]);

export const SOOTHBOOK_ABI = parseAbi([
  // Write functions
  "function mint(bytes32 marketKey, uint256 amount)",
  "function merge(bytes32 marketKey, uint256 amount)",
  "function cancel(bytes32 marketKey, uint8 side, uint16 tick)",
  // View functions
  "function getBalance(bytes32 marketKey, address user) view returns (uint256 yes, uint256 no)",
  "function getBestTick(bytes32 marketKey, uint8 side) view returns (uint16)",
  "function getCollateralBacking(bytes32 marketKey) view returns (uint256)",
  "function getImpliedPrice(address market) view returns (uint256 yesPrice, uint256 noPrice)",
  "function getImpliedPriceByKey(bytes32 marketKey) view returns (uint256 yesPrice, uint256 noPrice)",
  "function isMarketRegistered(address market) view returns (bool)",
  "function registeredMarkets(bytes32 marketKey) view returns (bool)",
  "function getOrdersAtTick(bytes32 marketKey, uint8 side, uint16 tick) view returns (uint256 totalAmount, uint256 orderCount)",
  // Solana-only reads. The chain-shim routes by `functionName` and ignores the
  // address, but wagmi still parses the ABI, so an entry has to exist here for
  // the call to be issued at all.
  "function getBookAccount(bytes32 marketKey, address owner) view returns (uint256 credit, uint256 escrow, int256 net, uint256 openOrders)",
  "function bookWithdraw(bytes32 marketKey)",
  "function getSelfCrossExposure(bytes32 marketKey, address owner, uint8 side, uint16 tick, uint256 amount) view returns (bool crosses, uint256 own, uint256 others)",
  "function getMyOpenOrders(bytes32 marketKey, address owner) view returns (uint256[] seqs)",
  "function getMyOrderHistory(bytes32 marketKey, address owner) view returns (uint256[] rows)",
  "function feeBps() view returns (uint24)",
  "function feeRecipient() view returns (address)",
  "function owner() view returns (address)",
  // Events
  "event MarketCreated(bytes32 indexed marketKey, address collateral, address yesToken, address noToken)",
  "event OrderPlaced(bytes32 indexed marketKey, uint8 side, uint16 tick, address indexed maker, uint128 amount, bool escrow, uint64 orderId)",
  "event OrderFilled(bytes32 indexed marketKey, uint8 takerSide, uint16 yesTick, uint16 noTick, address indexed taker, address indexed maker, uint128 amount, uint256 surplus, uint64 makerOrderId)",
  "event OrderCancelled(bytes32 indexed marketKey, uint8 side, uint16 tick, address indexed maker, uint128 amount, uint64 orderId)",
  "event Minted(bytes32 indexed marketKey, address indexed user, uint256 amount)",
  "event Merged(bytes32 indexed marketKey, address indexed user, uint256 amount)",
  "event Redeemed(bytes32 indexed marketKey, address indexed user, uint256 payout)",
  "event MarketResolved(bytes32 indexed marketKey, uint8 outcome)",
  // Custom errors — must be in the ABI for viem to decode revert signatures
  // back to readable names (e.g. 0x1d4ecc5b → OrderNotActive).
  "error InvalidTick()",
  "error ZeroAmount()",
  "error MarketNotActive()",
  "error MarketAlreadyExists()",
  "error OrderNotActive()",
  "error ZeroAddress()",
  "error UnsupportedBaseTokenDecimals()",
  "error AmountTooSmallForBaseTokenDecimals()",
  "error InsufficientShares()",
  "error NotAuthorized()",
]);

// Minimal FeeRouter ABI — the deployed contract holds fee bps and graduation
// progress. These functions DO NOT exist on LaunchpadEngine (see BUG-003).
export const FEE_ROUTER_ABI = parseAbi([
  "function preGradFeeBps() view returns (uint24)",
  "function postGradFeeBps() view returns (uint24)",
  "function bBaseShareBps() view returns (uint16)",
  "function lpYieldShareBps() view returns (uint16)",
  "function adjudicatorShareBps() view returns (uint16)",
  "function protocolShareBps() view returns (uint16)",
  "function getGraduationProgress(address market) view returns (uint256 feesAccrued, uint256 threshold, uint256 progressBps)",
]);

export const ABIS = {
  AMMEngine: AMMEngineABI,
  Collateralizer: CollateralizerABI,
  DynamicFeeHook: DynamicFeeHookABI,
  LaunchpadEngine: LaunchpadEngineABI,
  OutcomeToken: OutcomeTokenABI,
  TruthMarket: TruthMarketABI,
  SoothBook: SOOTHBOOK_ABI,
  FeeRouter: FEE_ROUTER_ABI,
} as const;
