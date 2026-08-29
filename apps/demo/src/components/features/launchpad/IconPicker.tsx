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
 * No palette of pre-chosen icons: the icon is the creator's identity for
 * their market, and offering ours would make every market look like ours.
 * A market with no link falls back to the automatic chain (a known entity's
 * logo, else the question's initials).
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

  // A new link deserves a fresh verdict; without this a single broken URL
  // poisons the preview for every later one.
  useEffect(() => {
    setLoadFailed(false);
  }, [value]);

  // What the card will actually draw if this creator supplies nothing.
  const auto = localIconFor(question);
  const showUrl = !!value.trim() && !issue && !loadFailed;

  return (
    <div className="space-y-2">
      <label
        htmlFor="market-icon-url"
        className="font-mono text-xs uppercase tracking-[0.12em] text-muted"
      >
        {t("launchpad.iconLabel", { defaultValue: "Market icon" })}
      </label>

      <div className="flex items-start gap-3">
        {/* Preview at the exact diameter cards draw, so what is approved
            here is what ships. */}
        <div className="shrink-0 text-center">
          <div
            className="rounded-full flex items-center justify-center ring-1 ring-rule overflow-hidden bg-inset"
            style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
            data-testid="icon-preview"
          >
            {showUrl ? (
              <img
                src={value.trim()}
                alt=""
                aria-hidden="true"
                // The creator's server never learns which market page a
                // viewer came from.
                referrerPolicy="no-referrer"
                onError={() => setLoadFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : auto?.imageUrl ? (
              <img
                src={auto.imageUrl}
                alt=""
                aria-hidden="true"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover opacity-70"
              />
            ) : auto ? (
              <span className="text-xl leading-none opacity-70">{auto.emoji}</span>
            ) : (
              <span className="font-mono text-sm font-bold text-muted">
                {initialsOf(question || "?")}
              </span>
            )}
          </div>
          <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
            {PREVIEW_PX}px
          </span>
        </div>

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
                      "Optional. Left empty, this market uses the icon on the left.",
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
