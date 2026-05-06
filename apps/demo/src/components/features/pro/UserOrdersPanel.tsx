import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, BarChart3, BookOpen, HelpCircle } from "lucide-react";
import { useAccount } from "@/lib/chain-shim";
import toast from "react-hot-toast";

import { cn } from "../../../lib/utils";
import { SimpleTooltip } from "../../ui/SimpleTooltip";
import { useIndexerOrders } from "../../../hooks/useIndexerOrders";
import type { OpenOrder, HistoryRow } from "../../../hooks/useIndexerOrders";

type OrderSort = "newest" | "price" | "fill";
type OrdersGroup = "open" | "history";
type SortDirection = "asc" | "desc";
const MAX_BATCH_SIZE = 50;
const HISTORY_PAGE_SIZE = 50;

export interface UserOrdersPanelProps {
  marketAddress: `0x${string}`;
  marketKey: `0x${string}` | undefined;
  soothBookAddress: `0x${string}` | undefined;
  isLoading: boolean;
  onRefresh: () => void;
  chainId: number;
  viewOutcome: "yes" | "no";
  onCancelOrder?: (
    orderId: string,
    options?: { silent?: boolean },
  ) => Promise<boolean>;
}

function formatOrderId(orderId: string): string {
  if (!orderId) return "—";
  if (orderId.length <= 12) return orderId;
  return `${orderId.slice(0, 6)}…${orderId.slice(-4)}`;
}

function formatDisplayPriceFromOutcome(
  yesPrice: number,
  viewOutcome: "yes" | "no",
): string {
  const cents = viewOutcome === "yes" ? yesPrice * 100 : (1 - yesPrice) * 100;
  return `${cents.toFixed(1)}¢`;
}

function formatRefundAmount(refundAmountWad: bigint | null): string {
  if (!refundAmountWad || refundAmountWad <= 0n) return "—";
  const raw = Number(refundAmountWad) / 1e18;
  if (!Number.isFinite(raw)) return "—";
  return `$${raw.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function orderSortValue(order: OpenOrder, sortBy: OrderSort): number {
  if (sortBy === "price") return order.yesPrice;
  if (sortBy === "fill") return order.fillPct;
  if (sortBy === "newest") {
    const idNum = Number(order.id);
    return Number.isFinite(idNum) ? idNum : order.timestamp;
  }
  return 0;
}

function toHistoryEventLabel(type: HistoryRow["type"]): string {
  if (type === "placed") return "Placed";
  if (type === "filled") return "Filled";
  return "Cancelled";
}

function toHistoryEventClasses(type: HistoryRow["type"]): string {
  if (type === "placed") return "bg-warn-soft text-warn border-warn";
  if (type === "filled") return "bg-pos-soft text-pos border-pos-soft";
  return "bg-neg-soft text-neg border-neg-soft";
}

type PanelHeaderProps = {
  group: OrdersGroup;
  onBatchCancel: () => void;
  selectedCancelableCount: number;
  batchCancelBusy: boolean;
  canCancel: boolean;
  viewOutcome: "yes" | "no";
};

function PanelHeader({
  group,
  onBatchCancel,
  selectedCancelableCount,
  batchCancelBusy,
  canCancel,
  viewOutcome,
}: PanelHeaderProps): JSX.Element {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-bold text-muted uppercase tracking-wider">
          YOUR{" "}
          <span className={viewOutcome === "yes" ? "text-pos" : "text-neg"}>
            {viewOutcome === "yes" ? "YES" : "NO"}
          </span>{" "}
          ORDERS
        </span>
        <SimpleTooltip content="Active orders are reconstructed from on-chain OrderPlaced, OrderFilled, and OrderCancelled events.">
          <button
            type="button"
            className="p-0.5 hover:bg-raised rounded transition-colors"
            aria-label="Hint"
          >
            <HelpCircle className="w-3.5 h-3.5 text-faint" />
          </button>
        </SimpleTooltip>
      </div>
      {group === "open" && (
        <button
          onClick={onBatchCancel}
          disabled={
            selectedCancelableCount === 0 || batchCancelBusy || !canCancel
          }
          className={cn(
            "flex items-center gap-1.5 text-xs font-bold transition-all",
            selectedCancelableCount === 0 || batchCancelBusy || !canCancel
              ? "text-faint cursor-not-allowed"
              : "text-neg hover:text-neg",
          )}
          title="Cancel selected orders"
        >
          {batchCancelBusy ? (
            <Loader2 size={10} className="animate-spin" />
          ) : null}
          Cancel Selected ({selectedCancelableCount})
        </button>
      )}
    </div>
  );
}

type PanelControlsProps = {
  group: OrdersGroup;
  setGroup: (group: OrdersGroup) => void;
  openCount: number;
  historyCount: number;
  sortBy: OrderSort;
  setSortBy: (sortBy: OrderSort) => void;
  sortDirection: SortDirection;
  setSortDirection: (direction: SortDirection) => void;
};

function PanelControls({
  group,
  setGroup,
  openCount,
  historyCount,
  sortBy,
  setSortBy,
  sortDirection,
  setSortDirection,
}: PanelControlsProps): JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-3 text-xs flex-wrap">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setGroup("open")}
          className={cn(
            "font-medium transition-colors border-b-2 pb-0.5",
            group === "open"
              ? "border-subtle text-white"
              : "border-transparent text-muted hover:text-muted",
          )}
        >
          Open ({openCount})
        </button>
        <button
          onClick={() => setGroup("history")}
          className={cn(
            "font-medium transition-colors border-b-2 pb-0.5",
            group === "history"
              ? "border-subtle text-white"
              : "border-transparent text-muted hover:text-muted",
          )}
        >
          History ({historyCount})
        </button>
      </div>

      <div className="flex items-center gap-1 ml-auto">
        <span className="text-faint">Sort:</span>
        <select
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as OrderSort)}
          className="bg-transparent border-none px-1 py-0.5 text-muted text-xs focus:ring-0"
        >
          <option value="newest">ID</option>
          <option value="price">Price</option>
          <option value="fill">Fill %</option>
        </select>
        <select
          value={sortDirection}
          onChange={(event) =>
            setSortDirection(event.target.value as SortDirection)
          }
          className="bg-transparent border-none px-1 py-0.5 text-muted text-xs focus:ring-0"
        >
          <option value="desc">Desc</option>
          <option value="asc">Asc</option>
        </select>
      </div>
    </div>
  );
}

type OpenOrdersTableProps = {
  orders: OpenOrder[];
  selectedOrderIds: string[];
  viewOutcome: "yes" | "no";
  actionInProgress: string | null;
  onToggleSelectOrder: (orderId: string) => void;
  onToggleSelectAllVisible: () => void;
  onCancelOrder: (orderId: string) => Promise<void>;
  canCancel: boolean;
};

function OpenOrdersTable({
  orders,
  selectedOrderIds,
  viewOutcome,
  actionInProgress,
  onToggleSelectOrder,
  onToggleSelectAllVisible,
  onCancelOrder,
  canCancel,
}: OpenOrdersTableProps): JSX.Element {
  if (orders.length === 0) {
    return (
      <div className="text-center py-8">
        <BarChart3 className="w-8 h-8 text-faint mx-auto mb-2" />
        <p className="text-sm text-muted">No open orders</p>
        <p className="text-xs text-faint">Place a limit order to get started</p>
      </div>
    );
  }

  return (
    <div>
      <div className="space-y-0">
        <div className="flex items-center gap-2 py-1 text-[10px] font-bold text-muted uppercase tracking-wider border-b border-white/[0.04]">
          <button
            type="button"
            onClick={onToggleSelectAllVisible}
            className="shrink-0 w-4 h-4 border border-subtle text-[10px] leading-none text-muted hover:border-subtle"
            title="Select all visible open orders"
          >
            {orders.length > 0 &&
            orders.every((order) => selectedOrderIds.includes(order.id))
              ? "✓"
              : ""}
          </button>
          <span className="shrink-0 w-10">ID</span>
          <span className="shrink-0 w-10">Side</span>
          <span className="shrink-0 w-24">Price</span>
          <span className="shrink-0 w-12">Size</span>
          <span className="shrink-0 w-16">Fill</span>
          <div className="flex-1" />
          <span className="shrink-0 text-right">Action</span>
        </div>

        {orders.map((order) => {
          const orderId = order.id;
          const sideIsYes = order.outcome === 1;
          const isBuy = viewOutcome === "yes" ? sideIsYes : !sideIsYes;

          return (
            <div
              key={orderId}
              data-testid="uo-order-row"
              data-order-id={orderId}
              className="flex items-center gap-2 py-1.5 border-b border-white/[0.03] transition-all hover:bg-white/[0.02]"
            >
              <button
                type="button"
                onClick={() => onToggleSelectOrder(orderId)}
                className="shrink-0 w-4 h-4 rounded border border-subtle bg-inset text-[10px] leading-none text-muted hover:border-subtle"
                title="Select order"
              >
                {selectedOrderIds.includes(orderId) ? "✓" : ""}
              </button>
              <span
                className="shrink-0 w-10 text-xs font-mono text-muted truncate"
                title={orderId}
              >
                {formatOrderId(orderId)}
              </span>

              <span
                className={cn(
                  "shrink-0 w-10 py-0.5 rounded text-xs font-bold text-center uppercase",
                  isBuy ? "bg-pos-soft text-pos" : "bg-neg-soft text-neg",
                )}
              >
                {isBuy ? "Buy" : "Sell"}
              </span>

              <span className="shrink-0 w-24 text-xs font-mono font-medium text-white">
                {formatDisplayPriceFromOutcome(order.yesPrice, viewOutcome)}
              </span>

              <span className="shrink-0 w-12 text-xs font-mono text-muted">
                {order.amount.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </span>

              <div className="shrink-0 w-16 flex items-center gap-1">
                <div className="flex-1 h-1.5 bg-subtle rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all bg-rule"
                    style={{ width: `${order.fillPct.toFixed(0)}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-muted w-7 text-right">
                  {order.fillPct.toFixed(0)}%
                </span>
              </div>

              <div className="flex-1" />

              <div className="shrink-0 flex items-center justify-end">
                <button
                  data-testid="uo-cancel-btn"
                  onClick={() => void onCancelOrder(orderId)}
                  disabled={
                    actionInProgress === `cancel-${orderId}` || !canCancel
                  }
                  className={cn(
                    "text-xs font-bold text-neg hover:text-neg transition-colors flex items-center justify-center",
                    (!canCancel || actionInProgress === `cancel-${orderId}`) &&
                      "opacity-40 cursor-not-allowed",
                  )}
                  title="Cancel order and return unused collateral"
                >
                  {actionInProgress === `cancel-${orderId}` ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    "Cancel"
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type HistoryTableProps = {
  rows: HistoryRow[];
  viewOutcome: "yes" | "no";
};

function HistoryTable({ rows, viewOutcome }: HistoryTableProps): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="text-center py-8">
        <BookOpen className="w-8 h-8 text-faint mx-auto mb-2" />
        <p className="text-sm text-muted">No activity yet</p>
        <p className="text-xs text-faint">
          Place orders to see your trading history
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold text-muted uppercase tracking-wider border-b border-subtle">
        <span className="shrink-0 w-8">Side</span>
        <span className="shrink-0 w-12">Price</span>
        <span className="shrink-0 w-10">Size</span>
        <span className="shrink-0 w-16">Refund</span>
        <div className="flex-1" />
        <span className="shrink-0 text-right">Event</span>
      </div>

      {rows.map(({ key, type, side, amount, yesPrice, refundAmountWad }) => {
        const sideIsYes = side === "YES";
        const isBuy = viewOutcome === "yes" ? sideIsYes : !sideIsYes;

        return (
          <div
            key={key}
            className="flex items-center gap-1.5 py-1.5 border-b border-white/[0.03]"
          >
            <span
              className={cn(
                "shrink-0 w-8 py-0.5 rounded text-[10px] font-bold text-center uppercase",
                isBuy ? "bg-pos-soft text-pos" : "bg-neg-soft text-neg",
              )}
            >
              {isBuy ? "Buy" : "Sell"}
            </span>
            <span className="shrink-0 w-12 text-xs font-mono font-medium text-white">
              {formatDisplayPriceFromOutcome(yesPrice, viewOutcome)}
            </span>
            <span className="shrink-0 w-10 text-xs font-mono text-muted">
              {amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <span
              className={cn(
                "shrink-0 w-16 text-xs font-mono truncate",
                refundAmountWad && refundAmountWad > 0n
                  ? "text-pos"
                  : "text-muted",
              )}
            >
              {formatRefundAmount(refundAmountWad)}
            </span>
            <div className="flex-1" />
            <span
              className={cn(
                "shrink-0 h-5 px-1.5 rounded text-[10px] font-bold border inline-flex items-center",
                toHistoryEventClasses(type),
              )}
            >
              {toHistoryEventLabel(type)}
            </span>
          </div>
        );
      })}
      <div className="px-2 pt-1 text-[10px] text-muted">
        Refund = surplus on fills, or collateral on non-escrow cancels.
      </div>
    </div>
  );
}

export function UserOrdersPanel({
  marketAddress,
  marketKey,
  soothBookAddress: _soothBookAddress,
  isLoading,
  onRefresh,
  chainId,
  viewOutcome,
  onCancelOrder,
}: UserOrdersPanelProps): JSX.Element {
  const { address: userAddress } = useAccount();
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [group, setGroup] = useState<OrdersGroup>("open");
  const [sortBy, setSortBy] = useState<OrderSort>("newest");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [historyPage, setHistoryPage] = useState(1);

  const {
    openOrders,
    historyRows,
    isLoading: isIndexerLoading,
    refresh,
  } = useIndexerOrders(
    chainId,
    marketKey as `0x${string}` | undefined,
    marketAddress,
    userAddress as `0x${string}` | undefined,
    _soothBookAddress,
  );

  const sortedOpenOrders = useMemo(() => {
    return [...openOrders].sort((a, b) => {
      const base = orderSortValue(a, sortBy) - orderSortValue(b, sortBy);
      return sortDirection === "asc" ? base : -base;
    });
  }, [openOrders, sortBy, sortDirection]);

  const sortedHistoryRows = useMemo(() => {
    return [...historyRows].sort((a, b) => {
      let base = 0;
      if (sortBy === "price") {
        base = a.yesPrice - b.yesPrice;
      } else if (sortBy === "fill") {
        base = a.amount - b.amount;
      } else {
        base = a.sortKey - b.sortKey;
      }
      return sortDirection === "asc" ? base : -base;
    });
  }, [historyRows, sortBy, sortDirection]);
  const totalHistoryPages = Math.max(
    1,
    Math.ceil(sortedHistoryRows.length / HISTORY_PAGE_SIZE),
  );
  const pagedHistoryRows = useMemo(() => {
    const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
    return sortedHistoryRows.slice(start, start + HISTORY_PAGE_SIZE);
  }, [sortedHistoryRows, historyPage]);
  const selectedCancelableOrderIds = useMemo(
    () =>
      selectedOrderIds
        .filter((id) => openOrders.some((order) => order.id === id))
        .slice(0, MAX_BATCH_SIZE),
    [selectedOrderIds, openOrders],
  );

  // Stabilize: only prune selectedOrderIds when the set of open order IDs actually changes
  const openOrderIdsKey = useMemo(
    () =>
      openOrders
        .map((o) => o.id)
        .sort()
        .join(","),
    [openOrders],
  );
  const prevOpenOrderIdsKey = useRef(openOrderIdsKey);
  useEffect(() => {
    if (prevOpenOrderIdsKey.current === openOrderIdsKey) return;
    prevOpenOrderIdsKey.current = openOrderIdsKey;
    setSelectedOrderIds((prev) => {
      const next = prev.filter((id) =>
        openOrders.some((order) => order.id === id),
      );
      if (next.length === prev.length) return prev; // no change, skip re-render
      return next;
    });
  }, [openOrderIdsKey, openOrders]);

  useEffect(() => {
    setHistoryPage(1);
  }, [sortBy, sortDirection]);

  useEffect(() => {
    setHistoryPage((prev) => {
      const clamped = Math.min(prev, totalHistoryPages);
      return clamped === prev ? prev : clamped; // skip re-render if unchanged
    });
  }, [totalHistoryPages]);

  const handleBatchCancel = async () => {
    if (!onCancelOrder || selectedCancelableOrderIds.length === 0) return;

    setActionInProgress("batch-cancel");
    const toastId = toast.loading(
      `Cancelling ${selectedCancelableOrderIds.length} order(s)...`,
    );

    try {
      let cancelled = 0;
      const failures: string[] = [];
      const total = selectedCancelableOrderIds.length;
      for (const orderId of selectedCancelableOrderIds) {
        try {
          const ok = await onCancelOrder(orderId, { silent: true });
          if (ok) {
            cancelled += 1;
          } else {
            failures.push(`${orderId}: cancel returned false`);
          }
        } catch (error) {
          failures.push(
            `${orderId}: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }

      if (failures.length > 0) {
        console.error("Batch cancel failures:", failures);
      }

      if (cancelled > 0 || failures.length > 0) {
        const message =
          failures.length > 0
            ? `Cancelled ${cancelled}/${total}. ${failures.length} failed — check console.`
            : `Cancelled ${cancelled}/${total}.`;
        if (failures.length > 0) {
          toast.error(message, { id: toastId, duration: 5000 });
        } else {
          toast.success(message, { id: toastId, duration: 5000 });
        }
        if (cancelled > 0) setSelectedOrderIds([]);
      } else {
        toast.error("No orders cancelled", { id: toastId, duration: 5000 });
      }

      onRefresh();
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Batch cancel failed";
      toast.error(message, { id: toastId, duration: 5000 });
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    if (!onCancelOrder) return;

    setActionInProgress(`cancel-${orderId}`);

    try {
      await onCancelOrder(orderId);

      onRefresh();
      await refresh();
    } catch {
      // onCancelOrder already handles user-visible error toasts.
    } finally {
      setActionInProgress(null);
    }
  };

  const toggleSelectOrder = (orderId: string) => {
    setSelectedOrderIds((prev) =>
      prev.includes(orderId)
        ? prev.filter((id) => id !== orderId)
        : [...prev, orderId],
    );
  };

  const toggleSelectAllVisible = () => {
    const visibleIds = sortedOpenOrders.map((order) => order.id);
    const allSelected =
      visibleIds.length > 0 &&
      visibleIds.every((id) => selectedOrderIds.includes(id));

    if (allSelected) {
      setSelectedOrderIds((prev) =>
        prev.filter((id) => !visibleIds.includes(id)),
      );
      return;
    }

    setSelectedOrderIds((prev) =>
      Array.from(new Set([...prev, ...visibleIds])),
    );
  };

  const panelLoading = isLoading || isIndexerLoading;

  if (panelLoading) {
    return (
      <div className="border-t border-white/[0.06]">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-bold text-muted uppercase tracking-wider">
            YOUR{" "}
            <span className={viewOutcome === "yes" ? "text-pos" : "text-neg"}>
              {viewOutcome === "yes" ? "YES" : "NO"}
            </span>{" "}
            ORDERS
          </span>
        </div>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 text-muted animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="pt-3 border-t border-white/[0.04]">
      <PanelHeader
        group={group}
        onBatchCancel={handleBatchCancel}
        selectedCancelableCount={selectedCancelableOrderIds.length}
        batchCancelBusy={actionInProgress === "batch-cancel"}
        canCancel={Boolean(onCancelOrder)}
        viewOutcome={viewOutcome}
      />

      <PanelControls
        group={group}
        setGroup={setGroup}
        openCount={openOrders.length}
        historyCount={historyRows.length}
        sortBy={sortBy}
        setSortBy={setSortBy}
        sortDirection={sortDirection}
        setSortDirection={setSortDirection}
      />

      {group === "open" ? (
        <OpenOrdersTable
          orders={sortedOpenOrders}
          selectedOrderIds={selectedOrderIds}
          viewOutcome={viewOutcome}
          actionInProgress={actionInProgress}
          onToggleSelectOrder={toggleSelectOrder}
          onToggleSelectAllVisible={toggleSelectAllVisible}
          onCancelOrder={handleCancelOrder}
          canCancel={Boolean(onCancelOrder)}
        />
      ) : (
        <div className="space-y-3">
          <HistoryTable rows={pagedHistoryRows} viewOutcome={viewOutcome} />
          {totalHistoryPages > 1 ? (
            <div className="flex items-center justify-between text-xs px-1">
              <span className="text-muted">
                Showing {(historyPage - 1) * HISTORY_PAGE_SIZE + 1}-
                {Math.min(
                  historyPage * HISTORY_PAGE_SIZE,
                  sortedHistoryRows.length,
                )}{" "}
                of {sortedHistoryRows.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                  disabled={historyPage === 1}
                  className={cn(
                    "px-2 py-1 rounded border transition-colors",
                    historyPage === 1
                      ? "border-subtle text-faint cursor-not-allowed"
                      : "border-subtle text-muted hover:bg-raised",
                  )}
                >
                  Prev
                </button>
                <span className="text-muted">
                  Page {historyPage}/{totalHistoryPages}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setHistoryPage((p) => Math.min(totalHistoryPages, p + 1))
                  }
                  disabled={historyPage === totalHistoryPages}
                  className={cn(
                    "px-2 py-1 rounded border transition-colors",
                    historyPage === totalHistoryPages
                      ? "border-subtle text-faint cursor-not-allowed"
                      : "border-subtle text-muted hover:bg-raised",
                  )}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default UserOrdersPanel;
