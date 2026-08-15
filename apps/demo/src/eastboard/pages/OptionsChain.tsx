import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { OPTION_UNDERLYINGS, type OptionTemplate } from "../core";
import { useTranslation } from "react-i18next";
import {
  useOptionChain,
  exchangeIsoDate,
  type OptionChainCell,
  type OptionCellStatus,
} from "../hooks/useOptionChain";
import { ActivationWizard } from "../components/eastboard/ActivationWizard";
import { TradeDrawer } from "../components/eastboard/TradeDrawer";
import { useSimulationStore } from "../store/useSimulationStore";
import {
  dragScrollOffsets,
  isDragGesture,
  type DragOrigin,
} from "../lib/dragScroll";
import { complementWadPriceCents, formatCents, formatWadPriceCents } from "../lib/orderTicks";

// "available" and "activating" share one presentation on the grid; the
// wizard modal explains whether a click creates or resumes a market.
const STATUS_KEY: Record<OptionCellStatus, string> = {
  available: "eastboard.chain.status.available",
  activating: "eastboard.chain.status.activating",
  closed: "eastboard.chain.status.closed",
  live: "eastboard.chain.status.live",
  settled: "eastboard.chain.status.settled",
};

const META_KEY: Record<OptionCellStatus, string> = {
  available: "eastboard.chain.meta.available",
  activating: "eastboard.chain.meta.activating",
  closed: "eastboard.chain.meta.settled",
  live: "eastboard.chain.meta.live",
  settled: "eastboard.chain.meta.settled",
};

const CELL_STATE: Record<OptionCellStatus, string> = {
  available: "new",
  activating: "resume",
  closed: "closed",
  live: "live",
  settled: "settled",
};

const EXPIRY_COLUMN_WIDTH = 200;

export function OptionsChain() {
  const { t } = useTranslation();
  const [underlyingId, setUnderlyingId] = useState<string>(
    OPTION_UNDERLYINGS[0].id,
  );
  const [activationTemplate, setActivationTemplate] =
    useState<OptionTemplate | null>(null);
  const [tradeCell, setTradeCell] = useState<OptionChainCell | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [displayedOutcome, setDisplayedOutcome] = useState<0 | 1>(1);
  const [initialTradeAction, setInitialTradeAction] = useState<
    "buyYes" | "sellYes"
  >("buyYes");
  const activate = useSimulationStore((state) => state.activate);
  const chain = useOptionChain(underlyingId);
  const strikes = useMemo(
    () => [
      ...new Map(
        chain.templates.map((item) => [item.strikeRaw.toString(), item]),
      ).values(),
    ],
    [chain.templates],
  );
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dragOrigin = useRef<DragOrigin | null>(null);
  const positionedFocus = useRef<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [scrollEdges, setScrollEdges] = useState({
    canScrollLeft: false,
    canScrollRight: false,
  });

  const focusedExpiry = useMemo(
    () =>
      chain.expiries.find((expiry) =>
        chain.templates.some(
          (template) =>
            template.expiry === expiry && template.closeTs * 1_000 > nowMs,
        ),
      ) ?? null,
    [chain.expiries, chain.templates, nowMs],
  );
  const focusKind = focusedExpiry
    ? focusedExpiry === exchangeIsoDate(chain.underlying.session, nowMs)
      ? "today"
      : "next"
    : null;
  const focusLabel = focusKind
    ? t(
        focusKind === "today"
          ? "eastboard.chain.today"
          : "eastboard.chain.nextSession",
      )
    : null;

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const updateScrollEdges = useCallback(() => {
    const board = boardRef.current;
    if (!board) return;
    const maxScrollLeft = Math.max(0, board.scrollWidth - board.clientWidth);
    const next = {
      canScrollLeft: board.scrollLeft > 1,
      canScrollRight: board.scrollLeft < maxScrollLeft - 1,
    };
    setScrollEdges((current) =>
      current.canScrollLeft === next.canScrollLeft &&
      current.canScrollRight === next.canScrollRight
        ? current
        : next,
    );
  }, []);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    updateScrollEdges();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateScrollEdges);
      observer.observe(board);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", updateScrollEdges);
    return () => window.removeEventListener("resize", updateScrollEdges);
  }, [chain.cells.length, chain.chainIsLoading, updateScrollEdges]);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board || !focusedExpiry) return;
    const focusKey = `${underlyingId}:${focusedExpiry}`;
    if (positionedFocus.current !== focusKey) {
      const expiryIndex = chain.expiries.indexOf(focusedExpiry);
      if (expiryIndex >= 0) {
        // Preserve the historical columns but place the active session beside
        // the left strike rail. The focused column then remains sticky on md+.
        board.scrollLeft = expiryIndex * EXPIRY_COLUMN_WIDTH;
        positionedFocus.current = focusKey;
      }
    }
    updateScrollEdges();
  }, [
    chain.chainIsLoading,
    chain.cells.length,
    chain.expiries,
    focusedExpiry,
    underlyingId,
    updateScrollEdges,
  ]);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    // Ignore secondary buttons and touch, which pans natively already.
    if (event.pointerType === "touch" || event.button !== 0) return;
    const board = boardRef.current;
    if (!board) return;
    dragOrigin.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      scrollLeft: board.scrollLeft,
      scrollTop: board.scrollTop,
    };
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const origin = dragOrigin.current;
      const board = boardRef.current;
      if (!origin || !board) return;
      if (!panning && !isDragGesture(origin, event.clientX, event.clientY))
        return;
      if (!panning) {
        setPanning(true);
        board.setPointerCapture(event.pointerId);
      }
      const next = dragScrollOffsets(origin, event.clientX, event.clientY);
      board.scrollLeft = next.left;
      board.scrollTop = next.top;
    },
    [panning],
  );

  const endPan = useCallback(
    (event: React.PointerEvent) => {
      const board = boardRef.current;
      if (board?.hasPointerCapture(event.pointerId)) {
        board.releasePointerCapture(event.pointerId);
      }
      dragOrigin.current = null;
      // Leave `panning` set until the click event has passed so a pan does not
      // open the cell it finished over; the click handler clears it.
      if (panning) window.setTimeout(() => setPanning(false), 0);
    },
    [panning],
  );

  const liveCount = chain.cells.filter((cell) => cell.status === "live").length;
  const hasMarket = (cell: OptionChainCell) => cell.status === "live";
  const visibleStrikes = useMemo(
    () =>
      activeOnly
        ? strikes.filter((strikeTemplate) =>
            chain.cells.some(
              (cell) =>
                cell.template.strikeRaw === strikeTemplate.strikeRaw &&
                hasMarket(cell),
            ),
          )
        : strikes,
    [activeOnly, chain.cells, strikes],
  );
  const activeCell = activationTemplate
    ? chain.cells.find((cell) => cell.template.id === activationTemplate.id)
    : null;

  const openCell = (cell: OptionChainCell) => {
    if (panning) return;
    if (
      cell.status === "live" ||
      cell.status === "closed" ||
      cell.status === "settled"
    ) {
      setInitialTradeAction(displayedOutcome === 1 ? "buyYes" : "sellYes");
      setTradeCell(cell);
      return;
    }
    setActivationTemplate(cell.template);
  };

  return (
    <div>
      <section className="grid gap-8 border-b border-rule pb-9 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.5fr)] lg:items-end">
        <div>
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-accent">
            {t("eastboard.hero.eyebrow")}
          </p>
          <h1 className="mt-4 max-w-[740px] font-heading text-[36px] font-semibold leading-[0.98] tracking-[-0.045em] text-ink md:text-[48px]">
            {t("eastboard.hero.title")}
          </h1>
          <p className="mt-5 max-w-[66ch] text-sm leading-relaxed text-muted md:text-base">
            {t("eastboard.hero.body")}
          </p>
        </div>
        <dl className="grid grid-cols-3 border-y border-rule py-4 font-mono">
          <Metric
            label={t("eastboard.metrics.cells")}
            value={String(chain.cells.length)}
          />
          <Metric
            label={t("eastboard.metrics.live")}
            value={String(liveCount)}
          />
          <Metric
            label={t("eastboard.metrics.close")}
            value={chain.templates[0]?.closeLabel ?? "—"}
          />
        </dl>
      </section>

      <section className="grid gap-6 border-b border-rule py-7 md:grid-cols-[minmax(260px,0.78fr)_minmax(0,1.22fr)] md:items-center">
        <div>
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-accent">
            {t("eastboard.chain.payoff.eyebrow")}
          </p>
          <p className="mt-2 max-w-[48ch] text-[12px] leading-relaxed text-muted">
            {t("eastboard.chain.payoff.body")}
          </p>
        </div>
        <dl className="grid grid-cols-3 font-mono">
          <div className="px-3 first:pl-0">
            <dt className="text-[8px] uppercase tracking-[0.12em] text-faint">
              {t("eastboard.chain.payoff.correct")}
            </dt>
            <dd className="mt-2 text-base font-semibold text-pos">
              {formatCents(100, 0)}
            </dd>
            <dd className="mt-1 text-[8px] uppercase text-faint">
              {t("eastboard.chain.payoff.perShare")}
            </dd>
          </div>
          <div className="border-l border-rule px-3">
            <dt className="text-[8px] uppercase tracking-[0.12em] text-faint">
              {t("eastboard.chain.payoff.wrong")}
            </dt>
            <dd className="mt-2 text-base font-semibold text-neg">
              {formatCents(0, 0)}
            </dd>
            <dd className="mt-1 text-[8px] uppercase text-faint">
              {t("eastboard.chain.payoff.perShare")}
            </dd>
          </div>
          <div className="border-l border-rule px-3 last:pr-0">
            <dt className="text-[8px] uppercase tracking-[0.12em] text-faint">
              {t("eastboard.chain.payoff.invalid")}
            </dt>
            <dd className="mt-2 text-base font-semibold text-warn">
              {formatCents(50, 0)}
            </dd>
            <dd className="mt-1 text-[8px] uppercase text-faint">
              {t("eastboard.chain.payoff.eitherSide")}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-7">
        <div className="flex items-end justify-between gap-5">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.17em] text-faint">
              {t("eastboard.chain.underlying")}
            </p>
            <h2 className="mt-2 font-heading text-xl font-semibold tracking-[-0.035em] text-ink">
              {chain.underlying.localName} / {chain.underlying.name}
            </h2>
          </div>
          <div className="flex items-start">
            <div
              role="group"
              aria-label={t("eastboard.chain.filterMarkets")}
              className="grid grid-cols-2 overflow-hidden border border-rule"
            >
              <button
                type="button"
                aria-pressed={!activeOnly}
                onClick={() => setActiveOnly(false)}
                className={`border-r border-rule px-3 py-2 font-mono text-[9px] font-bold uppercase tracking-[0.12em] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                  !activeOnly
                    ? "bg-accent text-canvas"
                    : "text-muted hover:bg-raised hover:text-ink"
                }`}
              >
                {t("eastboard.chain.all")}
              </button>
              <button
                type="button"
                aria-pressed={activeOnly}
                onClick={() => setActiveOnly(true)}
                className={`px-3 py-2 font-mono text-[9px] font-bold uppercase tracking-[0.12em] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                  activeOnly
                    ? "bg-accent text-canvas"
                    : "text-muted hover:bg-raised hover:text-ink"
                }`}
              >
                {t("eastboard.chain.active")}
              </button>
            </div>
            <div
              role="group"
              aria-label={t("eastboard.chain.displayedOutcome")}
              className="ml-2 grid grid-cols-2 overflow-hidden border border-rule"
            >
              <button
                type="button"
                aria-pressed={displayedOutcome === 1}
                aria-label={t("eastboard.chain.outcomeCallAria")}
                onClick={() => setDisplayedOutcome(1)}
                title={t("eastboard.chain.outcomeCallRule")}
                className={`border-r border-rule px-3 py-2 font-mono text-[9px] font-bold uppercase tracking-[0.12em] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                  displayedOutcome === 1
                    ? "bg-pos text-canvas"
                    : "text-muted hover:bg-raised hover:text-ink"
                }`}
              >
                CALL
              </button>
              <button
                type="button"
                aria-pressed={displayedOutcome === 0}
                aria-label={t("eastboard.chain.outcomePutAria")}
                onClick={() => setDisplayedOutcome(0)}
                title={t("eastboard.chain.outcomePutRule")}
                className={`px-3 py-2 font-mono text-[9px] font-bold uppercase tracking-[0.12em] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                  displayedOutcome === 0
                    ? "bg-neg text-canvas"
                    : "text-muted hover:bg-raised hover:text-ink"
                }`}
              >
                PUT
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 flex gap-6 overflow-x-auto border-b border-rule">
          {OPTION_UNDERLYINGS.map((underlying) => (
            <button
              key={underlying.id}
              type="button"
              onClick={() => setUnderlyingId(underlying.id)}
              className={`relative shrink-0 border-b-2 px-1 pb-3 pt-2 text-left transition-colors active:translate-y-px ${
                underlying.id === underlyingId
                  ? "border-accent bg-accent text-canvas"
                  : "border-transparent text-muted hover:border-rule hover:text-ink"
              }`}
            >
              <span className="block font-mono text-[10px] font-bold uppercase tracking-[0.08em]">
                {underlying.symbol}
              </span>
              <span className="mt-1 block text-[10px] opacity-70">
                {underlying.localName}
              </span>
            </button>
          ))}
        </div>
      </section>

      {chain.fixtureMode && (
        <div className="mt-5 border border-info/30 bg-raised px-4 py-3 font-mono text-[9px] uppercase leading-relaxed tracking-[0.11em] text-muted">
          {t("eastboard.chain.fixtureNotice")}
        </div>
      )}
      {chain.metadataCandidates > 0 && (
        <p className="mt-3 font-mono text-[9px] uppercase tracking-[0.11em] text-faint">
          {t("eastboard.chain.hiddenMarkets", {
            count: chain.metadataCandidates,
          })}
        </p>
      )}
      {chain.chainError && !chain.fixtureMode && (
        <div className="mt-5 flex items-center justify-between gap-4 border border-neg/40 bg-neg-soft p-4 text-sm text-neg">
          <span>
            {chain.chainErrorSource === "indexer"
              ? t("eastboard.chain.indexerUnavailable")
              : chain.chainErrorSource === "quote"
                ? t("eastboard.chain.priceUnavailable")
                : t("eastboard.chain.verificationUnavailable")}
          </span>
          <button
            type="button"
            onClick={() => void chain.refetch()}
            className="border border-neg/50 px-3 py-2 font-mono text-[9px] uppercase active:translate-y-px"
          >
            {t("eastboard.chain.retry")}
          </button>
        </div>
      )}

      {chain.chainIsLoading && !chain.fixtureMode ? (
        <ChainSkeleton />
      ) : chain.cells.length === 0 ? (
        <div className="mt-8 border-y border-rule py-16 text-center">
          <h3 className="font-heading text-xl uppercase text-ink">
            {t("eastboard.chain.emptyTitle")}
          </h3>
          <p className="mt-2 text-sm text-muted">
            {t("eastboard.chain.emptyBody")}
          </p>
        </div>
      ) : (
        <div
          ref={boardRef}
          aria-label={t("eastboard.chain.optionsAria")}
          data-can-scroll-left={scrollEdges.canScrollLeft}
          data-can-scroll-right={scrollEdges.canScrollRight}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onScroll={updateScrollEdges}
          // A bounded viewport with its own overflow on both axes: the board
          // is the canvas and the pointer drags it, the way a map does.
          className={`mt-6 max-h-[70vh] overflow-auto overscroll-contain border-y border-rule bg-raised/25 [--right-strike-rail-width:0px] [--strike-rail-width:88px] md:[--strike-rail-width:96px] 2xl:[--right-strike-rail-width:112px] 2xl:[--strike-rail-width:112px] ${
            panning ? "cursor-grabbing select-none" : "cursor-grab"
          }`}
        >
          <div className="w-max">
            <div
              className="sticky top-0 z-sticky grid border-b border-rule bg-inset"
              style={{
                gridTemplateColumns: `var(--strike-rail-width) repeat(${chain.expiries.length}, ${EXPIRY_COLUMN_WIDTH}px) var(--right-strike-rail-width)`,
              }}
            >
              <div
                data-strike-rail="left"
                className={`sticky left-0 z-[3] bg-inset px-2 py-3 font-mono text-[9px] uppercase tracking-[0.15em] text-faint after:pointer-events-none after:absolute after:inset-y-0 after:left-full after:w-4 after:bg-gradient-to-r after:from-inset after:to-transparent after:transition-opacity after:content-[''] md:px-3 2xl:px-4 ${
                  scrollEdges.canScrollLeft
                    ? "after:opacity-100"
                    : "after:opacity-0"
                }`}
              >
                {t("eastboard.chain.strike")}
              </div>
              {chain.expiries.map((expiry) => (
                <div
                  key={expiry}
                  data-expiry={expiry}
                  data-session-focus={
                    expiry === focusedExpiry
                      ? (focusKind ?? undefined)
                      : undefined
                  }
                  className={`border-l border-rule p-3 ${
                    expiry === focusedExpiry
                      ? "bg-inset md:sticky md:left-[var(--strike-rail-width)] md:z-[1] md:border-r md:shadow-[10px_0_18px_-18px_rgba(7,9,9,0.8)]"
                      : ""
                  }`}
                >
                  <p className="flex items-center gap-2 font-mono text-[10px] font-semibold tabular-nums text-ink">
                    <span>{expiry.slice(5)}</span>
                    {expiry === focusedExpiry && focusLabel && (
                      <span className="whitespace-nowrap border border-accent/50 px-1.5 py-0.5 text-[7px] uppercase tracking-[0.1em] text-accent">
                        {focusLabel}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 font-mono text-[8px] uppercase tracking-[0.1em] text-faint">
                    {
                      chain.templates.find((item) => item.expiry === expiry)
                        ?.closeLabel
                    }
                  </p>
                </div>
              ))}
              <div
                aria-hidden="true"
                data-strike-rail="right"
                className={`sticky right-0 z-[3] hidden bg-inset p-3 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-faint before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-gradient-to-l before:from-inset before:to-transparent before:transition-opacity before:content-[''] 2xl:block ${
                  scrollEdges.canScrollRight
                    ? "before:opacity-100"
                    : "before:opacity-0"
                }`}
              >
                {t("eastboard.chain.strike")}
              </div>
            </div>
            {visibleStrikes.map((strikeTemplate) => (
              <div
                key={strikeTemplate.strikeRaw.toString()}
                className="grid border-b border-rule last:border-b-0"
                style={{
                  gridTemplateColumns: `var(--strike-rail-width) repeat(${chain.expiries.length}, ${EXPIRY_COLUMN_WIDTH}px) var(--right-strike-rail-width)`,
                }}
              >
                <div
                  data-strike-rail="left"
                  className={`sticky left-0 z-[3] flex flex-col justify-center bg-canvas px-2 py-3 after:pointer-events-none after:absolute after:inset-y-0 after:left-full after:w-4 after:bg-gradient-to-r after:from-canvas after:to-transparent after:transition-opacity after:content-[''] md:px-3 2xl:px-4 ${
                    scrollEdges.canScrollLeft
                      ? "after:opacity-100"
                      : "after:opacity-0"
                  }`}
                >
                  <strong className="font-mono text-xs tabular-nums tracking-[-0.02em] text-ink md:text-sm">
                    {strikeTemplate.strikeLabel}
                  </strong>
                </div>
                {chain.expiries.map((expiry) => {
                  const found = chain.cells.find(
                    (item) =>
                      item.template.expiry === expiry &&
                      item.template.strikeRaw === strikeTemplate.strikeRaw,
                  );
                  const cell =
                    activeOnly && found && !hasMarket(found)
                      ? undefined
                      : found;
                  // A missing cell must still occupy its grid track, or the
                  // remaining cells slide left and every column mislabels.
                  return cell ? (
                    <OptionCellButton
                      key={cell.template.id}
                      cell={cell}
                      focused={expiry === focusedExpiry}
                      displayedOutcome={displayedOutcome}
                      onClick={() => openCell(cell)}
                    />
                  ) : (
                    <div
                      key={`${expiry}-empty`}
                      aria-hidden="true"
                      className={`min-h-[88px] border-l border-rule ${
                        expiry === focusedExpiry
                          ? "bg-canvas md:sticky md:left-[var(--strike-rail-width)] md:z-[1] md:border-r md:shadow-[10px_0_18px_-18px_rgba(7,9,9,0.8)]"
                          : ""
                      }`}
                    />
                  );
                })}
                <div
                  aria-hidden="true"
                  data-strike-rail="right"
                  className={`sticky right-0 z-[3] hidden flex-col justify-center bg-canvas p-3 text-right before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-gradient-to-l before:from-canvas before:to-transparent before:transition-opacity before:content-[''] 2xl:flex ${
                    scrollEdges.canScrollRight
                      ? "before:opacity-100"
                      : "before:opacity-0"
                  }`}
                >
                  <strong className="font-mono text-sm tabular-nums tracking-[-0.02em] text-ink">
                    {strikeTemplate.strikeLabel}
                  </strong>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <section className="mt-8 grid gap-6 border-t border-rule pt-6 text-[12px] leading-relaxed text-muted md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <p>{t("eastboard.chain.rules.outcome")}</p>
        <p>
          {t("eastboard.chain.rules.timingPrefix")}{" "}
          {chain.fixtureMode
            ? t("eastboard.chain.rules.fixtureTiming")
            : t("eastboard.chain.rules.canonicalTiming")}{" "}
          {t("eastboard.chain.rules.invalidation")}
        </p>
      </section>

      {activationTemplate && (
        <Modal onClose={() => setActivationTemplate(null)}>
          <ActivationWizard
            template={activationTemplate}
            fixtureMode={chain.fixtureMode}
            existingMarketAddress={activeCell?.marketAddress}
            onClose={() => setActivationTemplate(null)}
            onTrade={(marketAddress) => {
              if (chain.fixtureMode) activate(activationTemplate);
              if (activeCell) {
                setTradeCell({
                  ...activeCell,
                  // A freshly activated market is BONDING, not live —
                  // upstream could force "live" because its EVM markets were
                  // book-tradeable at birth; ours graduate first. "live"
                  // here routed brand-new cells into the order-book
                  // terminal, which cannot trade them.
                  status: "activating",
                  marketAddress: marketAddress ?? activeCell.marketAddress,
                  fixture: chain.fixtureMode,
                });
              }
              setActivationTemplate(null);
            }}
          />
        </Modal>
      )}
      {tradeCell && (
        <TradeDrawer
          cell={tradeCell}
          initialAction={initialTradeAction}
          onClose={() => setTradeCell(null)}
        />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-rule px-4 first:border-l-0 first:pl-0 last:pr-0">
      <dt className="text-[8px] uppercase tracking-[0.15em] text-faint">
        {label}
      </dt>
      <dd className="mt-2 text-lg font-semibold tracking-[-0.04em] text-ink">
        {value}
      </dd>
    </div>
  );
}

function OptionCellButton({
  cell,
  focused,
  displayedOutcome,
  onClick,
}: {
  cell: OptionChainCell;
  focused: boolean;
  displayedOutcome: 0 | 1;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const tone =
    cell.status === "live"
      ? "bg-pos-soft hover:bg-pos-soft"
      : cell.status === "settled"
        ? "bg-inset opacity-70"
        : cell.status === "closed"
          ? "bg-inset hover:bg-warn-soft"
          : focused
            ? "bg-canvas hover:bg-accent-muted"
            : "bg-transparent hover:bg-accent-muted";

  const cellPriceLabel = (() => {
    if (cell.status === "settled") {
      if (cell.winningOutcome === 1) {
        return displayedOutcome === 1
          ? `YES ${formatCents(100, 0)}`
          : `NO ${formatCents(0, 0)}`;
      }
      if (cell.winningOutcome === 0) {
        return displayedOutcome === 1
          ? `YES ${formatCents(0, 0)}`
          : `NO ${formatCents(100, 0)}`;
      }
      if (cell.winningOutcome === 2) {
        return `${displayedOutcome === 1 ? "YES" : "NO"} ${formatCents(50, 0)}`;
      }
      return "—";
    }
    if (cell.status !== "live") return "—";
    if (cell.fixture) {
      return displayedOutcome === 1
        ? formatCents(49.5)
        : formatCents(50.5);
    }
    if (cell.yesPriceWad !== undefined) {
      return displayedOutcome === 1
        ? formatWadPriceCents(cell.yesPriceWad)
        : complementWadPriceCents(cell.yesPriceWad);
    }
    return "…";
  })();

  const pricePrefix =
    cell.status === "settled" || cell.status === "live" ? "" : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      data-cell-state={CELL_STATE[cell.status]}
      data-focused-expiry={focused || undefined}
      className={`group min-h-[88px] border-l border-rule p-3 text-left transition-colors focus-visible:relative focus-visible:z-[2] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent active:translate-y-px ${
        focused
          ? "md:sticky md:left-[var(--strike-rail-width)] md:z-[1] md:border-r md:shadow-[10px_0_18px_-18px_rgba(7,9,9,0.8)]"
          : ""
      } ${tone}`}
      aria-label={`${t(STATUS_KEY[cell.status])} ${cell.template.underlyingSymbol} ${cell.template.strikeLabel} ${cell.template.expiry}`}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${cell.status === "live" ? "bg-pos" : cell.status === "closed" ? "bg-warn" : cell.status === "settled" ? "bg-faint" : "border border-faint"}`}
        />
        <span
          className={`font-mono text-[9px] font-bold uppercase tracking-[0.12em] ${cell.status === "live" ? "text-pos" : cell.status === "closed" ? "text-warn" : "text-muted"}`}
        >
          {t(STATUS_KEY[cell.status])}
        </span>
      </span>
      <span className="mt-2 flex items-end justify-between gap-2">
        <span
          data-cell-price="true"
          className="font-mono text-lg font-semibold tabular-nums tracking-[-0.05em] text-ink"
        >
          {cellPriceLabel}
        </span>
        <span className="whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.1em] text-faint">
          {cell.fixture
            ? t("eastboard.chain.meta.fixture")
            : t(META_KEY[cell.status])}
        </span>
      </span>
    </button>
  );
}

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-modal grid place-items-center overflow-y-auto bg-canvas/80 p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
        className="my-5 w-full max-w-[920px] border border-rule bg-canvas shadow-[0_30px_100px_rgba(7,9,9,0.58)]"
      >
        {children}
      </section>
    </div>
  );
}

function ChainSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className="mt-6 border border-rule p-5"
      aria-label={t("eastboard.chain.loadingAria")}
    >
      <div className="h-10 animate-pulse bg-raised" />
      <div className="mt-3 grid grid-cols-4 gap-3">
        {Array.from({ length: 12 }, (_, index) => (
          <div key={index} className="h-20 animate-pulse bg-raised" />
        ))}
      </div>
    </div>
  );
}
