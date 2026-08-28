// How the market gets resolved — the one choice the Forge was missing.
//
// Manual is the old behaviour: the creator is the adjudicator and signs the
// outcome. Automatic registers the market to Primus' attestor, and anyone can
// then close it by submitting a signed reading of a public endpoint; the
// creator keeps the dispute veto either way.
//
// The screen stays short on purpose. Two buttons, then — only if you picked
// Automatic — a preset, a comparator and a number. The one thing that gets
// room is the live preview, because the rule is written once and forever and a
// path pointing at the wrong field is the failure that costs a market.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Loader2, PenLine, Radio, Scale } from "lucide-react";
import { cn } from "../../../lib/utils";
import { useAccount } from "@/lib/chain-shim";
import { traitsOf } from "@sooth/sdk-solana";
import {
  AdjudicatorRecordCard,
  AdjudicatorTierChip,
} from "../AdjudicatorRecordCard";
import { useAdjudicatorScores } from "../../../features/arena/useAdjudicatorScores";
import {
  COMPARATORS,
  MAX_SCALE,
  ZK_PRESETS,
  evaluateComparator,
  previewRule,
  zkDraftError,
  type PreviewResult,
  type ZkRuleDraft,
} from "./zk-rule";
import type { ZkPolicy } from "./useZkAdjudicatorPolicy";

export type ResolutionMode = "manual" | "zk" | "optimistic";

interface Props {
  mode: ResolutionMode;
  onModeChange: (mode: ResolutionMode) => void;
  /** Chosen adjudicator (base58), or null = the creator rules. */
  selectedAdjudicator?: string | null;
  onAdjudicatorChange?: (authority: string | null) => void;
  draft: ZkRuleDraft;
  onDraftChange: (draft: ZkRuleDraft) => void;
  policy: ZkPolicy;
  onPreviewChange?: (preview: PreviewResult | null) => void;
}

const PREVIEW_DEBOUNCE_MS = 450;

export const ResolutionPicker = ({
  mode,
  onModeChange,
  selectedAdjudicator = null,
  onAdjudicatorChange,
  draft,
  onDraftChange,
  policy,
  onPreviewChange,
}: Props) => {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const zkAvailable = policy.reason === "ok";
  const isCustom = draft.presetId === "custom";

  // Re-read whenever the endpoint or the path moves. Debounced so typing a
  // custom URL doesn't fire a request per keystroke, and aborted on change so
  // a slow earlier read cannot land after a newer one.
  useEffect(() => {
    if (mode !== "zk") return;
    const url = draft.url.trim();
    const path = draft.parsePath.trim();
    if (!url || !path || !/^https?:\/\//i.test(url) || !path.startsWith("$")) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }
    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPreviewing(true);
      previewRule(url, path, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setPreview(null);
          setPreviewError((e as Error).message || "unreachable");
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewing(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [mode, draft.url, draft.parsePath]);

  useEffect(() => {
    onPreviewChange?.(preview);
    // `onPreviewChange` is a plain callback from the parent; depending on it
    // would re-fire on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  const thresholdNumber = Number(draft.threshold);
  const readsTrue =
    preview && Number.isFinite(thresholdNumber)
      ? evaluateComparator(preview.numeric, draft.comparator, thresholdNumber)
      : null;

  // The program rejects a value with more decimals than the registered scale
  // instead of rounding it, so a scale that merely fits TODAY's reading is a
  // market that stops resolving the first time the feed prints another digit.
  const precisionWarning =
    preview !== null && preview.decimals > draft.valueScale;

  const draftError = useMemo(() => zkDraftError(draft), [draft]);

  const gateMessage = (() => {
    switch (policy.reason) {
      case "loading":
        return t("launchpad.zk.gate.loading");
      case "noConfig":
        return t("launchpad.zk.gate.noConfig");
      case "readFailed":
        return t("launchpad.zk.gate.readFailed");
      case "noWallet":
        return t("launchpad.zk.gate.noWallet");
      case "notAuthority":
        return t("launchpad.zk.gate.notAuthority", {
          authority: policy.authority
            ? `${policy.authority.slice(0, 4)}…${policy.authority.slice(-4)}`
            : "—",
        });
      default:
        return null;
    }
  })();

  return (
    <div className="space-y-3" data-testid="launchpad-resolution">
      <label className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
        {t("launchpad.zk.sectionLabel")}
      </label>

      <div className="grid grid-cols-3 gap-2">
        <button
          data-testid="launchpad-resolution-manual"
          onClick={() => onModeChange("manual")}
          className={cn(
            "p-3 border border-transparent transition-all flex items-start gap-2 text-left",
            mode === "manual"
              ? "bg-accent-muted text-accent"
              : "bg-inset text-muted hover:bg-raised",
          )}
        >
          <PenLine className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="block text-sm font-bold">
              {t("launchpad.zk.manualTitle")}
            </span>
            <span className="block text-xs opacity-80">
              {t("launchpad.zk.manualDesc")}
            </span>
          </span>
          {mode === "manual" && <Check className="w-4 h-4 ml-auto shrink-0" />}
        </button>

        <button
          data-testid="launchpad-resolution-zk"
          disabled={!zkAvailable}
          onClick={() => zkAvailable && onModeChange("zk")}
          className={cn(
            "p-3 border border-transparent transition-all flex items-start gap-2 text-left",
            mode === "zk"
              ? "bg-accent-muted text-accent"
              : "bg-inset text-muted hover:bg-raised",
            !zkAvailable && "opacity-40 cursor-not-allowed hover:bg-inset",
          )}
        >
          <Radio className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="block text-sm font-bold">
              {t("launchpad.zk.autoTitle")}
            </span>
            <span className="block text-xs opacity-80">
              {t("launchpad.zk.autoDesc")}
            </span>
          </span>
          {mode === "zk" && <Check className="w-4 h-4 ml-auto shrink-0" />}
        </button>

        <button
          data-testid="launchpad-resolution-optimistic"
          onClick={() => onModeChange("optimistic")}
          className={cn(
            "p-3 border border-transparent transition-all flex items-start gap-2 text-left",
            mode === "optimistic"
              ? "bg-accent-muted text-accent"
              : "bg-inset text-muted hover:bg-raised",
          )}
        >
          <Scale className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="block text-sm font-bold">
              {t("launchpad.zk.optimisticTitle", { defaultValue: "Optimistic" })}
            </span>
            <span className="block text-xs opacity-80">
              {t("launchpad.zk.optimisticDesc", {
                defaultValue:
                  "Anyone asserts the outcome with a bond; a counter-bond escalates to your named arbiter. Being wrong costs money.",
              })}
            </span>
          </span>
          {mode === "optimistic" && <Check className="w-4 h-4 ml-auto shrink-0" />}
        </button>
      </div>

      {/* Adjudicated mode: the creator rules by default, but the reputation
          system makes every scored adjudicator on this chain pickable — the
          whole point of scoring is that trust can be delegated to a record
          instead of a stranger. */}
      {(mode === "manual" || mode === "optimistic") && (
        <>
          {mode === "optimistic" && (
            <p className="text-xs text-faint leading-relaxed">
              {t("launchpad.zk.optimisticArbiterNote", {
                defaultValue:
                  "The adjudicator you pick below never rules unless someone challenges a bonded assertion — they are the court of appeal, not the oracle.",
              })}
            </p>
          )}
          <AdjudicatorDirectory
            selected={selectedAdjudicator}
            onSelect={onAdjudicatorChange}
          />
        </>
      )}

      {gateMessage && (
        <p
          data-testid="launchpad-zk-gate"
          className="text-xs text-faint leading-relaxed flex items-start gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{gateMessage}</span>
        </p>
      )}

      {mode === "zk" && (
        <div
          className="space-y-3 border border-rule bg-inset p-3"
          data-testid="launchpad-zk-panel"
        >
          <div className="grid grid-cols-3 gap-2">
            {ZK_PRESETS.map((preset) => (
              <button
                key={preset.id}
                data-testid={`launchpad-zk-preset-${preset.id}`}
                onClick={() =>
                  onDraftChange({
                    ...draft,
                    presetId: preset.id,
                    // "custom" keeps whatever is already typed rather than
                    // wiping the fields the user just filled in.
                    url: preset.id === "custom" ? draft.url : preset.url,
                    parsePath:
                      preset.id === "custom" ? draft.parsePath : preset.parsePath,
                    valueScale: preset.valueScale,
                  })
                }
                className={cn(
                  "py-2 text-xs font-bold border border-transparent transition-all",
                  draft.presetId === preset.id
                    ? "bg-accent-muted text-accent"
                    : "bg-raised text-muted hover:bg-inset",
                )}
              >
                {t(`launchpad.zk.presets.${preset.labelKey}`)}
              </button>
            ))}
          </div>

          {isCustom && (
            <div className="space-y-2">
              <input
                data-testid="launchpad-zk-url"
                type="text"
                value={draft.url}
                onChange={(e) =>
                  onDraftChange({ ...draft, url: e.target.value })
                }
                placeholder="https://api.example.com/v1/thing"
                className="input-field px-3 py-2 text-sm bg-canvas font-mono"
              />
              <input
                data-testid="launchpad-zk-path"
                type="text"
                value={draft.parsePath}
                onChange={(e) =>
                  onDraftChange({ ...draft, parsePath: e.target.value })
                }
                placeholder="$.data.amount"
                className="input-field px-3 py-2 text-sm bg-canvas font-mono"
              />
            </div>
          )}

          {!isCustom && (
            <p className="font-mono text-xs text-faint break-all">
              {draft.url}
              <span className="text-muted"> · {draft.parsePath}</span>
            </p>
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted whitespace-nowrap">
              {t("launchpad.zk.resolvesYesWhen")}
            </span>
            <div className="flex gap-1">
              {COMPARATORS.map((c) => (
                <button
                  key={c.id}
                  data-testid={`launchpad-zk-cmp-${c.id}`}
                  onClick={() => onDraftChange({ ...draft, comparator: c.id })}
                  className={cn(
                    "w-8 py-1.5 font-mono text-sm border border-transparent transition-all",
                    draft.comparator === c.id
                      ? "bg-accent-muted text-accent"
                      : "bg-raised text-muted hover:bg-inset",
                  )}
                >
                  {c.symbol}
                </button>
              ))}
            </div>
            <input
              data-testid="launchpad-zk-threshold"
              type="text"
              inputMode="decimal"
              value={draft.threshold}
              onChange={(e) =>
                onDraftChange({ ...draft, threshold: e.target.value })
              }
              placeholder={t("launchpad.zk.thresholdPlaceholder")}
              className="input-field px-3 py-1.5 text-sm bg-canvas font-mono tabular-nums flex-1 min-w-0"
            />
          </div>

          <div
            className="border border-rule bg-canvas px-3 py-2"
            data-testid="launchpad-zk-preview"
          >
            {previewing && (
              <span className="text-xs text-muted flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t("launchpad.zk.previewLoading")}
              </span>
            )}
            {!previewing && previewError && (
              <span className="text-xs text-warn flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                {t("launchpad.zk.previewError", { error: previewError })}
              </span>
            )}
            {!previewing && !previewError && preview && (
              <div className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted">
                    {t("launchpad.zk.previewLabel")}
                  </span>
                  <span
                    data-testid="launchpad-zk-preview-value"
                    className="font-mono text-sm font-bold text-ink tabular-nums"
                  >
                    {preview.raw}
                  </span>
                </div>
                {readsTrue !== null && (
                  <p className="text-xs text-faint">
                    {t("launchpad.zk.previewVerdict", {
                      verdict: readsTrue
                        ? t("launchpad.zk.yes")
                        : t("launchpad.zk.no"),
                    })}
                  </p>
                )}
              </div>
            )}
            {!previewing && !previewError && !preview && (
              <span className="text-xs text-faint">
                {t("launchpad.zk.previewIdle")}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="font-mono text-xs uppercase tracking-[0.12em] text-faint whitespace-nowrap">
              {t("launchpad.zk.scaleLabel")}
            </label>
            <input
              data-testid="launchpad-zk-scale"
              type="number"
              min={0}
              max={MAX_SCALE}
              value={draft.valueScale}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  valueScale: Math.max(
                    0,
                    Math.min(MAX_SCALE, Number(e.target.value) || 0),
                  ),
                })
              }
              className="input-field px-2 py-1 text-sm bg-canvas font-mono tabular-nums w-16"
            />
            <span className="text-xs text-faint leading-snug">
              {t("launchpad.zk.scaleHint")}
            </span>
          </div>

          {precisionWarning && (
            <p
              data-testid="launchpad-zk-precision-warning"
              className="text-xs text-warn flex items-start gap-1.5"
            >
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              {t("launchpad.zk.precisionWarning", {
                decimals: preview?.decimals ?? 0,
                scale: draft.valueScale,
              })}
            </p>
          )}

          {draftError && (
            <p className="text-xs text-faint">
              {t(`launchpad.zk.errors.${draftError}`)}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

function AdjudicatorDirectory({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect?: (authority: string | null) => void;
}) {
  const { t } = useTranslation();
  const { address } = useAccount();
  const { byAuthority } = useAdjudicatorScores();
  const self = address ? String(address).replace(/^0x/, "") : null;

  // Ranked directory, best record first; the creator is offered separately.
  const ranked = [...byAuthority.entries()]
    .filter(([authority]) => authority !== self)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 6);

  return (
    <div className="space-y-2" data-testid="adjudicator-directory">
      <button
        type="button"
        onClick={() => onSelect?.(null)}
        className={cn(
          "w-full text-left border transition-all",
          selected === null ? "border-accent" : "border-transparent",
        )}
        data-testid="adjudicator-pick-self"
      >
        <AdjudicatorRecordCard
          authority={self}
          headline={t("adjudicator.ruleItYourself", {
            defaultValue:
              "Rule it yourself — this is the record traders will judge you by:",
          })}
        />
      </button>
      {ranked.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            {t("adjudicator.orDelegate", {
              defaultValue: "…or delegate to a scored adjudicator",
            })}
          </p>
          <a
            href="/adjudicators"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent hover:underline"
          >
            {t("adjudicator.fullBoard", { defaultValue: "full leaderboard →" })}
          </a>
        </div>
      )}
      {ranked.map(([authority, score]) => (
        <button
          key={authority}
          type="button"
          onClick={() => onSelect?.(authority)}
          className={cn(
            "w-full text-left border bg-inset px-3 py-2 transition-all hover:bg-raised",
            selected === authority ? "border-accent" : "border-rule",
          )}
          data-testid={`adjudicator-pick-${authority.slice(0, 6)}`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <AdjudicatorTierChip score={score} />
            <span className="font-mono text-[10px] text-faint">
              {authority.slice(0, 4)}…{authority.slice(-4)}
            </span>
            {traitsOf(score.record).map((trait) => (
              <span
                key={trait.id}
                title={trait.detail}
                className="font-mono text-[9px] uppercase tracking-[0.1em] px-1 py-0.5 border border-rule text-muted"
              >
                {trait.label}
              </span>
            ))}
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-muted">
            {score.record.resolvedRulings} resolved ·{" "}
            {score.record.overriddenRulings} vetoed ·{" "}
            {score.record.vetoesIssued} vetoes issued
          </p>
        </button>
      ))}
    </div>
  );
}
