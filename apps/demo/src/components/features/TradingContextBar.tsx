import { Link } from "react-router-dom";
import { ArrowLeft, Clock, Layers, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CategoryBadge } from "../ui/CategoryBadge";
import { EntityIcon } from "../ui/EntityIcon";

interface TradingContextBarProps {
  question: string;
  address: string;
  stage: string;
  deadline?: number;
  category?: string;
  event?: string;
  mode: "amm" | "orderbook";
  showOrderbookSwitch?: boolean;
  variant?: "default" | "megaeth";
  /** Arcade cover art shown in place of the EntityIcon on the megaeth
   *  variant. Tone tints the ring; no imageSrc keeps the EntityIcon. */
  titleArtwork?: {
    imageSrc?: string;
    imageTone?: "amber" | "mint" | "blue";
    label?: string;
  };
  /** When provided, the AMM/Orderbook toggle calls this callback instead
   *  of navigating via Link. Used by MarketDrawer to swap modes in place. */
  onModeChange?: (mode: "amm" | "orderbook") => void;
  /** When provided, the bar is rendered for a modal/drawer surface: the
   *  back-to-markets link is hidden and a close button is rendered after
   *  the AMM/Orderbook toggle. Standalone pages omit this prop and keep
   *  the back link + no close button. */
  onClose?: () => void;
}

export const TradingContextBar = ({
  question,
  address,
  stage,
  deadline,
  category,
  event,
  mode,
  showOrderbookSwitch = false,
  variant = "default",
  titleArtwork,
  onModeChange,
  onClose,
}: TradingContextBarProps) => {
  const { t } = useTranslation();
  const timeRemaining = deadline ? getTimeRemaining(deadline, t) : null;
  const isMegaEthVariant = variant === "megaeth";
  const modeControlClass = (isActive: boolean) =>
    isMegaEthVariant
      ? `megaeth-mode-control px-4 py-2 text-xs font-mono uppercase tracking-[0.12em] transition-colors ${
          isActive ? "is-active" : "text-muted hover:text-ink"
        }`
      : `px-4 py-2 text-xs font-mono uppercase tracking-[0.12em] transition-colors ${
          isActive ? "bg-accent text-canvas" : "text-muted hover:text-ink"
        }`;

  return (
    <div
      className={`bg-raised px-4 py-3 flex items-center gap-4 ${
        isMegaEthVariant ? "trading-context-bar--megaeth" : ""
      }`}
    >
      {!onClose && (
        <div className="flex items-center gap-3 shrink-0">
          <Link
            to="/markets"
            className="text-muted hover:text-ink transition-colors flex items-center gap-1 text-xs font-mono"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>{t("nav.markets")}</span>
          </Link>
        </div>
      )}

      <div className="flex items-center gap-3 flex-1 min-w-0">
        {isMegaEthVariant && titleArtwork?.imageSrc ? (
          <span
            className={`trading-context-art ${titleArtwork.imageTone ?? "amber"}`}
            aria-hidden="true"
          >
            <img src={titleArtwork.imageSrc} alt="" loading="lazy" />
          </span>
        ) : (
          <EntityIcon
            question={question}
            size="sm"
            market={{ address: address as `0x${string}`, stage }}
          />
        )}
        <h1 className="text-sm font-medium text-ink truncate min-w-0">
          {question}
        </h1>

        {event && (
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent shrink-0 flex items-center gap-1">
            <Layers className="w-3 h-3" />
            {event}
          </span>
        )}

        {category && (
          <span className="shrink-0">
            <CategoryBadge category={category} />
          </span>
        )}

        {timeRemaining && (
          <span className="text-xs text-muted flex items-center gap-1 shrink-0 font-mono">
            <Clock className="w-3 h-3" />
            {timeRemaining}
          </span>
        )}
      </div>

      <div className="flex items-center shrink-0">
        {onModeChange ? (
          <button
            type="button"
            onClick={() => onModeChange("amm")}
            className={modeControlClass(mode === "amm")}
          >
            {t("nav.amm")}
          </button>
        ) : (
          <Link
            to={`/amm/${address}`}
            className={modeControlClass(mode === "amm")}
          >
            {t("nav.amm")}
          </Link>
        )}
        {showOrderbookSwitch &&
          (onModeChange ? (
            <button
              type="button"
              onClick={() => onModeChange("orderbook")}
              className={modeControlClass(mode === "orderbook")}
            >
              {t("nav.orderbook")}
            </button>
          ) : (
            <Link
              to={`/orderbook/${address}`}
              className={modeControlClass(mode === "orderbook")}
            >
              {t("nav.orderbook")}
            </Link>
          ))}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="ml-2 px-3 py-2 border border-rule bg-inset hover:bg-raised hover:border-accent text-muted hover:text-accent transition-colors flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="w-5 h-5" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
};

function getTimeRemaining(
  deadline: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (deadline > 4102444800) return t("marketsPage.noExpiry");
  const remaining = deadline - Date.now() / 1000;
  if (remaining <= 0) return null;
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  if (days > 0) return t("liquidityPage.time.dayHour", { days, hours });
  const mins = Math.floor((remaining % 3600) / 60);
  if (hours > 0)
    return t("liquidityPage.time.hourMinute", { hours, minutes: mins });
  return t("liquidityPage.time.minuteShort", { count: mins });
}
