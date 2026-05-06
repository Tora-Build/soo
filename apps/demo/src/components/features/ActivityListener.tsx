import { useMemo } from "react";
import { useAccount, useConfig, useWatchContractEvent } from "@/lib/chain-shim";
import { formatUnits } from "@/lib/chain-shim";
import { ABIS } from "../../config/abis";
import { useDeployments } from "../../hooks/useDeployments";
import { useChainStore } from "../../store/useChainStore";
import { useMarketStore } from "../../store/useMarketStore";
import { useActivityStore } from "../../store/useActivityStore";
import marketsConfig from "../../config/markets.json";

type Address = `0x${string}`;

function toAddressLower(a?: string) {
  return (a ?? "").toLowerCase();
}

function resolveMarketNameByAddress(
  marketAddress: string,
  chainId: number | undefined,
): string {
  const list = Array.isArray(marketsConfig)
    ? (marketsConfig as any)
    : (marketsConfig as any).markets || [];
  const m = list.find((x: any) => {
    if (!x?.contractAddress) return false;
    if (chainId && x.chainId && Number(x.chainId) !== Number(chainId))
      return false;
    return toAddressLower(x.contractAddress) === toAddressLower(marketAddress);
  });
  return m?.name || marketAddress;
}

/**
 * V8 ActivityListener
 * - Watches V8 core contract events for the connected wallet only
 * - Appends them to `useActivityStore` for persistence
 */
export function ActivityListener() {
  const { addActivity } = useActivityStore();
  const { mode } = useMarketStore();
  const { address: userAddress } = useAccount();
  const { selectedChainId } = useChainStore();
  const chainId = Number(selectedChainId);
  const { contracts } = useDeployments();
  const wagmiConfig = useConfig();

  const launchpadEngine = contracts.LaunchpadEngine as Address | undefined;
  const ammEngine = contracts.AMMEngine as Address | undefined;

  // Chains that either (a) don't support eth_newFilter or (b) enforce a
  // strict eth_getLogs block-range cap that viem's filter-catchup polling
  // exceeds, triggering repeated 400s from the RPC. Disable the activity
  // listener entirely on these chains — users still see their activity via
  // the indexer, this is only for the in-session real-time feed.
  //   Monad 10143:   QuickNode private RPC has no eth_newFilter
  //   MegaETH 6343:  Alchemy rejects eth_getLogs over 10k blocks
  //   HyperEVM 998:  Public RPC rejects eth_getLogs over 1k blocks
  const ACTIVITY_LISTENER_BLOCKED = new Set<number>([10143, 6343, 998]);
  const isBlockedChain = ACTIVITY_LISTENER_BLOCKED.has(chainId);
  // `useWatchContractEvent` throws ChainNotConfiguredError if `chainId` isn't
  // in the current wagmi config (e.g. test mode only bundles Base Sepolia but
  // the chain store may still hold MegaETH from a prior session).
  const isChainSupported = useMemo(
    () => wagmiConfig.chains.some((c) => c.id === chainId),
    [wagmiConfig.chains, chainId],
  );
  const enabled =
    mode === "real" &&
    !!userAddress &&
    !!chainId &&
    !isBlockedChain &&
    isChainSupported;

  const userTopic = useMemo(
    () => userAddress as Address | undefined,
    [userAddress],
  );

  // ----------------------------
  // LaunchpadEngine events
  // ----------------------------

  useWatchContractEvent({
    address: ammEngine,
    chainId,
    abi: ABIS.AMMEngine,
    eventName: "PositionTraded",
    // trader is indexed; filter server-side when possible.
    args: userTopic ? { user: userTopic } : undefined,
    enabled: enabled && !!ammEngine,
    onLogs: (logs) => {
      logs.forEach((log: any) => {
        const trader = log?.args?.user as string | undefined;
        if (!trader || toAddressLower(trader) !== toAddressLower(userAddress))
          return;

        const market = log?.args?.market as string | undefined;
        const deltaShares =
          (log?.args?.deltaShares as bigint | undefined) ?? 0n;
        const outcomeText = deltaShares >= 0n ? "YES" : "NO";
        const sharesAbs = deltaShares >= 0n ? deltaShares : -deltaShares;
        const shares = Number(formatUnits(sharesAbs, 18));
        const isBuy = deltaShares > 0n;

        addActivity({
          type: "trade",
          market: resolveMarketNameByAddress(
            market ?? "Unknown Market",
            chainId,
          ),
          description: `${isBuy ? "Bought" : "Sold"} ${shares.toFixed(2)} ${outcomeText} shares`,
          hash: log.transactionHash,
          mode: "real",
          timestamp: Date.now(),
          chainId,
        });
      });
    },
  });

  useWatchContractEvent({
    address: launchpadEngine,
    chainId,
    abi: ABIS.LaunchpadEngine,
    eventName: "MarketCreated",
    enabled: enabled && !!launchpadEngine,
    onLogs: (logs) => {
      logs.forEach((log: any) => {
        const creator = log?.args?.creator as string | undefined;
        if (!creator || toAddressLower(creator) !== toAddressLower(userAddress))
          return;
        const market = log?.args?.market as string | undefined;
        addActivity({
          type: "admin",
          market: resolveMarketNameByAddress(
            market ?? "Unknown Market",
            chainId,
          ),
          description: "Created market (LaunchpadEngine initialized)",
          hash: log.transactionHash,
          mode: "real",
          timestamp: Date.now(),
          chainId,
        });
      });
    },
  });

  useWatchContractEvent({
    address: launchpadEngine,
    chainId,
    abi: ABIS.LaunchpadEngine,
    eventName: "MarketGraduated",
    enabled: enabled && !!launchpadEngine,
    onLogs: (logs) => {
      logs.forEach((log: any) => {
        const market = log?.args?.market as string | undefined;
        addActivity({
          type: "settle",
          market: resolveMarketNameByAddress(
            market ?? "Unknown Market",
            chainId,
          ),
          description: "Market graduated",
          hash: log.transactionHash,
          mode: "real",
          timestamp: Date.now(),
          chainId,
        });
      });
    },
  });

  useWatchContractEvent({
    address: launchpadEngine,
    chainId,
    abi: ABIS.LaunchpadEngine,
    eventName: "LPRedeemed",
    args: userTopic ? { user: userTopic } : undefined,
    enabled: enabled && !!launchpadEngine,
    onLogs: (logs) => {
      logs.forEach((log: any) => {
        const user = log?.args?.user as string | undefined;
        if (!user || toAddressLower(user) !== toAddressLower(userAddress))
          return;
        const market = log?.args?.market as string | undefined;
        const usdcAmount = (log?.args?.usdcAmount as bigint | undefined) ?? 0n;
        addActivity({
          type: "liquidity",
          market: resolveMarketNameByAddress(
            market ?? "Unknown Market",
            chainId,
          ),
          description: `Redeemed LP for ${formatUnits(usdcAmount, 6)} USDC`,
          hash: log.transactionHash,
          mode: "real",
          timestamp: Date.now(),
          chainId,
        });
      });
    },
  });

  useWatchContractEvent({
    address: ammEngine,
    chainId,
    abi: ABIS.AMMEngine,
    eventName: "LiquidityIncreased",
    args: undefined,
    enabled: enabled && !!ammEngine,
    onLogs: (logs) => {
      logs.forEach((log: any) => {
        const market = log?.args?.market as string | undefined;
        const amount = (log?.args?.deltaLiquidity as bigint | undefined) ?? 0n;
        addActivity({
          type: "liquidity",
          market: resolveMarketNameByAddress(
            market ?? "Unknown Market",
            chainId,
          ),
          description: `Increased liquidity by ${formatUnits(amount, 6)} USDC`,
          hash: log.transactionHash,
          mode: "real",
          timestamp: Date.now(),
          chainId,
        });
      });
    },
  });

  // ----------------------------
  // AMMEngine events (spendable/locked proceeds)
  // ----------------------------

  useWatchContractEvent({
    address: ammEngine,
    chainId,
    abi: ABIS.AMMEngine,
    eventName: "ProceedsLocked",
    args: userTopic ? { user: userTopic } : undefined,
    enabled: enabled && !!ammEngine,
    onLogs: (logs) => {
      logs.forEach((log: any) => {
        const user = log?.args?.user as string | undefined;
        if (!user || toAddressLower(user) !== toAddressLower(userAddress))
          return;
        const market = log?.args?.market as string | undefined;
        const amount = (log?.args?.amount as bigint | undefined) ?? 0n;
        addActivity({
          type: "claim",
          market: resolveMarketNameByAddress(
            market ?? "Unknown Market",
            chainId,
          ),
          description: `Proceeds locked (24h): ${formatUnits(amount, 18)} USDC`,
          hash: log.transactionHash,
          mode: "real",
          timestamp: Date.now(),
          chainId,
        });
      });
    },
  });

  useWatchContractEvent({
    address: ammEngine,
    chainId,
    abi: ABIS.AMMEngine,
    eventName: "ProceedsClaimed",
    args: userTopic ? { user: userTopic } : undefined,
    enabled: enabled && !!ammEngine,
    onLogs: (logs) => {
      logs.forEach((log: any) => {
        const user = log?.args?.user as string | undefined;
        if (!user || toAddressLower(user) !== toAddressLower(userAddress))
          return;
        const market = log?.args?.market as string | undefined;
        const amount = (log?.args?.amount as bigint | undefined) ?? 0n;
        addActivity({
          type: "claim",
          market: resolveMarketNameByAddress(market ?? "AMMEngine", chainId),
          description: `Unlocked proceeds claimed: ${formatUnits(amount, 18)} USDC`,
          hash: log.transactionHash,
          mode: "real",
          timestamp: Date.now(),
          chainId,
        });
      });
    },
  });

  return null;
}
