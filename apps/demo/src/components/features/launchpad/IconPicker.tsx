/**
 * The market's icon — supplied by the creator, as an image link.
 *
 * A link rather than an upload, deliberately: an upload needs storage, size
 * and format policing, and a moderation path — three services — while a link
 * needs none, and an upload feature can be added later that simply PRODUCES
 * a link without changing anything on-chain. The URL rides the question
 * string's 300-byte budget, so the meter below is not decoration: without
 * it the failure lands at the final signature.
 *
 * No palette of pre-chosen icons and no inferred ones: the icon is the
 * creator's identity for their market, and anything the product picks on
 * their behalf is the product's identity wearing their name. A market with
 * no link shows the question's initials — which the preview draws, so the
 * empty state is never a surprise.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageIcon, AlertTriangle } from "lucide-react";

import { iconUrlIssue, sqfByteLength, MAX_QUESTION_BYTES } from "../../../lib/iconUrl";
import { localIconFor } from "../../../lib/localIcon";
import { cn } from "../../../lib/utils";

/** Matches EntityIcon's `md` tile — the size every card renders. */
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

/**
 * The tile as cards draw it — beside the question field, where the pairing
 * the product actually ships is visible while it is being composed.
 */
export function IconPreviewTile({
  question,
  value,
}: {
  question: string;
  value: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [value]);
  const url = value.trim();
  const usable = !!url && !iconUrlIssue(url) && !failed;
  const auto = usable ? null : localIconFor(question);
  return (
    <div
      className="shrink-0 rounded-full flex items-center justify-center ring-1 ring-rule overflow-hidden bg-inset"
      style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
      data-testid="icon-preview"
      title={
        usable
          ? "Your icon"
          : auto
            ? "Automatic icon — set a link to replace it"
            : "No icon — cards show these initials"
      }
    >
      {usable ? (
        <img
          src={url}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
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
    </div>
  );
}

export function IconPicker({
  question,
  value,
  onChange,
}: {
  question: string;
  value: string;
  onChange: (icon: string) => void;
}) {
  const { t } = useTranslation();
  const [loadFailed, setLoadFailed] = useState(false);
  const issue = iconUrlIssue(value);
  const bytes = sqfByteLength(question, value);
  const overBudget = bytes > MAX_QUESTION_BYTES;

  // The link is PROBED, not assumed. The preview tile moved next to the
  // question, so without this the "did not load" message could never fire —
  // and a creator would learn their icon is broken from the empty card,
  // after signing. Each new value gets a fresh verdict.
  useEffect(() => {
    setLoadFailed(false);
    const url = value.trim();
    if (!url || iconUrlIssue(url)) return;
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

  return (
    <div className="space-y-2">
      <label
        htmlFor="market-icon-url"
        className="font-mono text-xs uppercase tracking-[0.12em] text-muted"
      >
        {t("launchpad.iconLabel", { defaultValue: "Market icon" })}
      </label>

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="relative">
            <ImageIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-faint" />
            <input
              id="market-icon-url"
              type="url"
              inputMode="url"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder={t("launchpad.iconPlaceholder", {
                defaultValue: "https://…/logo.png",
              })}
              data-testid="icon-url-input"
              className={cn(
                "w-full bg-inset border pl-8 pr-3 py-2 font-mono text-xs text-ink placeholder:text-faint focus:outline-none",
                issue || loadFailed || overBudget
                  ? "border-red-500/60"
                  : "border-rule focus:border-accent",
              )}
            />
          </div>

          {issue ? (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-red-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {issue}
            </p>
          ) : loadFailed ? (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-red-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {t("launchpad.iconUnreachable", {
                defaultValue: "That link did not load as an image",
              })}
            </p>
          ) : (
            <p className="font-mono text-[10px] text-faint leading-relaxed">
              {value.trim()
                ? t("launchpad.iconSetHint", {
                    defaultValue: "Square images look best — shown at 44px on every card.",
                  })
                : t("launchpad.iconEmptyHint", {
                    defaultValue:
                      "Optional — the tile beside your question shows what cards will draw.",
                  })}
            </p>
          )}

          {/* The budget: the icon shares the question's on-chain bytes, and
              the only worse moment to learn that is the final signature. */}
          <p
            className={cn(
              "font-mono text-[10px] tabular-nums",
              overBudget ? "text-red-400" : "text-faint",
            )}
            data-testid="icon-budget"
          >
            {t("launchpad.iconBudget", {
              defaultValue: "{{bytes}}/{{max}} bytes on-chain",
              bytes,
              max: MAX_QUESTION_BYTES,
            })}
            {overBudget &&
              ` — ${t("launchpad.iconBudgetOver", {
                defaultValue: "shorten the question or the link",
              })}`}
          </p>
        </div>
      </div>
    </div>
  );
}
