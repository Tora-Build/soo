/**
 * Operator Page - Unified Dashboard for Protocol Operators
 *
 * Combines Adjudicator, Guardian, and Owner roles into a single interface.
 * Features: Role-based sidebar navigation, settlement, veto, protocol settings
 */
import { useState, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Gavel,
  Settings,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Eye,
  RefreshCw,
  Filter,
  Download,
  Info,
  BookOpen,
} from "lucide-react";
import { StageBadge } from "../components/ui/StageBadge";
import {
  useAccount,
  useChainId,
  useReadContracts,
  useReadContract,
  useWriteContract,
  usePublicClient,
} from "@/lib/chain-shim";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { useTruthMarketDirect } from "../hooks";
import { useDeployments } from "../hooks/useDeployments";
import { useLaunchpadMarkets } from "../hooks/useLaunchpadMarkets";
import { ABIS, SOOTH_MANUAL_ADJUDICATOR_ABI } from "../config/abis";
import { cn } from "../lib/utils";
import {
  MODERATION_CATEGORY_LABELS,
  useModerationMarkets,
} from "../hooks/useModerationMarkets";
import { useNodeModeration } from "../hooks/useNodeModeration";
import { updateHiddenMarkets } from "../lib/registry";
import { CATEGORY_IDS } from "../lib/categories";
import marketsConfigRaw from "../config/markets.json";

interface MarketConfig {
  id: string;
  name: string;
  symbol: string;
  description?: string;
  contractAddress: string;
  chainId: number;
  version?: string;
}

interface MarketsConfigJson {
  markets: MarketConfig[];
}

const marketsConfig = marketsConfigRaw as MarketsConfigJson;

type Section = "adjudicator" | "owner" | "editor";
type AdjudicatorTab = "ready" | "pending" | "history";
type VisibilityFilter = "all" | "showing" | "hidden";
type StageFilter =
  | "all"
  | "bonding"
  | "live"
  | "settled"
  | "finalized"
  | "dismissed";
type MarketVisibilitySort =
  | "time-desc"
  | "time-asc"
  | "creator-asc"
  | "category-asc"
  | "status";

const REGISTRY_TOKEN_STORAGE_KEY = "sooth:registry-admin-token";

const MARKET_STAGE_LABELS: Record<Exclude<StageFilter, "all">, string> = {
  bonding: "Bonding",
  live: "Live",
  settled: "Resolved",
  finalized: "Settled",
  dismissed: "Dismissed",
};

// ============================================
// Educational Content
// ============================================

const RoleEducation: React.FC<{ role: Section }> = ({ role }) => {
  const content = {
    adjudicator: {
      title: "Adjudicator Guide",
      description:
        "Adjudicators are trusted entities responsible for determining the outcome of prediction markets. When a market reaches its deadline, the adjudicator submits the final result (YES, NO, or INVALID).",
      responsibilities: [
        "Monitor markets assigned to you for deadline expiry",
        "Research and verify the actual outcome of events",
        "Submit settlement transactions with the correct outcome",
        "Respond promptly to avoid delayed payouts for traders",
      ],
      warning:
        "Incorrect settlements can be vetoed by the Guardian during the finalization window.",
    },
    owner: {
      title: "Owner Guide",
      description:
        "The Protocol Owner has administrative control over protocol parameters. This role is typically held by a multisig or DAO to ensure decentralized governance.",
      responsibilities: [
        "Configure fee parameters (bonding fee, trading fee)",
        "Set fee distribution ratios (liquidity, LP yield, treasury)",
        "Adjust graduation multiplier for market maturity",
        "Emergency pause the protocol if critical issues arise",
      ],
      warning:
        "Changes to protocol parameters affect all markets. Test on testnet before applying to mainnet.",
    },
    editor: {
      title: "Editor Guide",
      description:
        "Shared content controls for the current registry node. Use this page to hide stale or disallowed markets from node-driven discovery and trading views.",
      responsibilities: [
        "Filter and review markets before changing visibility",
        "Batch hide or show selected markets",
        "Maintain node-specific content standards for all users",
      ],
      warning:
        "Visibility changes apply to everyone using this registry node as soon as the registry write succeeds.",
    },
  };

  const c = content[role];

  return (
    <Card className="bg-raised/30 border-rule">
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-muted" />
          <h3 className="font-bold text-ink">{c.title}</h3>
        </div>
        <p className="text-sm text-muted">{c.description}</p>
        <div>
          <p className="font-mono text-xs text-muted uppercase tracking-[0.12em] mb-2">
            Responsibilities
          </p>
          <ul className="space-y-1.5">
            {c.responsibilities.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-ink">
                <CheckCircle className="w-4 h-4 text-ink mt-0.5 shrink-0" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="p-3 bg-accent-muted border border-accent/20">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-accent mt-0.5 shrink-0" />
            <p className="text-xs text-muted">{c.warning}</p>
          </div>
        </div>
      </div>
    </Card>
  );
};

// ============================================
// Adjudicator Components
// ============================================

interface AdjudicatorMarketRowProps {
  market: MarketConfig;
  userAddress?: string;
  tab: AdjudicatorTab;
}

const AdjudicatorMarketRow: React.FC<AdjudicatorMarketRowProps> = ({
  market,
  userAddress,
  tab,
}) => {
  const {
    market: truthMarket,
    isLoading,
    refetch: refetchTruthMarket,
  } = useTruthMarketDirect(market.contractAddress as `0x${string}`);
  const [selectedOutcome, setSelectedOutcome] = useState<number | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isSettling, setIsSettling] = useState(false);

  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const qc = useQueryClient();

  // The truthMarket.adjudicator field is the *contract* address for v0.2.0
  // markets (e.g. ManualAdjudicator). resolve() reverts unless the caller
  // is the per-market resolver EOA stored inside that contract. Read it
  // here so the gate matches the on-chain auth check.
  const adjudicatorAddr = truthMarket?.adjudicator as `0x${string}` | undefined;
  const adjMarketStateQuery = useReadContract({
    address: adjudicatorAddr,
    abi: SOOTH_MANUAL_ADJUDICATOR_ABI,
    functionName: "getMarketState",
    args: market.contractAddress
      ? [market.contractAddress as `0x${string}`]
      : undefined,
    query: { enabled: !!adjudicatorAddr && !!market.contractAddress },
  });
  const eoaResolver = (
    adjMarketStateQuery.data as { resolver?: `0x${string}` } | undefined
  )?.resolver;

  const isAdjudicator =
    !!userAddress &&
    (userAddress.toLowerCase() === adjudicatorAddr?.toLowerCase() ||
      userAddress.toLowerCase() === eoaResolver?.toLowerCase());

  const isSettled = truthMarket?.isSettled ?? false;
  const isLive = truthMarket?.isLive ?? false;
  const deadline = truthMarket?.deadline ?? 0;
  const now = Date.now() / 1000;
  const isPastDeadline = deadline > 0 && now > deadline;
  // Resolve is callable while LIVE and deadline hasn't passed
  // (AdjudicatorBase requires `block.timestamp < deadline + invalidationBuffer`).
  const canResolveNow = isLive && !isSettled && !isPastDeadline;

  // Phase 2 = RESOLVED, 3 = ATTESTED, 4 = SETTLED. A "pending" market is
  // resolved-but-not-yet-settled — Settle becomes callable once block.timestamp
  // reaches vetoEndsAt (per AdjudicatorBase:182).
  const adjState = adjMarketStateQuery.data as
    | {
        phase: number;
        vetoEndsAt: bigint;
      }
    | undefined;
  const phase = adjState?.phase ?? 0;
  const vetoEndsAt = Number(adjState?.vetoEndsAt ?? 0n);
  const isPendingSettle = (phase === 2 || phase === 3) && !isSettled;
  const canSettleNow = isPendingSettle && now >= vetoEndsAt;

  if (tab === "ready" && (!canResolveNow || !isAdjudicator)) return null;
  if (tab === "pending" && (!isPendingSettle || !isAdjudicator)) return null;
  if (tab === "history" && !isSettled) return null;

  const handleResolve = async () => {
    if (selectedOutcome === null) return;
    if (!adjudicatorAddr) {
      toast.error("No adjudicator on this market");
      return;
    }
    setIsResolving(true);
    const toastId = toast.loading("Resolving market...");
    try {
      const tStar = BigInt(Math.floor(Date.now() / 1000));
      const dataHash =
        "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      // For v0.2.0 the adjudicator is always a contract — use the
      // adjudicator's resolve() entry point. The on-chain auth check
      // verifies msg.sender === st.resolver.
      const hash = await writeContractAsync({
        address: adjudicatorAddr,
        abi: SOOTH_MANUAL_ADJUDICATOR_ABI,
        functionName: "resolve",
        args: [
          market.contractAddress as `0x${string}`,
          selectedOutcome,
          dataHash,
          tStar,
        ],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      toast.success("Market resolved", { id: toastId });
      // RPC reads can lag behind tx confirmation by 1–3s on some proxies
      // (HE in particular). Poll the chain directly until isLive flips
      // false, then refetch the row's queries + invalidate the global
      // cache. Without the poll the row would re-render with the cached
      // pre-resolve state and the user would have to manually refresh.
      if (publicClient) {
        const start = Date.now();
        while (Date.now() - start < 10_000) {
          const liveNow = (await publicClient.readContract({
            address: market.contractAddress as `0x${string}`,
            abi: ABIS.TruthMarket,
            functionName: "isLive",
          })) as boolean;
          if (!liveNow) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      await Promise.all([refetchTruthMarket(), adjMarketStateQuery.refetch()]);
      await qc.invalidateQueries();
    } catch (err: unknown) {
      const msg =
        (err as Error)?.message?.split("\n")[0] ?? "Resolution failed";
      toast.error(msg, { id: toastId });
    } finally {
      setIsResolving(false);
    }
  };

  const handleSettle = async () => {
    if (!adjudicatorAddr) {
      toast.error("No adjudicator on this market");
      return;
    }
    setIsSettling(true);
    const toastId = toast.loading("Settling market...");
    try {
      // settle() is permissionless after vetoEndsAt — anyone can call.
      // The adjudicator transitions phase RESOLVED/ATTESTED → SETTLED
      // and TruthMarket.isSettled flips true (per AdjudicatorBase:166).
      const hash = await writeContractAsync({
        address: adjudicatorAddr,
        abi: SOOTH_MANUAL_ADJUDICATOR_ABI,
        functionName: "settle",
        args: [market.contractAddress as `0x${string}`],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      toast.success("Market settled", { id: toastId });
      // Poll until isSettled flips true on-chain to outpace any
      // proxy/read-RPC propagation lag, then refetch + invalidate.
      if (publicClient) {
        const start = Date.now();
        while (Date.now() - start < 10_000) {
          const settledNow = (await publicClient.readContract({
            address: market.contractAddress as `0x${string}`,
            abi: ABIS.TruthMarket,
            functionName: "isSettled",
          })) as boolean;
          if (settledNow) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      await Promise.all([refetchTruthMarket(), adjMarketStateQuery.refetch()]);
      await qc.invalidateQueries();
    } catch (err: unknown) {
      const msg = (err as Error)?.message?.split("\n")[0] ?? "Settle failed";
      toast.error(msg, { id: toastId });
    } finally {
      setIsSettling(false);
    }
  };

  if (isLoading) {
    return (
      <tr className="border-b border-rule">
        <td colSpan={4} className="py-3 px-4">
          <div className="h-4 bg-raised/50 rounded w-full" />
        </td>
      </tr>
    );
  }

  const winningOutcome = truthMarket?.winningOutcome;
  const outcomeLabel =
    winningOutcome === 1
      ? "YES"
      : winningOutcome === 0
        ? "NO"
        : winningOutcome === 2
          ? "INVALID"
          : "—";
  const timeToDeadline = deadline - now;
  const daysLeft = Math.floor(timeToDeadline / 86400);
  const hoursLeft = Math.floor((timeToDeadline % 86400) / 3600);

  return (
    <tr
      data-testid={`operator-market-row-${market.contractAddress.toLowerCase()}`}
      className="border-b border-rule hover:bg-raised/30 transition-colors"
    >
      <td className="py-4 px-4">
        <div>
          <Link
            to={`/amm/${market.contractAddress}`}
            className="font-medium text-ink hover:text-accent transition-colors"
          >
            {market.symbol}
          </Link>
          <p className="text-xs text-muted mt-0.5 truncate max-w-xs">
            {(market as any).question || market.name}
          </p>
        </div>
      </td>
      <td className="py-4 px-4">
        {tab === "ready" ? (
          <Badge variant="warning">
            <Clock className="w-3 h-3 mr-1" />
            Ready
          </Badge>
        ) : tab === "pending" ? (
          <Badge variant="outline" className="text-accent border-accent/50">
            <RefreshCw className="w-3 h-3 mr-1" />
            Pending
          </Badge>
        ) : (
          <Badge
            variant={
              outcomeLabel === "YES"
                ? "success"
                : outcomeLabel === "NO"
                  ? "warning"
                  : "default"
            }
          >
            {outcomeLabel}
          </Badge>
        )}
      </td>
      <td className="py-4 px-4 text-sm text-muted">
        {tab === "ready" ? (
          isPastDeadline ? (
            <span className="text-muted">
              {Math.abs(daysLeft)}d {Math.abs(hoursLeft)}h overdue
            </span>
          ) : (
            <span>
              {daysLeft}d {hoursLeft}h left
            </span>
          )
        ) : tab === "pending" ? (
          <span className="text-accent">In veto window</span>
        ) : (
          new Date((truthMarket?.tStar || 0) * 1000).toLocaleDateString()
        )}
      </td>
      <td className="py-4 px-4">
        {tab === "ready" ? (
          <div className="flex items-center gap-2">
            <select
              data-testid="operator-outcome-select"
              value={selectedOutcome ?? ""}
              onChange={(e) =>
                setSelectedOutcome(
                  e.target.value ? parseInt(e.target.value) : null,
                )
              }
              className="input-field text-xs py-1 px-2 w-24"
            >
              <option value="">Select...</option>
              <option value="1">YES</option>
              <option value="0">NO</option>
              <option value="2">INVALID</option>
            </select>
            <Button
              data-testid="operator-resolve-button"
              size="xs"
              variant="primary"
              onClick={handleResolve}
              disabled={selectedOutcome === null || isResolving}
            >
              <Gavel className="w-3 h-3 mr-1" />
              {isResolving ? "Resolving…" : "Resolve"}
            </Button>
          </div>
        ) : tab === "pending" ? (
          <Button
            data-testid="operator-settle-button"
            size="xs"
            variant="primary"
            onClick={handleSettle}
            disabled={!canSettleNow || isSettling}
            title={
              canSettleNow
                ? "Move to SETTLED phase + finalize TruthMarket"
                : `Veto window still active until ${new Date(vetoEndsAt * 1000).toLocaleTimeString()}`
            }
          >
            <Gavel className="w-3 h-3 mr-1" />
            {isSettling ? "Settling…" : canSettleNow ? "Settle" : "Veto window"}
          </Button>
        ) : (
          <Link to={`/amm/${market.contractAddress}`}>
            <Button size="xs" variant="ghost">
              <Eye className="w-3 h-3 mr-1" />
              View
            </Button>
          </Link>
        )}
      </td>
    </tr>
  );
};

// ============================================
// Guardian Components
// ============================================

interface FinalizedRowProps {
  market: MarketConfig;
}

const FinalizedRow: React.FC<FinalizedRowProps> = ({ market }) => {
  const { market: truthMarket, isLoading } = useTruthMarketDirect(
    market.contractAddress as `0x${string}`,
  );

  if (isLoading) {
    return (
      <tr className="border-b border-rule">
        <td colSpan={6} className="py-3 px-4">
          <div className="h-4 bg-raised/50 rounded w-full" />
        </td>
      </tr>
    );
  }

  if (!truthMarket?.isSettled) return null;

  const outcomeLabel =
    truthMarket.winningOutcome === 1
      ? "YES"
      : truthMarket.winningOutcome === 0
        ? "NO"
        : "INVALID";
  const tStar = truthMarket.tStar;
  const finalizedDate = tStar ? new Date(tStar * 1000) : new Date();
  const settler =
    truthMarket.adjudicator || "0x0000000000000000000000000000000000000000";
  const isVetoed = truthMarket.isVetoed;

  return (
    <tr className="border-b border-rule hover:bg-raised/30 transition-colors">
      <td className="py-3 px-4">
        <Link
          to={`/amm/${market.contractAddress}`}
          className="hover:text-ink transition-colors"
        >
          {market.symbol}
        </Link>
      </td>
      <td className="py-3 px-4">
        <Badge
          variant={
            outcomeLabel === "YES"
              ? "success"
              : outcomeLabel === "NO"
                ? "warning"
                : "default"
          }
        >
          {outcomeLabel}
        </Badge>
      </td>
      <td className="py-3 px-4 font-mono text-xs text-muted">
        {settler.slice(0, 6)}...{settler.slice(-4)}
      </td>
      <td className="py-3 px-4 text-muted text-sm">
        {finalizedDate.toLocaleDateString()}
      </td>
      <td className="py-3 px-4">
        {isVetoed ? (
          <Badge variant="warning">Vetoed</Badge>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="py-3 px-4">
        <Link to={`/amm/${market.contractAddress}`}>
          <Button size="xs" variant="ghost">
            <Eye className="w-3 h-3" />
          </Button>
        </Link>
      </td>
    </tr>
  );
};

const formatShortAddress = (address?: string | null) => {
  if (!address) return "Unknown";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
};

const formatCreatedAtLabel = (createdAtMs: number | null) => {
  if (!createdAtMs) return "Time Unknown";
  return new Date(createdAtMs).toLocaleString();
};

const VisibilitySwitch = ({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={checked ? "Hide market" : "Show market"}
    disabled={disabled}
    onClick={onChange}
    className={cn(
      "relative inline-flex h-6 w-14 shrink-0 items-center rounded-full border transition-colors",
      checked ? "border-pos bg-pos" : "border-neg bg-neg",
      disabled && "cursor-not-allowed opacity-50",
    )}
  >
    <span
      className={cn(
        "absolute top-0.5 h-[18px] w-[18px] rounded-full bg-ink transition-transform",
        checked ? "translate-x-8" : "translate-x-1",
      )}
    />
  </button>
);

const MarketVisibilityPanel = ({ canEdit }: { canEdit: boolean }) => {
  const {
    rows: marketRows,
    isLoading,
    hiddenCount,
    showingCount,
  } = useModerationMarkets();
  const {
    nodeId,
    node,
    hiddenMarketsSupported,
    hiddenMarkets,
    hiddenMarketSet,
    updatedAt,
    refetch,
  } = useNodeModeration();
  const [search, setSearch] = useState("");
  const [creatorFilter, setCreatorFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>("all");
  const [sortBy, setSortBy] = useState<MarketVisibilitySort>("time-desc");
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>([]);
  const [adminToken, setAdminToken] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(REGISTRY_TOKEN_STORAGE_KEY) || "";
  });
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const hasAdminToken = adminToken.trim().length > 0;
  const canMutate =
    !!nodeId && hiddenMarketsSupported && canEdit && hasAdminToken && !isSaving;

  const categoryOptions = useMemo(() => {
    // Preserve canonical category order from lib/categories; only surface
    // categories that actually have rows (plus "all" as the first entry).
    const present = new Set(marketRows.map((market) => market.category));
    return CATEGORY_IDS.filter((id) => id === "all" || present.has(id));
  }, [marketRows]);

  const selectedAddressSet = useMemo(
    () => new Set(selectedAddresses),
    [selectedAddresses],
  );

  const filteredMarkets = useMemo(() => {
    const term = search.trim().toLowerCase();
    const creatorTerm = creatorFilter.trim().toLowerCase();

    return [...marketRows]
      .filter((market) => {
        const matchesSearch =
          term === "" ||
          market.question.toLowerCase().includes(term) ||
          market.addressLower.includes(term);
        const matchesCreator =
          creatorTerm === "" ||
          market.creator.toLowerCase().includes(creatorTerm);
        const matchesCategory =
          categoryFilter === "all" || market.category === categoryFilter;
        const matchesStage =
          stageFilter === "all" || market.stage === stageFilter;
        const matchesVisibility =
          visibilityFilter === "all" || market.visibility === visibilityFilter;

        return (
          matchesSearch &&
          matchesCreator &&
          matchesCategory &&
          matchesStage &&
          matchesVisibility
        );
      })
      .sort((left, right) => {
        switch (sortBy) {
          case "time-asc":
            return (
              (left.createdAtMs ?? Number.MAX_SAFE_INTEGER) -
                (right.createdAtMs ?? Number.MAX_SAFE_INTEGER) ||
              left.question.localeCompare(right.question)
            );
          case "creator-asc":
            return (
              left.creator.localeCompare(right.creator) ||
              (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0)
            );
          case "category-asc":
            return (
              left.category.localeCompare(right.category) ||
              left.question.localeCompare(right.question)
            );
          case "status":
            return (
              left.visibility.localeCompare(right.visibility) ||
              (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0)
            );
          case "time-desc":
          default:
            return (
              (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0) ||
              left.question.localeCompare(right.question)
            );
        }
      });
  }, [
    categoryFilter,
    creatorFilter,
    marketRows,
    search,
    sortBy,
    stageFilter,
    visibilityFilter,
  ]);

  const selectedMarkets = useMemo(
    () =>
      marketRows.filter((market) =>
        selectedAddressSet.has(market.addressLower),
      ),
    [marketRows, selectedAddressSet],
  );
  const selectedShowingCount = selectedMarkets.filter(
    (market) => market.visibility === "showing",
  ).length;
  const selectedHiddenCount = selectedMarkets.length - selectedShowingCount;
  const allFilteredSelected =
    filteredMarkets.length > 0 &&
    filteredMarkets.every((market) =>
      selectedAddressSet.has(market.addressLower),
    );

  const persistAdminToken = useCallback(() => {
    const normalized = adminToken.trim();
    if (typeof window === "undefined") return;
    if (normalized) {
      window.localStorage.setItem(REGISTRY_TOKEN_STORAGE_KEY, normalized);
      setStatus("Registry token saved in this browser.");
    } else {
      window.localStorage.removeItem(REGISTRY_TOKEN_STORAGE_KEY);
      setStatus("Registry token cleared.");
    }
  }, [adminToken]);

  const persistHiddenMarketSet = useCallback(
    async (nextHiddenMarkets: string[], message: string) => {
      if (!nodeId || !hiddenMarketsSupported || !canEdit || !hasAdminToken) {
        return;
      }

      setIsSaving(true);
      setStatus(null);
      try {
        await updateHiddenMarkets(nodeId, nextHiddenMarkets, adminToken.trim());
        await refetch();
        setStatus(message);
      } catch (error) {
        setStatus(
          error instanceof Error
            ? error.message
            : "Failed to update hidden markets.",
        );
      } finally {
        setIsSaving(false);
      }
    },
    [
      adminToken,
      canEdit,
      hasAdminToken,
      hiddenMarketsSupported,
      nodeId,
      refetch,
    ],
  );

  const applyVisibilityChange = useCallback(
    async (nextVisibility: "hidden" | "showing", addresses: string[]) => {
      const normalizedAddresses = Array.from(
        new Set(addresses.map((address) => address.toLowerCase())),
      );
      if (normalizedAddresses.length === 0) return;

      const nextHiddenMarkets =
        nextVisibility === "hidden"
          ? Array.from(new Set([...hiddenMarkets, ...normalizedAddresses]))
          : hiddenMarkets.filter(
              (marketAddress) => !normalizedAddresses.includes(marketAddress),
            );

      await persistHiddenMarketSet(
        nextHiddenMarkets,
        `${
          nextVisibility === "hidden" ? "Hidden" : "Showing"
        } ${normalizedAddresses.length} market${
          normalizedAddresses.length === 1 ? "" : "s"
        } for node ${nodeId}.`,
      );
      setSelectedAddresses((current) =>
        current.filter((address) => !normalizedAddresses.includes(address)),
      );
    },
    [hiddenMarkets, nodeId, persistHiddenMarketSet],
  );

  const handleToggleMarket = useCallback(
    (address: string) => {
      const lower = address.toLowerCase();
      void applyVisibilityChange(
        hiddenMarketSet.has(lower) ? "showing" : "hidden",
        [lower],
      );
    },
    [applyVisibilityChange, hiddenMarketSet],
  );

  const toggleSelectedMarket = useCallback((address: string) => {
    const lower = address.toLowerCase();
    setSelectedAddresses((current) =>
      current.includes(lower)
        ? current.filter((entry) => entry !== lower)
        : [...current, lower],
    );
  }, []);

  const toggleSelectAllFiltered = useCallback(() => {
    setSelectedAddresses((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        filteredMarkets.forEach((market) => next.delete(market.addressLower));
      } else {
        filteredMarkets.forEach((market) => next.add(market.addressLower));
      }
      return Array.from(next);
    });
  }, [allFilteredSelected, filteredMarkets]);

  const resetFilters = useCallback(() => {
    setSearch("");
    setCreatorFilter("");
    setCategoryFilter("all");
    setStageFilter("all");
    setVisibilityFilter("all");
    setSortBy("time-desc");
  }, []);

  return (
    <Card>
      <div className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-ink">
              Market Visibility
            </h2>
            <p className="mt-1 text-xs text-muted">
              Node-scoped moderation controls for shared market visibility.
            </p>
          </div>
          {hiddenCount > 0 && (
            <Badge className="border-accent/30 bg-accent-muted text-accent">
              {hiddenCount} Hidden
            </Badge>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-4 overflow-hidden whitespace-nowrap font-mono text-xs uppercase tracking-[0.08em] text-muted">
          <div className="flex shrink-0 items-center gap-2">
            <span>Node</span>
            <span className="text-ink">{nodeId || "Resolving..."}</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0">Deployed By</span>
            <span className="min-w-0 flex-1 truncate normal-case text-ink">
              {formatShortAddress(node?.deployedBy)}
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="registry-admin-token"
            className="block font-mono text-xs uppercase tracking-[0.12em] text-muted"
          >
            Registry Admin Token
          </label>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input
              id="registry-admin-token"
              name="registryAdminToken"
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              placeholder="Required for shared moderation writes"
              autoComplete="current-password"
              className="input-field w-full min-w-0 text-xs sm:flex-1"
            />
            <Button
              variant="primary"
              className="w-full sm:w-auto"
              onClick={persistAdminToken}
            >
              Save
            </Button>
          </div>
          {status && (
            <div className="font-mono text-xs uppercase tracking-[0.08em] text-faint">
              {status}
            </div>
          )}
          {!hiddenMarketsSupported && (
            <div className="font-mono text-xs uppercase tracking-[0.08em] text-faint">
              Registry moderation endpoint not deployed yet.
            </div>
          )}
          {updatedAt && (
            <div className="font-mono text-xs uppercase tracking-[0.08em] text-faint">
              Updated {new Date(updatedAt).toLocaleString()}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_220px]">
          <div>
            <label
              htmlFor="market-visibility-search"
              className="mb-1 block font-mono text-xs uppercase tracking-[0.12em] text-muted"
            >
              Search
            </label>
            <input
              id="market-visibility-search"
              type="text"
              placeholder="Question or address"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoComplete="off"
              className="input-field w-full text-xs"
            />
          </div>
          <div>
            <label
              htmlFor="market-visibility-creator"
              className="mb-1 block font-mono text-xs uppercase tracking-[0.12em] text-muted"
            >
              Creator
            </label>
            <input
              id="market-visibility-creator"
              type="text"
              placeholder="0x creator..."
              value={creatorFilter}
              onChange={(event) => setCreatorFilter(event.target.value)}
              autoComplete="off"
              className="input-field w-full text-xs"
            />
          </div>
          <div>
            <label
              htmlFor="market-visibility-sort"
              className="mb-1 block font-mono text-xs uppercase tracking-[0.12em] text-muted"
            >
              Sort
            </label>
            <select
              id="market-visibility-sort"
              value={sortBy}
              onChange={(event) =>
                setSortBy(event.target.value as MarketVisibilitySort)
              }
              className="input-field w-full text-xs"
            >
              <option value="time-desc">Newest First</option>
              <option value="time-asc">Oldest First</option>
              <option value="creator-asc">Creator A-Z</option>
              <option value="category-asc">Category A-Z</option>
              <option value="status">Hidden First</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_220px_auto]">
          <div>
            <label
              htmlFor="market-visibility-category"
              className="mb-1 block font-mono text-xs uppercase tracking-[0.12em] text-muted"
            >
              Category
            </label>
            <select
              id="market-visibility-category"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className="input-field w-full text-xs"
            >
              {categoryOptions.map((category) => (
                <option key={category} value={category}>
                  {MODERATION_CATEGORY_LABELS[category] ??
                    category.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="market-visibility-stage"
              className="mb-1 block font-mono text-xs uppercase tracking-[0.12em] text-muted"
            >
              Market Status
            </label>
            <select
              id="market-visibility-stage"
              value={stageFilter}
              onChange={(event) =>
                setStageFilter(event.target.value as StageFilter)
              }
              className="input-field w-full text-xs"
            >
              <option value="all">All Statuses</option>
              <option value="bonding">{MARKET_STAGE_LABELS.bonding}</option>
              <option value="live">{MARKET_STAGE_LABELS.live}</option>
              <option value="settled">{MARKET_STAGE_LABELS.settled}</option>
              <option value="finalized">{MARKET_STAGE_LABELS.finalized}</option>
              <option value="dismissed">{MARKET_STAGE_LABELS.dismissed}</option>
            </select>
          </div>
          <div>
            <div className="mb-1 block font-mono text-xs uppercase tracking-[0.12em] text-muted">
              Visibility
            </div>
            <div
              className="flex h-10 items-center border border-rule bg-raised p-1"
              role="group"
              aria-label="Market visibility filter"
            >
              {(
                [
                  ["all", "All"],
                  ["showing", "Showing"],
                  ["hidden", "Hidden"],
                ] as const
              ).map(([value, label]) => {
                const active = visibilityFilter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() =>
                      setVisibilityFilter(value as VisibilityFilter)
                    }
                    className={cn(
                      "h-full min-w-[72px] px-3 font-mono text-xs uppercase tracking-[0.08em] transition-colors",
                      active
                        ? "bg-accent text-canvas"
                        : "text-muted hover:text-ink",
                    )}
                    aria-pressed={active}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border border-rule bg-raised/50 px-3 py-2">
          <div className="font-mono text-xs uppercase tracking-[0.08em] text-faint">
            {filteredMarkets.length} filtered • {showingCount} showing •{" "}
            {hiddenCount} hidden • {selectedMarkets.length} selected
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="secondary"
              onClick={toggleSelectAllFiltered}
              disabled={filteredMarkets.length === 0}
            >
              {allFilteredSelected ? "Unselect Filtered" : "Select Filtered"}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setSelectedAddresses([])}
              disabled={selectedMarkets.length === 0}
            >
              Clear
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                void applyVisibilityChange("hidden", selectedAddresses)
              }
              disabled={!canMutate || selectedShowingCount === 0}
            >
              Hide Selected
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                void applyVisibilityChange("showing", selectedAddresses)
              }
              disabled={!canMutate || selectedHiddenCount === 0}
            >
              Show Selected
            </Button>
          </div>
        </div>

        <div className="max-h-[620px] overflow-y-auto border border-rule">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted">
              Loading markets...
            </div>
          ) : filteredMarkets.length === 0 ? (
            <div className="space-y-4 p-8 text-center">
              <div className="text-sm text-muted">
                No markets match the current filters.
              </div>
              <Button size="xs" variant="secondary" onClick={resetFilters}>
                Reset Filters
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-rule">
              {filteredMarkets.map((market) => {
                const isHidden = market.visibility === "hidden";
                const isSelected = selectedAddressSet.has(market.addressLower);
                return (
                  <div
                    key={market.address}
                    className={cn(
                      "px-3 py-3 transition-colors",
                      isSelected
                        ? "bg-accent/5"
                        : isHidden
                          ? "bg-raised/60"
                          : "hover:bg-raised/40",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectedMarket(market.address)}
                        aria-label={`Select market ${market.question}`}
                        className="mt-1 h-3.5 w-3.5 shrink-0 accent-current"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-ink">
                              {market.question}
                            </span>
                          </div>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-xs",
                              isHidden
                                ? "border-accent/30 text-accent"
                                : "border-rule text-muted",
                            )}
                          >
                            {isHidden ? "Hidden" : "Showing"}
                          </Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs uppercase tracking-[0.08em] text-faint">
                          <span>
                            Category{" "}
                            {MODERATION_CATEGORY_LABELS[market.category] ??
                              market.category}
                          </span>
                          <span>
                            Creator{" "}
                            <span className="normal-case">
                              {formatShortAddress(market.creator)}
                            </span>
                          </span>
                          <StageBadge stage={market.stage} />
                          <span>
                            {formatCreatedAtLabel(market.createdAtMs)}
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-xs normal-case tracking-[0.08em] text-faint">
                          {formatShortAddress(market.address)}
                        </div>
                      </div>
                      <VisibilitySwitch
                        checked={!isHidden}
                        disabled={!canMutate}
                        onChange={() => void handleToggleMarket(market.address)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

// ============================================
// Main Component
// ============================================

export const Operator = () => {
  const { t } = useTranslation();
  const { address: userAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const deployments = useDeployments();
  const [activeSection, setActiveSection] = useState<Section>("adjudicator");
  const [adjudicatorTab, setAdjudicatorTab] = useState<AdjudicatorTab>("ready");
  const { node } = useNodeModeration();

  // Contract addresses
  const launchpadEngineAddress = deployments?.contracts?.LaunchpadEngine as
    | `0x${string}`
    | undefined;

  // Markets for current chain. Pull from on-chain via useLaunchpadMarkets
  // — the legacy markets.json was hand-curated and is now empty for v0.2.0,
  // so the Operator UI was rendering nothing. Fall back to the static
  // config only if the hook hasn't returned anything (preserves the old
  // hardcoded path on chains where on-chain discovery is disabled).
  const { markets: launchpadMarkets } = useLaunchpadMarkets();
  const allMarkets = useMemo<MarketConfig[]>(() => {
    if (launchpadMarkets.length > 0) {
      return launchpadMarkets.map(
        (m): MarketConfig =>
          ({
            id: m.address,
            name: m.question || m.name,
            symbol:
              m.symbol ?? `${m.address.slice(0, 6)}…${m.address.slice(-4)}`,
            contractAddress: m.address,
            chainId,
            version: "v0.2.0",
            // Carry the question through so AdjudicatorMarketRow can show it.
            // MarketConfig is a permissive type — extra fields are dropped at
            // the boundary by the row's `(market as any).question` access.
            question: m.question,
          }) as unknown as MarketConfig,
      );
    }
    return marketsConfig.markets.filter(
      (m: MarketConfig) => m.version?.startsWith("v") && m.chainId === chainId,
    );
  }, [launchpadMarkets, chainId]);

  // Batch fetch adjudicator addresses for all markets
  const { data: adjudicatorData } = useReadContracts({
    contracts: allMarkets.map((m) => ({
      address: m.contractAddress as `0x${string}`,
      abi: ABIS.TruthMarket,
      functionName: "adjudicator",
    })),
    query: { enabled: allMarkets.length > 0 },
  });

  // v0.2.0 adjudicators are contracts (e.g. ManualAdjudicator). The user's
  // EOA never matches the contract address — so to detect "I am the
  // resolver for this market" we must read the per-market resolver from
  // the adjudicator's getMarketState(). Fetched in a second multicall
  // keyed on the adjudicator address from the first.
  const { data: adjMarketStates } = useReadContracts({
    contracts: (adjudicatorData ?? []).map((adj, i) => ({
      address:
        (adj.result as `0x${string}` | undefined) ??
        ("0x0000000000000000000000000000000000000000" as `0x${string}`),
      abi: SOOTH_MANUAL_ADJUDICATOR_ABI,
      functionName: "getMarketState",
      args: [allMarkets[i].contractAddress as `0x${string}`],
    })),
    query: {
      enabled: !!adjudicatorData && adjudicatorData.length > 0,
    },
  });

  // Check if user is adjudicator for any market — match either the
  // adjudicator contract address (legacy/EOA-as-adjudicator) OR the
  // per-market EOA resolver stored inside the adjudicator (v0.2.0 path).
  const isAdjudicatorForAny = useMemo(() => {
    if (!userAddress) return false;
    const lowerUser = userAddress.toLowerCase();
    const matchesAdj = (adjudicatorData ?? []).some(
      (result) =>
        result.status === "success" &&
        (result.result as string)?.toLowerCase() === lowerUser,
    );
    if (matchesAdj) return true;
    return (adjMarketStates ?? []).some((res) => {
      if (res.status !== "success") return false;
      const resolver = (res.result as { resolver?: `0x${string}` } | undefined)
        ?.resolver;
      return resolver?.toLowerCase() === lowerUser;
    });
  }, [userAddress, adjudicatorData, adjMarketStates]);

  // Count how many markets user is adjudicator for (same dual check).
  const adjudicatorMarketCount = useMemo(() => {
    if (!userAddress) return 0;
    const lowerUser = userAddress.toLowerCase();
    let count = 0;
    (adjudicatorData ?? []).forEach((result, i) => {
      const adjMatch =
        result.status === "success" &&
        (result.result as string)?.toLowerCase() === lowerUser;
      const stateRes = adjMarketStates?.[i];
      const resolver =
        stateRes?.status === "success"
          ? (stateRes.result as { resolver?: `0x${string}` } | undefined)
              ?.resolver
          : undefined;
      const resolverMatch = resolver?.toLowerCase() === lowerUser;
      if (adjMatch || resolverMatch) count += 1;
    });
    return count;
  }, [userAddress, adjudicatorData, adjMarketStates]);

  // Check if user is protocol owner
  const { data: ownerAddress } = useReadContract({
    address: launchpadEngineAddress,
    abi: ABIS.LaunchpadEngine,
    functionName: "owner",
    query: { enabled: !!launchpadEngineAddress },
  });

  const isOwner =
    userAddress?.toLowerCase() === (ownerAddress as string)?.toLowerCase();
  const isNodeOwner =
    userAddress?.toLowerCase() === node?.deployedBy?.toLowerCase();

  // Protocol settings state
  const [settings, setSettings] = useState({
    preGradFee: "5",
    postGradFee: "1",
    liquidityShare: "50",
    lpShare: "30",
    protocolShare: "20",
    gradMultiplier: "2",
    isPaused: false,
    trialPeriodDays: "3",
  });

  const totalShares =
    parseInt(settings.liquidityShare) +
    parseInt(settings.lpShare) +
    parseInt(settings.protocolShare);

  const sections: {
    id: Section;
    label: string;
    icon: typeof Gavel;
    color: "accent" | "muted" | "cyan";
  }[] = [
    { id: "adjudicator", label: "Adjudicator", icon: Gavel, color: "accent" },
    { id: "owner", label: "Owner", icon: Settings, color: "cyan" },
    { id: "editor", label: "Editor", icon: Eye, color: "muted" },
  ];

  const adjudicatorTabs = [
    {
      id: "ready" as AdjudicatorTab,
      label: "Ready to Settle",
      icon: AlertTriangle,
    },
    { id: "pending" as AdjudicatorTab, label: "Pending", icon: Clock },
    { id: "history" as AdjudicatorTab, label: "History", icon: CheckCircle },
  ];

  // Get active status for each role
  const getRoleActive = (role: Section): boolean => {
    switch (role) {
      case "adjudicator":
        return isAdjudicatorForAny;
      case "owner":
        return isOwner;
      case "editor":
        return isNodeOwner;
      default:
        return false;
    }
  };

  if (!isConnected) {
    return (
      <div className="text-center py-20">
        <p className="text-ink font-bold mb-2">{t("common.connectWallet")}</p>
        <p className="text-muted text-sm">
          Connect your wallet to access operator controls.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Page Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-ink">{t("operator.title")}</h1>
        </div>

        {/* Section Switcher - Pill Style with Role Indicators */}
        <div className="flex gap-1 p-1 bg-raised/50 mb-6 w-fit">
          {sections.map((section) => {
            const isActive = activeSection === section.id;
            const hasRole = getRoleActive(section.id);
            const colorClasses = {
              accent: isActive ? "text-accent" : "",
              muted: isActive ? "text-accent" : "",
              cyan: isActive ? "text-accent" : "",
            };
            return (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`relative flex items-center gap-2 px-4 py-2 border transition-all ${
                  isActive
                    ? `${colorClasses[section.color]} border-accent`
                    : "border-transparent text-muted hover:text-ink hover:bg-raised/50"
                }`}
              >
                <section.icon className="w-4 h-4" />
                <span className="font-medium">{section.label}</span>
                {/* Active role indicator - green dot */}
                {hasRole && (
                  <span className="absolute -top-1 -right-1 w-3 h-3 bg-accent rounded-full border-2 border-rule" />
                )}
              </button>
            );
          })}
        </div>

        {/* ============================================ */}
        {/* ADJUDICATOR SECTION */}
        {/* ============================================ */}
        {activeSection === "adjudicator" && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              {/* Stats Bar with Active Role Indicator */}
              <Card
                className={`bg-raised ${isAdjudicatorForAny ? "border-accent" : "border-rule"}`}
              >
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Gavel className="w-5 h-5 text-muted" />
                    <span className="text-ink font-medium">
                      Settlement Authority
                    </span>
                    {isAdjudicatorForAny ? (
                      <Badge className="bg-accent-muted text-ink border border-accent">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Active · {adjudicatorMarketCount} market
                        {adjudicatorMarketCount !== 1 ? "s" : ""}
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-muted border-rule"
                      >
                        Not assigned
                      </Badge>
                    )}
                  </div>
                  <Button variant="secondary" size="sm">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                  </Button>
                </div>
              </Card>

              {/* Not Active Warning */}
              {!isAdjudicatorForAny && (
                <div className="flex items-center gap-3 p-4 bg-raised/50 border border-rule">
                  <Info className="w-5 h-5 text-muted shrink-0" />
                  <div>
                    <p className="text-sm text-ink">
                      You are not an adjudicator for any markets on this chain.
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      Create a market or be assigned as adjudicator to see
                      pending settlements.
                    </p>
                  </div>
                </div>
              )}
              {/* Sub-tabs */}
              <div className="flex gap-2">
                {adjudicatorTabs.map((tab) => (
                  <button
                    key={tab.id}
                    data-testid={`operator-tab-${tab.id}`}
                    onClick={() => setAdjudicatorTab(tab.id)}
                    className={`flex items-center gap-2 px-3 py-1.5 text-sm border-b-2 transition-colors ${
                      adjudicatorTab === tab.id
                        ? "text-accent border-accent"
                        : "text-muted border-transparent hover:text-ink"
                    }`}
                  >
                    <tab.icon className="w-3.5 h-3.5" />
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Markets Table */}
              <Card>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-muted border-b border-rule">
                      <tr>
                        <th className="py-3 px-4 font-medium">Market</th>
                        <th className="py-3 px-4 font-medium">Status</th>
                        <th className="py-3 px-4 font-medium">
                          {adjudicatorTab === "ready"
                            ? "Deadline"
                            : adjudicatorTab === "pending"
                              ? "Veto Window"
                              : "Settled"}
                        </th>
                        <th className="py-3 px-4 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="text-ink">
                      {allMarkets.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-12 px-4 text-center">
                            <Gavel className="w-10 h-10 text-faint mx-auto mb-3" />
                            <p className="text-muted">
                              No markets on this chain
                            </p>
                          </td>
                        </tr>
                      ) : (
                        allMarkets.map((market: MarketConfig) => (
                          <AdjudicatorMarketRow
                            key={market.contractAddress}
                            market={market}
                            userAddress={userAddress}
                            tab={adjudicatorTab}
                          />
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>

            <div>
              <RoleEducation role="adjudicator" />
            </div>
          </div>
        )}

        {/* ============================================ */}
        {/* OWNER SECTION */}
        {/* ============================================ */}
        {activeSection === "owner" && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              {/* Stats Bar with Active Role Indicator */}
              <Card
                className={`bg-raised ${isOwner ? "border-accent" : "border-accent/20"}`}
              >
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Settings className="w-5 h-5 text-muted" />
                    <span className="text-ink font-medium">Protocol Owner</span>
                    {isOwner ? (
                      <Badge className="bg-accent-muted text-ink border border-accent">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Active Owner
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-muted border-rule"
                      >
                        Not owner
                      </Badge>
                    )}
                  </div>
                </div>
              </Card>

              {/* Not Active Warning */}
              {!isOwner && (
                <div className="flex items-center gap-3 p-4 bg-raised/50 border border-rule">
                  <Info className="w-5 h-5 text-muted shrink-0" />
                  <div>
                    <p className="text-sm text-ink">
                      You are not the protocol owner.
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      Only the LaunchpadEngine owner can modify protocol
                      settings.
                    </p>
                  </div>
                </div>
              )}
              {/* Fee Configuration */}
              <Card
                className={!isOwner ? "opacity-60 pointer-events-none" : ""}
              >
                <div className="p-4 space-y-4">
                  <h3 className="font-bold text-ink">Fee Configuration</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-muted mb-2">
                        Bonding Fee
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          value={settings.preGradFee}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              preGradFee: e.target.value,
                            }))
                          }
                          className="input-field pr-8"
                          disabled={!isOwner}
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                          %
                        </span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-muted mb-2">
                        Post-Graduation Fee
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          value={settings.postGradFee}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              postGradFee: e.target.value,
                            }))
                          }
                          className="input-field pr-8"
                          disabled={!isOwner}
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                          %
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>

              {/* Fee Distribution */}
              <Card
                className={!isOwner ? "opacity-60 pointer-events-none" : ""}
              >
                <div className="p-4 space-y-4">
                  <h3 className="font-bold text-ink">
                    Fee Distribution (Post-Graduation)
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm text-muted mb-2">
                        Liquidity Growth
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          value={settings.liquidityShare}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              liquidityShare: e.target.value,
                            }))
                          }
                          className="input-field pr-8"
                          disabled={!isOwner}
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                          %
                        </span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-muted mb-2">
                        LP Yield
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          value={settings.lpShare}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              lpShare: e.target.value,
                            }))
                          }
                          className="input-field pr-8"
                          disabled={!isOwner}
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                          %
                        </span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-muted mb-2">
                        Protocol Treasury
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          value={settings.protocolShare}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              protocolShare: e.target.value,
                            }))
                          }
                          className="input-field pr-8"
                          disabled={!isOwner}
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                          %
                        </span>
                      </div>
                    </div>
                  </div>
                  <div
                    className={`p-3 ${
                      totalShares === 100
                        ? "bg-accent-muted border border-accent"
                        : "bg-raised border border-error"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Total</span>
                      <span
                        className={`font-bold ${totalShares === 100 ? "text-ink" : "text-muted"}`}
                      >
                        {totalShares}%{" "}
                        {totalShares === 100 ? "✓" : "(must equal 100%)"}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>

              {/* Protocol Status */}
              <Card
                className={`${!isOwner ? "opacity-60 pointer-events-none" : ""} ${settings.isPaused ? "border-error bg-raised" : ""}`}
              >
                <div className="p-4 space-y-4">
                  <h3 className="font-bold text-ink flex items-center gap-2">
                    <AlertTriangle
                      className={`w-4 h-4 ${settings.isPaused ? "text-muted" : "text-muted"}`}
                    />
                    Protocol Status
                  </h3>
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="block text-sm text-muted">
                        Pause Protocol
                      </label>
                      <p className="text-xs text-muted mt-1">
                        Emergency stop all trading
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        setSettings((s) => ({ ...s, isPaused: !s.isPaused }))
                      }
                      disabled={!isOwner}
                      aria-label={
                        settings.isPaused ? "Resume protocol" : "Pause protocol"
                      }
                      className={`relative w-14 h-7 rounded-full border transition-colors ${
                        settings.isPaused
                          ? "border-neg bg-neg"
                          : "border-pos bg-pos"
                      } ${!isOwner ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-ink transition-transform ${
                          settings.isPaused ? "translate-x-7" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                  {settings.isPaused && (
                    <div className="p-3 bg-raised border border-error text-muted text-sm">
                      Protocol is PAUSED. All trading is halted.
                    </div>
                  )}
                </div>
              </Card>

              {/* Trial Period */}
              <Card
                className={!isOwner ? "opacity-60 pointer-events-none" : ""}
              >
                <div className="p-4 space-y-4">
                  <h3 className="font-bold text-ink">Trial Period Settings</h3>
                  <div>
                    <label className="block text-sm text-muted mb-2">
                      Default trial cap
                    </label>
                    <div className="relative w-48">
                      <input
                        type="number"
                        value={settings.trialPeriodDays}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            trialPeriodDays: e.target.value,
                          }))
                        }
                        className="input-field pr-12"
                        disabled={!isOwner}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                        days
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-1">
                      Each new market's trial duration is{" "}
                      <code>min(30% × time-to-deadline, cap)</code>. Shorter
                      markets automatically get shorter trials.
                    </p>
                  </div>
                </div>
              </Card>

              {/* Apply Button */}
              {isOwner && (
                <div className="flex justify-end gap-4">
                  <Button variant="secondary">Preview Changes</Button>
                  <Button variant="primary" disabled={totalShares !== 100}>
                    Apply Changes
                  </Button>
                </div>
              )}
            </div>

            <div>
              <RoleEducation role="owner" />
            </div>
          </div>
        )}

        {/* ============================================ */}
        {/* EDITOR SECTION */}
        {/* ============================================ */}
        {activeSection === "editor" && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <Card
                className={`bg-raised ${isNodeOwner ? "border-accent" : "border-rule"}`}
              >
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Eye className="w-5 h-5 text-muted" />
                    <span className="text-ink font-medium">
                      Content Control
                    </span>
                    {isNodeOwner ? (
                      <Badge className="bg-accent-muted text-ink border border-accent">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Node Owner
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-muted border-rule"
                      >
                        Read Only
                      </Badge>
                    )}
                  </div>
                </div>
              </Card>

              {!isNodeOwner && (
                <div className="flex items-center gap-3 p-4 bg-raised/50 border border-rule">
                  <Info className="w-5 h-5 text-muted shrink-0" />
                  <div>
                    <p className="text-sm text-ink">
                      You are not the deployed owner of this registry node.
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      You can review market visibility, but only the node owner
                      can submit shared moderation changes.
                    </p>
                  </div>
                </div>
              )}

              <MarketVisibilityPanel canEdit={!!isNodeOwner} />
            </div>
            <div>
              <RoleEducation role="editor" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Operator;
