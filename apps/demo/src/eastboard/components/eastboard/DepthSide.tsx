import { useTranslation } from "react-i18next";

export interface DepthRow {
  id: string;
  priceLabel: string;
  sizeLabel: string;
  fillPercent: number;
  disabled?: boolean;
}

interface DepthSideProps {
  label: string;
  side: "bid" | "ask";
  rows: DepthRow[];
  emptyLabel?: string;
  onSelect?: (row: DepthRow) => void;
}

export function DepthSide({
  label,
  side,
  rows,
  emptyLabel,
  onSelect,
}: DepthSideProps) {
  const { t } = useTranslation();
  const bid = side === "bid";
  const resolvedEmptyLabel = emptyLabel ?? t("eastboard.trade.depth.empty");

  return (
    <div data-depth-side={side}>
      <div className="flex items-end justify-between gap-3">
        <p
          className={`font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${bid ? "text-pos" : "text-neg"}`}
        >
          {label}
        </p>
        <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-faint">
          {bid
            ? t("eastboard.trade.depth.sizePrice")
            : t("eastboard.trade.depth.priceSize")}
        </span>
      </div>
      <div className="mt-2 divide-y divide-subtle border-y border-subtle">
        {rows.length === 0 ? (
          <p className="py-3 font-mono text-[9px] text-faint">
            {resolvedEmptyLabel}
          </p>
        ) : (
          rows.map((row) => {
            const price = (
              <span className="relative font-semibold text-ink">
                {row.priceLabel}
              </span>
            );
            const size = (
              <span className="relative text-muted">{row.sizeLabel}</span>
            );

            return (
              <button
                key={row.id}
                type="button"
                disabled={row.disabled}
                onClick={() => onSelect?.(row)}
                aria-label={t(
                  bid
                    ? "eastboard.trade.depth.tradeBidAria"
                    : "eastboard.trade.depth.tradeAskAria",
                  { price: row.priceLabel },
                )}
                className="relative flex w-full justify-between overflow-hidden py-2.5 font-mono text-[10px] transition-colors hover:bg-raised focus-visible:z-[1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  data-depth-fill={side}
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-y-0 opacity-10 ${bid ? "right-0 bg-pos" : "left-0 bg-neg"}`}
                  style={{
                    width: `${Math.max(0, Math.min(100, row.fillPercent))}%`,
                  }}
                />
                {bid ? (
                  <>
                    {size}
                    {price}
                  </>
                ) : (
                  <>
                    {price}
                    {size}
                  </>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
