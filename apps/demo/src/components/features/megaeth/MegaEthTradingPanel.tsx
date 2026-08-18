/**
 * MegaEthTradingPanel — the arcade-styled ("megaeth" variant) skin around
 * SimpleTradingPanel. Renders an optional cover strip (image + tone-tinted
 * gradient + label/title copy) above the same real AMM trade form every
 * other surface uses; the trade logic itself lives in SimpleTradingPanel.
 */
import { SimpleTradingPanel } from "../SimpleTradingPanel";
import type { ConfirmedArenaTrade } from "../../../features/arena/types";
import "./MegaEthTradingPanel.css";

interface MegaEthTradingPanelProps {
  address: `0x${string}`;
  isGraduated?: boolean;
  isSettled?: boolean;
  coverImageSrc?: string;
  coverTone?: "amber" | "mint" | "blue";
  coverTitle?: string;
  coverLabel?: string;
  initialOutcome?: "yes" | "no";
  onTradeConfirmed?: (trade: ConfirmedArenaTrade) => void | Promise<void>;
}

export function MegaEthTradingPanel({
  address,
  isGraduated,
  isSettled,
  coverImageSrc,
  coverTone = "amber",
  coverTitle,
  coverLabel,
  initialOutcome,
  onTradeConfirmed,
}: MegaEthTradingPanelProps) {
  return (
    <section
      className="megaeth-trading-panel"
      data-testid="megaeth-trading-panel"
    >
      {coverImageSrc && (
        <div className={`megaeth-trading-panel__cover ${coverTone}`}>
          <img src={coverImageSrc} alt={coverTitle ?? ""} />
          <div className="megaeth-trading-panel__cover-copy">
            {coverLabel && <span>{coverLabel}</span>}
            {coverTitle && <b>{coverTitle}</b>}
          </div>
        </div>
      )}

      <div className="megaeth-trading-panel__body">
        <SimpleTradingPanel
          address={address}
          isGraduated={isGraduated}
          isSettled={isSettled}
          variant="megaeth"
          initialOutcome={initialOutcome}
          onTradeConfirmed={onTradeConfirmed}
        />
      </div>
    </section>
  );
}
