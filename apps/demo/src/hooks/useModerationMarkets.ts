import { useMemo } from "react";
import marketsConfigRaw from "../config/markets.json";
import { CATEGORY_LABELS, inferCategory } from "../lib/categories";
import { useNodeModeration } from "./useNodeModeration";
import { useOnChainMarkets } from "./useOnChainMarkets";

interface MarketConfig {
  id: string;
  name: string;
  symbol: string;
  description?: string;
  contractAddress: string;
  chainId: number;
  version?: string;
  category?: string;
}

interface MarketsConfigJson {
  markets: MarketConfig[];
}

const marketsConfig = marketsConfigRaw as MarketsConfigJson;

export const MODERATION_CATEGORY_LABELS = CATEGORY_LABELS;

const staticMarketIndex = new Map(
  marketsConfig.markets.map((market) => [
    market.contractAddress.toLowerCase(),
    market,
  ]),
);

const getStoredMarketMeta = (address: string) => {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(
      `market_meta_${address.toLowerCase()}`,
    );
    return stored
      ? (JSON.parse(stored) as { category?: string; name?: string })
      : null;
  } catch {
    return null;
  }
};

const normalizeCreatedAtMs = (value: bigint) => {
  if (value <= 0n) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
};

export interface ModerationMarketRow {
  address: `0x${string}`;
  addressLower: string;
  question: string;
  category: string;
  createdAtMs: number | null;
  visibility: "showing" | "hidden";
  creator: `0x${string}`;
  stage: "bonding" | "expired" | "live" | "settled" | "finalized" | "dismissed";
}

export function useModerationMarkets() {
  const { markets: allMarkets, isLoading } = useOnChainMarkets();
  const { hiddenMarkets, hiddenMarketSet } = useNodeModeration();

  const rows = useMemo(() => {
    return allMarkets.map((market) => {
      const staticMarket = staticMarketIndex.get(market.address.toLowerCase());
      const storedMeta = getStoredMarketMeta(market.address);
      const question =
        staticMarket?.name || storedMeta?.name || market.question;
      const category =
        (staticMarket?.category ||
          market.category?.toLowerCase() ||
          storedMeta?.category?.toLowerCase() ||
          inferCategory(question)) ??
        "others";
      const addressLower = market.address.toLowerCase();

      return {
        address: market.address,
        addressLower,
        question,
        category,
        createdAtMs: normalizeCreatedAtMs(market.createdAt),
        visibility: hiddenMarketSet.has(addressLower) ? "hidden" : "showing",
        creator: market.creator,
        stage: market.stage,
      } satisfies ModerationMarketRow;
    });
  }, [allMarkets, hiddenMarketSet]);

  return {
    rows,
    isLoading,
    hiddenCount: hiddenMarkets.length,
    showingCount: rows.filter((r) => r.visibility === "showing").length,
  };
}
