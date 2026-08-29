/**
 * The market's face, chosen at creation.
 *
 * One emoji, riding the on-chain question string as an `§icon` SQF section —
 * no storage, no upload, no size negotiation beyond "one emoji" (the parser
 * hard-caps at 16 bytes and discards anything longer). The quick-picks lead
 * with what the keyword resolver would infer from the question, so accepting
 * the default is one glance and choosing differently is one click.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { localIconFor } from "../../../lib/localIcon";
import { cn } from "../../../lib/utils";

const PALETTE = [
  "₿", "◎", "📈", "📉", "⚽", "🏀", "🗳️", "🌧️", "🌡️", "🚀",
  "🤖", "🏦", "🎬", "🎵", "🏆", "⭐", "🔥", "🎯", "🌍", "🔮",
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
  const inferred = useMemo(
    () => localIconFor(question)?.emoji ?? null,
    [question],
  );
  // Inferred first, then the palette minus any duplicate of it.
  const choices = useMemo(() => {
    const rest = PALETTE.filter((p) => p !== inferred);
    return inferred ? [inferred, ...rest] : rest;
  }, [inferred]);

  return (
    <div className="space-y-1">
      <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
        {t("launchpad.iconLabel", { defaultValue: "Icon (optional)" })}
        {!value && inferred && (
          <span className="ml-2 normal-case tracking-normal text-faint">
            {t("launchpad.iconAuto", {
              defaultValue: "— auto: {{emoji}} from the question",
              emoji: inferred,
            })}
          </span>
        )}
      </label>
      <div className="flex items-center gap-1 flex-wrap">
        {choices.slice(0, 10).map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onChange(value === emoji ? "" : emoji)}
            aria-pressed={value === emoji}
            className={cn(
              "h-9 w-9 flex items-center justify-center text-lg border transition-all",
              value === emoji
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
            // One emoji grapheme, mirroring the parser's 16-byte cap.
            const text = event.target.value.trim();
            const first = [...new Intl.Segmenter().segment(text)][0]?.segment ?? "";
            onChange(first);
          }}
          placeholder="😀"
          className="h-9 w-12 text-center text-lg bg-inset border border-rule focus:outline-none focus:border-accent"
          data-testid="icon-custom-input"
          aria-label={t("launchpad.iconCustom", { defaultValue: "Custom emoji" })}
        />
      </div>
    </div>
  );
}
