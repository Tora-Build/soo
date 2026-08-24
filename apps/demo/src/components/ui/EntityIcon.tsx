import { useState } from "react";
import { cn } from "../../lib/utils";
import { useMarketIcon } from "../../hooks/useMarketIcon";
import { useGraduationRing } from "../../hooks/useGraduationRing";

function getInitials(name: string): string {
  const words = name
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const RING_ACCENT = "var(--accent, #D4A04A)";
const RING_TRACK = "rgba(255, 255, 255, 0.08)";

export interface EntityIconProps {
  question: string;
  size?: "sm" | "md" | "lg";
  market?: {
    address: `0x${string}`;
    stage: string;
  };
}

export const EntityIcon = ({
  question,
  size = "md",
  market,
}: EntityIconProps) => {
  const { icon } = useMarketIcon(question);
  const { progress } = useGraduationRing({
    marketAddress: market?.address,
    stage: market?.stage,
  });
  const [failed, setFailed] = useState(false);

  const dim =
    size === "sm" ? "w-9 h-9" : size === "lg" ? "w-14 h-14" : "w-11 h-11";
  const textSize =
    size === "sm" ? "text-xs" : size === "lg" ? "text-base" : "text-sm";

  const showImage =
    !!icon?.url && icon.source !== "category_fallback" && !failed;

  const ringMode: "bonding" | "graduated" | "plain" | "dismissed" = !market
    ? "plain"
    : market.stage === "dismissed"
      ? "dismissed"
      : market.stage === "bonding"
        ? "bonding"
        : "graduated";

  const ringStyle: React.CSSProperties = (() => {
    if (ringMode === "bonding") {
      const pct = progress ?? 0;
      return {
        background: `conic-gradient(${RING_ACCENT} ${pct}%, ${RING_TRACK} ${pct}%)`,
      };
    }
    if (ringMode === "graduated") {
      return { background: RING_ACCENT };
    }
    return {};
  })();

  const outerRingClass = cn(
    dim,
    "shrink-0 rounded-full",
    ringMode === "bonding" || ringMode === "graduated"
      ? "p-[2.5px]"
      : ringMode === "dismissed"
        ? "p-[2.5px] bg-rule/40"
        : "ring-1 ring-rule",
  );

  const innerTileClass = cn(
    "h-full w-full rounded-full overflow-hidden bg-inset",
  );

  const accentColor = icon?.accentColor ?? "#888888";
  const tileBody = showImage ? (
    <img
      src={icon!.url!}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  ) : (
    <div
      className={cn(
        "h-full w-full flex items-center justify-center font-mono font-bold tracking-tight",
        textSize,
      )}
      style={{
        backgroundColor: `${accentColor}26`,
        color: accentColor,
      }}
      aria-hidden="true"
    >
      {getInitials(icon?.entityName || question)}
    </div>
  );

  // The ring is DATA, not decoration — a partial ring is graduation progress
  // on the bonding curve, a solid one means the order book is live. Nothing
  // on screen said so, and an unexplained badge that varies between cards
  // reads as a bug. The title is where a curious hover lands.
  const ringTitle =
    ringMode === "bonding"
      ? `Bonding curve — ${Math.round(progress ?? 0)}% of the fees needed to graduate to the order book`
      : ringMode === "graduated"
        ? "Graduated — this market trades on the order book"
        : ringMode === "dismissed"
          ? "Dismissed — refunds only"
          : undefined;

  return (
    <div className={outerRingClass} style={ringStyle} title={ringTitle}>
      <div className={innerTileClass}>{tileBody}</div>
    </div>
  );
};
