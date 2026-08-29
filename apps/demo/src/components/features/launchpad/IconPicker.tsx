/**
 * The market's face — a standard field, not an afterthought.
 *
 * Every market gets an icon: the picker infers one from the question and
 * APPLIES it, so the default state is a market that already looks right and
 * the creator's job is approving or replacing it, never remembering to set
 * it. (An "optional" icon field produces a grid where half the cards have a
 * face and half have a letter, which looks like a broken product rather than
 * a permissive one.)
 *
 * One emoji, riding the on-chain question string as an `§icon` SQF section —
 * no upload, no storage, no moderation surface. The size is fixed by the
 * product, not chosen by the creator: the preview here renders at exactly
 * the diameter the explorer and the deck draw, so what you approve is what
 * ships.
 */
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { localIconFor } from "../../../lib/localIcon";
import { cn } from "../../../lib/utils";

/** Matches EntityIcon's `md` tile — the size every card renders. */
const PREVIEW_PX = 44;

const PALETTE = [
  "₿", "Ξ", "◎", "📈", "📉", "⚽", "🏀", "🏆", "🗳️", "🌧️",
  "🌡️", "🚀", "🤖", "🏦", "🎬", "🎵", "⭐", "🔥", "🎯", "🔮",
];

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
  const inferred = useMemo(() => localIconFor(question), [question]);
  const touched = useRef(false);

  // Keep the inferred icon applied while the creator is still typing the
  // question — until they touch the control, at which point their choice is
  // theirs and the inference stops chasing them.
  useEffect(() => {
    if (!touched.current && inferred?.emoji) onChange(inferred.emoji);
  }, [inferred?.emoji, onChange]);

  const pick = (emoji: string) => {
    touched.current = true;
    onChange(emoji);
  };

  const choices = useMemo(() => {
    const lead = inferred?.emoji;
    const rest = PALETTE.filter((p) => p !== lead);
    return (lead ? [lead, ...rest] : rest).slice(0, 12);
  }, [inferred?.emoji]);

  const shown = value || inferred?.emoji || "🔮";
  const accent = inferred?.accentColor ?? "#8a7bd5";

  return (
    <div className="space-y-2">
      <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
        {t("launchpad.iconLabel", { defaultValue: "Market icon" })}
      </label>
      <div className="flex items-start gap-3">
        {/* Preview at the exact diameter cards draw — approving it here is
            approving what ships. */}
        <div className="shrink-0 text-center">
          <div
            className="rounded-full flex items-center justify-center ring-1 ring-rule overflow-hidden"
            style={{
              width: PREVIEW_PX,
              height: PREVIEW_PX,
              backgroundColor: `${accent}26`,
            }}
            data-testid="icon-preview"
          >
            {inferred?.imageUrl && shown === inferred.emoji ? (
              <img
                src={inferred.imageUrl}
                alt=""
                aria-hidden="true"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-xl leading-none">{shown}</span>
            )}
          </div>
          <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
            {PREVIEW_PX}px
          </span>
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1 flex-wrap">
            {choices.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => pick(emoji)}
                aria-pressed={shown === emoji}
                className={cn(
                  "h-8 w-8 flex items-center justify-center text-base border transition-all",
                  shown === emoji
                    ? "border-accent bg-accent-muted"
                    : "border-rule bg-inset hover:bg-raised",
                )}
                data-testid={`icon-pick-${emoji}`}
              >
                {emoji}
              </button>
            ))}
            <input
              type="text"
              value={value}
              onChange={(event) => {
                touched.current = true;
                const text = event.target.value.trim();
                // One grapheme, mirroring the parser's 16-byte cap: an icon
                // field that takes arbitrary text is a second question field.
                const first =
                  [...new Intl.Segmenter().segment(text)][0]?.segment ?? "";
                onChange(first);
              }}
              placeholder="😀"
              className="h-8 w-10 text-center text-base bg-inset border border-rule focus:outline-none focus:border-accent"
              data-testid="icon-custom-input"
              aria-label={t("launchpad.iconCustom", {
                defaultValue: "Custom emoji",
              })}
            />
          </div>
          <p className="font-mono text-[10px] text-faint leading-relaxed">
            {inferred && shown === inferred.emoji
              ? t("launchpad.iconInferred", {
                  defaultValue:
                    "Chosen from your question — pick another or type any emoji.",
                })
              : t("launchpad.iconHint", {
                  defaultValue: "Shown on every card and in the play deck.",
                })}
          </p>
        </div>
      </div>
    </div>
  );
}
