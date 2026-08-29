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
import { PublicKey } from "@solana/web3.js";
import { traitsOf } from "@sooth/sdk-solana";
import { AdjudicatorTierChip } from "../AdjudicatorRecordCard";
import { CopyableAddress } from "../../../pages/Adjudicators";
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
      {mode === "manual" && (
        <AdjudicatorDirectory
          selected={selectedAdjudicator}
          onSelect={onAdjudicatorChange}
        />
      )}

      {/* Optimistic mode needs no adjudicator on the happy path — anyone's
          bond resolves the market. The arbiter exists ONLY for challenges,
          so the picker hides behind a one-line default instead of asking a
          question most creators never need answered. */}
      {mode === "optimistic" && (
        <OptimisticArbiterPicker
          selected={selectedAdjudicator}
          onSelect={onAdjudicatorChange}
        />
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
  const selfScore = self ? byAuthority.get(self) ?? null : null;

  const ranked = [...byAuthority.entries()]
    .filter(([authority]) => authority !== self)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 6);

  // Paste-an-address path: the directory can only list authorities this
  // build has SEEN, and delegation must not be capped by our discovery —
  // any valid pubkey is selectable, scored or not.
  const [customInput, setCustomInput] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const rankedKeys = new Set(ranked.map(([authority]) => authority));
  const customSelected =
    selected !== null && selected !== self && !rankedKeys.has(selected)
      ? selected
      : null;
  const applyCustom = (raw: string) => {
    const text = raw.trim().replace(/^sol:/, "").replace(/^0x/, "");
    setCustomInput(raw);
    if (!text) {
      setCustomError(null);
      return;
    }
    try {
      const pk = new PublicKey(text).toBase58();
      setCustomError(null);
      onSelect?.(pk);
    } catch {
      setCustomError(
        t("adjudicator.badAddress", {
          defaultValue: "Not a valid Solana address",
        }),
      );
    }
  };

  return (
    <div className="space-y-1.5" data-testid="adjudicator-directory">
      <DirectoryRow
        authority={null}
        label={t("adjudicator.self", { defaultValue: "Rule it yourself" })}
        score={selfScore}
        isSelected={selected === null}
        onClick={() => onSelect?.(null)}
        testId="adjudicator-pick-self"
      />
      {ranked.map(([authority, score]) => (
        <DirectoryRow
          key={authority}
          authority={authority}
          label={
            traitsOf(score.record)
              .slice(0, 2)
              .map((trait) => trait.label)
              .join(" · ") ||
            t("adjudicator.scored", { defaultValue: "Scored adjudicator" })
          }
          score={score}
          isSelected={selected === authority}
          onClick={() => onSelect?.(authority)}
          testId={`adjudicator-pick-${authority.slice(0, 6)}`}
        />
      ))}
      {customSelected && (
        <DirectoryRow
          authority={customSelected}
          label={t("adjudicator.custom", { defaultValue: "Pasted address" })}
          score={byAuthority.get(customSelected) ?? null}
          isSelected
          onClick={() => {}}
          testId="adjudicator-pick-custom"
        />
      )}
      <div className="space-y-1">
        <input
          type="text"
          value={customInput}
          onChange={(event) => applyCustom(event.target.value)}
          placeholder={t("adjudicator.pastePlaceholder", {
            defaultValue: "…or paste an adjudicator address",
          })}
          data-testid="adjudicator-custom-input"
          className={cn(
            "w-full bg-inset border px-3 py-2 font-mono text-xs text-ink placeholder:text-faint focus:outline-none",
            customError ? "border-red-500/60" : "border-rule focus:border-accent",
          )}
        />
        {customError && (
          <p className="font-mono text-[10px] text-red-400">{customError}</p>
        )}
      </div>
      <a
        href="/adjudicators"
        target="_blank"
        rel="noreferrer"
        className="inline-block font-mono text-[10px] uppercase tracking-[0.12em] text-accent hover:underline"
      >
        {t("adjudicator.fullBoard", { defaultValue: "full leaderboard →" })}
      </a>
    </div>
  );
}

/**
 * One compact, radio-style row per option. Choosing is this component's whole
 * job — the evidence lives on the leaderboard, one click away — so a row is a
 * radio dot, a name, an address, and the tier chip. Selection reads at a
 * glance: filled dot, accent border, tinted ground.
 */
function DirectoryRow({
  authority,
  label,
  score,
  isSelected,
  onClick,
  testId,
}: {
  authority: string | null;
  label: string;
  score: import("@sooth/sdk-solana").AdjudicatorScore | null;
  isSelected: boolean;
  onClick: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={isSelected}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-2.5 border text-left transition-all",
        isSelected
          ? "border-accent bg-accent-muted"
          : "border-rule bg-inset hover:bg-raised",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          isSelected ? "border-accent bg-accent" : "border-faint",
        )}
      >
        {isSelected && <Check className="h-3 w-3 text-canvas" />}
      </span>
      <span className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
        <span
          className={cn(
            "text-sm font-medium",
            isSelected ? "text-ink" : "text-muted",
          )}
        >
          {label}
        </span>
        {authority && <CopyableAddress address={authority} />}
      </span>
      {score ? (
        <AdjudicatorTierChip score={score} />
      ) : (
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
          {t("adjudicator.noHistory", { defaultValue: "no history" })}
        </span>
      )}
    </button>
  );
}

function OptimisticArbiterPicker({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect?: (authority: string | null) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted leading-relaxed">
        {t("launchpad.zk.optimisticDefault", {
          defaultValue:
            "No adjudicator needed — anyone resolves this market by posting a bond. Only a CHALLENGED assertion needs a tiebreaker, and that arbiter is",
        })}{" "}
        <span className="font-mono text-ink">
          {selected
            ? `${selected.slice(0, 4)}…${selected.slice(-4)}`
            : t("launchpad.zk.arbiterYou", { defaultValue: "you (the creator)" })}
        </span>
        {". "}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-accent hover:underline"
          data-testid="launchpad-arbiter-toggle"
        >
          {expanded
            ? t("launchpad.zk.arbiterHide", { defaultValue: "hide options" })
            : t("launchpad.zk.arbiterChange", { defaultValue: "change arbiter" })}
        </button>
      </p>
      {expanded && (
        <AdjudicatorDirectory selected={selected} onSelect={onSelect} />
      )}
    </div>
  );
}
