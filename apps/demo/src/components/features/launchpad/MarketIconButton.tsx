/**
 * The icon circle beside the Forge's question field — clickable.
 *
 * Click opens a small inline panel to paste an https image link, previewed
 * in place at the exact diameter cards draw. The link is saved to the arena
 * backend AFTER the market lands (Launchpad calls `pendingIconUrl()` post-
 * create), never on-chain: a URL in the question hash pinned a mutable
 * target. Left empty, the tile shows what cards draw automatically — a
 * recognised subject's image, or the question's initials.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, AlertTriangle, X } from "lucide-react";

import { localIconFor } from "../../../lib/localIcon";
import { iconLinkIssue } from "../../../hooks/useRemoteMarketIcon";
import { cn } from "../../../lib/utils";

const PREVIEW_PX = 44;

function initialsOf(text: string): string {
  const words = text
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function MarketIconButton({
  question,
  value,
  onChange,
}: {
  question: string;
  value: string;
  onChange: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const issue = iconLinkIssue(value);

  useEffect(() => {
    setLoadFailed(false);
    const url = value.trim();
    if (!url || iconLinkIssue(url)) return;
    let live = true;
    const probe = new Image();
    probe.referrerPolicy = "no-referrer";
    probe.onerror = () => {
      if (live) setLoadFailed(true);
    };
    probe.src = url;
    return () => {
      live = false;
    };
  }, [value]);

  const usable = !!value.trim() && !issue && !loadFailed;
  const auto = usable ? null : localIconFor(question);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("launchpad.iconButton", {
          defaultValue: "Market icon — click to set an image link (optional)",
        })}
        data-testid="market-icon-button"
        className="group relative rounded-full ring-1 ring-rule hover:ring-accent transition-all overflow-hidden flex items-center justify-center bg-inset"
        style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
      >
        {usable ? (
          <img
            src={value.trim()}
            alt=""
            aria-hidden="true"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : auto?.imageUrl ? (
          <img
            src={auto.imageUrl}
            alt=""
            aria-hidden="true"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="font-mono text-sm font-bold text-muted">
            {initialsOf(question || "?")}
          </span>
        )}
        {/* The affordance: a circle that never hints it is a button is a
            feature nobody finds. */}
        <span className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-canvas/60">
          <Pencil className="h-3.5 w-3.5 text-ink" />
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 z-20 w-72 border border-rule bg-raised p-3 space-y-1.5 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              {t("launchpad.iconPanelTitle", { defaultValue: "Icon link (optional)" })}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("common.close", { defaultValue: "Close" })}
              className="text-faint hover:text-ink"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <input
            type="url"
            autoFocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="https://…/logo.png"
            data-testid="icon-url-input"
            className={cn(
              "w-full bg-inset border px-2.5 py-2 font-mono text-xs text-ink placeholder:text-faint focus:outline-none",
              issue || loadFailed ? "border-neg/60" : "border-rule focus:border-accent",
            )}
          />
          {issue ? (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-neg">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {issue}
            </p>
          ) : loadFailed ? (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-neg">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {t("launchpad.iconUnreachable", {
                defaultValue: "That link did not load as an image",
              })}
            </p>
          ) : (
            <p className="font-mono text-[10px] text-faint leading-relaxed">
              {t("launchpad.iconPanelHint", {
                defaultValue:
                  "Square https image, shown at 44px on every card. Stored off-chain; you can change it later. Empty = automatic.",
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
