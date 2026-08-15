import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OptionChainCell } from "../../hooks/useOptionChain";
import { formatCents } from "../../lib/orderTicks";
import { useSimulationStore } from "../../store/useSimulationStore";
import { CanonicalBook } from "./CanonicalBook";
import { DepthSide, type DepthRow } from "./DepthSide";

interface TradeDrawerProps {
  cell: OptionChainCell;
  initialAction?: "buyYes" | "sellYes";
  onClose: () => void;
}

const BIDS = [
  [47, "124.6"],
  [45, "86.2"],
  [42, "201.4"],
] as const;
const ASKS = [
  [52, "73.8"],
  [55, "142.1"],
  [58, "99.7"],
] as const;

export function TradeDrawer({ cell, initialAction, onClose }: TradeDrawerProps) {
  const { t } = useTranslation();
  const stateLabel = cell.fixture
    ? t("eastboard.trade.drawer.stateFixture")
    : cell.status === "live"
      ? t("eastboard.trade.drawer.stateLive")
      : cell.status === "closed"
        ? t("eastboard.trade.drawer.stateClosed")
        : t("eastboard.trade.drawer.stateSettled");
  const stateTone =
    cell.status === "live"
      ? "text-pos"
      : cell.status === "closed"
        ? "text-warn"
        : "text-muted";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="trade-drawer-backdrop fixed inset-0 z-modal bg-canvas/80 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="trade-drawer-panel absolute inset-y-0 right-0 w-full max-w-[1040px] overflow-y-auto border-l border-rule bg-canvas shadow-[0_24px_90px_rgba(7,9,9,0.52)]"
      >
        <header className="sticky top-0 z-sticky flex items-start justify-between gap-5 border-b border-rule bg-canvas/95 px-5 py-4 backdrop-blur-xl sm:px-7">
          <div>
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.17em] text-accent">
              {cell.fixture
                ? t("eastboard.trade.drawer.fixtureBook")
                : t("eastboard.trade.drawer.canonicalBook")}
            </p>
            <h2
              id="trade-drawer-title"
              className="mt-2 font-heading text-xl font-semibold tracking-[-0.035em] text-ink"
            >
              {cell.template.underlyingSymbol} ≥ {cell.template.strikeLabel}
            </h2>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
              {cell.template.expiry} · {cell.template.closeLabel}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`flex items-center gap-2 font-mono text-[8px] font-semibold uppercase tracking-[0.12em] ${stateTone}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${cell.status === "live" ? "bg-pos" : cell.status === "closed" ? "bg-warn" : "bg-faint"}`}
              />
              {stateLabel}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="border border-rule px-3 py-2 font-mono text-[10px] uppercase text-muted hover:border-ink hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:translate-y-px"
            >
              {t("common.close")}
            </button>
          </div>
        </header>

        {cell.fixture || !cell.marketAddress ? (
          <FixtureBook cell={cell} initialAction={initialAction} />
        ) : (
          <CanonicalBook cell={cell} initialAction={initialAction} />
        )}
      </section>
    </div>
  );
}

function FixtureBook({
  cell,
  initialAction,
}: {
  cell: OptionChainCell;
  initialAction?: "buyYes" | "sellYes";
}) {
  const { t } = useTranslation();
  const balance = useSimulationStore((state) => state.balance);
  const placeTrade = useSimulationStore((state) => state.placeTrade);
  const [outcome, setOutcome] = useState<0 | 1>(
    initialAction === "sellYes" ? 0 : 1,
  );
  const [priceCents, setPriceCents] = useState("52");
  const [shares, setShares] = useState("100");
  const [message, setMessage] = useState<string | null>(null);
  const numericYesPriceCents = Number(priceCents);
  const outcomePriceCents =
    outcome === 0 ? 100 - numericYesPriceCents : numericYesPriceCents;
  const numericPrice = outcomePriceCents / 100;
  const numericShares = Number(shares);
  const maxCost = numericPrice * numericShares;
  const invalidPayout = numericShares / 2;
  const maxDepth = Math.max(
    ...BIDS.map(([, size]) => Number(size)),
    ...ASKS.map(([, size]) => Number(size)),
  );
  const depthRows = (
    rows: ReadonlyArray<readonly [number, string]>,
  ): DepthRow[] =>
    rows.map(([rowPriceCents, size]) => ({
      id: `${rowPriceCents}-${size}`,
      priceLabel: formatCents(rowPriceCents),
      sizeLabel: size,
      fillPercent: (Number(size) / maxDepth) * 100,
    }));
  const selectDepthPrice = (side: "bid" | "ask", row: DepthRow) => {
    const yesPrice = Number.parseFloat(row.id);
    if (side === "ask") {
      setOutcome(1);
      setPriceCents(String(yesPrice));
    } else {
      setOutcome(0);
      setPriceCents(String(yesPrice));
    }
    setMessage(null);
  };

  const submit = () => {
    if (
      !Number.isInteger(numericYesPriceCents) ||
      numericYesPriceCents < 1 ||
      numericYesPriceCents > 99 ||
      numericShares <= 0 ||
      !Number.isFinite(maxCost) ||
      maxCost > balance
    ) {
      setMessage(t("eastboard.trade.fixture.invalidInput"));
      return;
    }
    placeTrade(cell.template, outcome, numericPrice, numericShares);
    setMessage(
      t("eastboard.trade.fixture.filled", {
        action:
          outcome === 1
            ? t("eastboard.trade.fixture.buyYes")
            : t("eastboard.trade.fixture.sellYes"),
        amount: maxCost.toFixed(2),
      }),
    );
  };

  return (
    <div className="grid gap-7 p-5 sm:p-7">
      <div className="border border-warn/40 bg-warn-soft p-4 font-mono text-[10px] leading-relaxed text-warn">
        {t("eastboard.trade.fixture.notice")}
      </div>

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section>
          <div className="flex items-center justify-between border-b border-rule pb-3">
            <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-muted">
              {t("eastboard.trade.depth.title")}
            </h3>
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
              {t("eastboard.trade.depth.spread", { spread: "5¢" })}
            </span>
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-muted">
            {t("eastboard.trade.depth.instruction")}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <DepthSide
              label={t("eastboard.trade.depth.bids")}
              side="bid"
              rows={depthRows(BIDS)}
              onSelect={(row) => selectDepthPrice("bid", row)}
            />
            <DepthSide
              label={t("eastboard.trade.depth.asks")}
              side="ask"
              rows={depthRows(ASKS)}
              onSelect={(row) => selectDepthPrice("ask", row)}
            />
          </div>
          <div className="mt-6 border-y border-rule py-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
              {t("eastboard.trade.fixture.midpoint")}
            </p>
            <div className="mt-2 flex items-end justify-between gap-4">
              <p className="font-mono text-4xl font-semibold tracking-[-0.06em] text-ink">
                {formatCents(49.5)}
              </p>
              <p className="pb-1 font-mono text-[10px] text-muted">
                {t("eastboard.trade.fixture.impliedYes", {
                  value: formatCents(49.5),
                })}
              </p>
            </div>
          </div>
        </section>

        <aside className="border-t border-rule pt-6 lg:sticky lg:top-[112px] lg:self-start lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
          <div className="grid grid-cols-2 border border-rule p-1">
            <button
              type="button"
              aria-pressed={outcome === 1}
              onClick={() => setOutcome(1)}
              className={`${outcome === 1 ? "bg-pos text-canvas" : "text-muted"} px-3 py-2.5 font-mono text-[10px] font-bold uppercase`}
            >
              {t("eastboard.trade.fixture.buyYes")}
            </button>
            <button
              type="button"
              aria-pressed={outcome === 0}
              onClick={() => setOutcome(0)}
              className={`${outcome === 0 ? "bg-neg text-canvas" : "text-muted"} px-3 py-2.5 font-mono text-[10px] font-bold uppercase`}
            >
              {t("eastboard.trade.fixture.sellYes")}
            </button>
          </div>
          {outcome === 0 && NumericYesPriceCentsIsValid(numericYesPriceCents) && (
            <p className="mt-2 font-mono text-[9px] leading-relaxed text-muted">
              {t("eastboard.trade.fixture.sellHelper", {
                noPrice: String(100 - numericYesPriceCents),
              })}
            </p>
          )}
          <p className="mt-4 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
            {t("eastboard.trade.fixture.simBalance", {
              amount: balance.toFixed(2),
            })}
          </p>
          <label className="mt-5 block">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
              {t("eastboard.trade.fixture.yesLimitPrice")}
            </span>
            <span className="relative mt-2 block">
              <input
                aria-label={t("eastboard.trade.fixture.yesLimitPrice")}
                type="number"
                min="1"
                max="99"
                step="1"
                value={priceCents}
                onChange={(event) => setPriceCents(event.target.value)}
                className="w-full border border-rule bg-inset px-3 py-3 pr-9 font-mono text-sm text-ink"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-sm text-faint"
              >
                ¢
              </span>
            </span>
          </label>
          <label className="mt-4 block">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
              {t("eastboard.trade.fixture.shares")}
            </span>
            <input
              aria-label={t("eastboard.trade.fixture.shares")}
              type="number"
              min="1"
              step="1"
              value={shares}
              onChange={(event) => setShares(event.target.value)}
              className="mt-2 w-full border border-rule bg-inset px-3 py-3 font-mono text-sm text-ink"
            />
          </label>
          <dl className="mt-5 grid grid-cols-2 border-y border-rule py-4 font-mono">
            <div className="pr-4">
              <dt className="text-[8px] uppercase tracking-[0.12em] text-neg">
                {t("eastboard.trade.fixture.risk")}
              </dt>
              <dd className="mt-2 text-lg font-semibold tracking-[-0.04em] text-ink">
                {Number.isFinite(maxCost) ? maxCost.toFixed(2) : "—"}
              </dd>
              <dd className="mt-1 text-[8px] uppercase text-faint">MUSDC</dd>
            </div>
            <div className="border-l border-rule pl-4">
              <dt className="text-[8px] uppercase tracking-[0.12em] text-pos">
                {t("eastboard.trade.fixture.pays")}
              </dt>
              <dd className="mt-2 text-lg font-semibold tracking-[-0.04em] text-ink">
                {Number.isFinite(numericShares)
                  ? numericShares.toFixed(2)
                  : "—"}
              </dd>
              <dd className="mt-1 text-[8px] uppercase text-faint">MUSDC</dd>
            </div>
          </dl>
          <p className="mt-3 font-mono text-[9px] leading-relaxed text-warn">
            {t("eastboard.trade.fixture.invalidPayout", {
              amount: Number.isFinite(invalidPayout)
                ? invalidPayout.toFixed(2)
                : "—",
            })}
          </p>
          <button
            disabled={
              !Number.isInteger(numericYesPriceCents) ||
              numericYesPriceCents < 1 ||
              numericYesPriceCents > 99 ||
              numericShares <= 0 ||
              !Number.isFinite(maxCost) ||
              maxCost > balance
            }
            onClick={submit}
            type="button"
            className="mt-5 w-full bg-accent px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-canvas disabled:cursor-not-allowed disabled:opacity-35 active:translate-y-px"
          >
            {t("eastboard.trade.fixture.submit")}
          </button>
          {message && (
            <p
              role="status"
              className="mt-3 text-[11px] leading-relaxed text-muted"
            >
              {message}
            </p>
          )}
        </aside>
      </div>

      <details className="group border-y border-rule">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-5 py-4 font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-ink">
            {t("eastboard.trade.appendix.title")}
          </span>
          <span className="text-[9px] uppercase tracking-[0.1em] text-accent">
            {t("eastboard.trade.appendix.view")}
          </span>
        </summary>
        <div className="border-t border-rule py-5 text-[12px] leading-relaxed text-muted">
          {t("eastboard.trade.fixture.appendixBody", {
            close: cell.template.closeLabel,
          })}
        </div>
      </details>
    </div>
  );
}

function NumericYesPriceCentsIsValid(cents: number): boolean {
  return Number.isInteger(cents) && cents >= 1 && cents <= 99;
}
