/**
 * The adjudicator leaderboard — every scored authority on this chain, ranked.
 *
 * This is the reputation system's public face: the Forge's directory shows a
 * top slice inline, but trust shopping deserves a full page — the whole
 * field, every trait, every count, and the methodology said out loud. The
 * scores are a pure fold over public resolution states; nothing here is
 * granted by the platform, so nothing here needs to be taken on faith.
 */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Scale, ArrowRight } from "lucide-react";
import { traitsOf, RULING_POINTS, BOND_POINTS } from "@sooth/sdk-solana";

import { useAdjudicatorScores } from "../features/arena/useAdjudicatorScores";
import { AdjudicatorTierChip } from "../components/features/AdjudicatorRecordCard";
import { useAccount } from "@/lib/chain-shim";

function fmtResponse(sec: number | null): string {
  if (sec === null) return "—";
  if (sec === 0) return "instant";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export default function Adjudicators() {
  const { t } = useTranslation();
  const { address } = useAccount();
  const self = address ? String(address).replace(/^0x/, "") : null;
  const { byAuthority, hasLoaded } = useAdjudicatorScores();

  const ranked = [...byAuthority.entries()].sort(
    (a, b) =>
      b[1].score - a[1].score ||
      b[1].record.resolvedRulings - a[1].record.resolvedRulings,
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <Scale className="h-5 w-5 text-accent" />
          {t("adjudicators.title", { defaultValue: "Adjudicators" })}
        </h1>
        <p className="text-sm text-muted leading-relaxed max-w-prose">
          {t("adjudicators.subtitle", {
            defaultValue:
              "Every authority that has ruled, vetoed, proposed or challenged on this chain, scored from public history. Pick one when creating a market — or build your own record by ruling well.",
          })}
        </p>
        <Link
          to="/forge"
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-accent hover:underline"
        >
          {t("adjudicators.forgeCta", {
            defaultValue: "Create a market with one of them",
          })}
          <ArrowRight className="w-3 h-3" />
        </Link>
      </header>

      {!hasLoaded ? (
        <p className="font-mono text-xs text-muted">
          {t("common.loading", { defaultValue: "Loading…" })}
        </p>
      ) : ranked.length === 0 ? (
        <p className="font-mono text-xs text-muted">
          {t("adjudicators.empty", {
            defaultValue: "No adjudication history on this chain yet.",
          })}
        </p>
      ) : (
        <ol className="space-y-2" data-testid="adjudicator-leaderboard">
          {ranked.map(([authority, score], index) => (
            <li
              key={authority}
              className="border border-rule bg-inset px-4 py-3"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs text-faint w-6 tabular-nums">
                  #{index + 1}
                </span>
                <AdjudicatorTierChip score={score} />
                <span className="font-mono text-[11px] text-muted">
                  {authority.slice(0, 6)}…{authority.slice(-6)}
                </span>
                {authority === self && (
                  <span className="font-mono text-[9px] uppercase tracking-[0.1em] px-1 py-0.5 border border-accent/60 text-accent">
                    {t("adjudicators.you", { defaultValue: "YOU" })}
                  </span>
                )}
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
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-muted pl-8">
                <span>{score.record.resolvedRulings} resolved</span>
                <span className="text-emerald-400">
                  {score.record.cleanRulings} clean
                </span>
                {score.record.overriddenRulings > 0 && (
                  <span className="text-red-400">
                    {score.record.overriddenRulings} vetoed
                  </span>
                )}
                {score.record.forcedInvalids > 0 && (
                  <span className="text-amber-400">
                    {score.record.forcedInvalids} forced invalid
                  </span>
                )}
                <span>rules in {fmtResponse(score.record.medianResponseSec)}</span>
                {score.record.vetoesIssued > 0 && (
                  <span>{score.record.vetoesIssued} vetoes issued</span>
                )}
                {score.record.proposalsUpheld + score.record.proposalsSlashed > 0 && (
                  <span>
                    bonds: {score.record.proposalsUpheld} upheld
                    {score.record.proposalsSlashed > 0 &&
                      ` · ${score.record.proposalsSlashed} slashed`}
                  </span>
                )}
                {score.record.challengesWon + score.record.challengesLost > 0 && (
                  <span>
                    challenges: {score.record.challengesWon}W /{" "}
                    {score.record.challengesLost}L
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <footer className="border-t border-rule pt-4 space-y-1.5">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
          {t("adjudicators.methodology", { defaultValue: "How scoring works" })}
        </h2>
        <p className="font-mono text-[11px] text-muted leading-relaxed">
          Rulings: clean {`+${RULING_POINTS.clean}`} (prompt{" "}
          {`+${RULING_POINTS.promptBonus}`}) · vetoed {RULING_POINTS.overridden} ·
          forced invalid {RULING_POINTS.forcedInvalid} · unresponsive{" "}
          {RULING_POINTS.unresponsive}. Bonds: upheld {`+${BOND_POINTS.proposalUpheld}`} ·
          slashed {BOND_POINTS.proposalSlashed} · challenge won{" "}
          {`+${BOND_POINTS.challengeWon}`} · lost {BOND_POINTS.challengeLost}. Score
          starts at 50; tiers need at least 3 resolved rulings. Every number is
          recomputable from public chain state.
        </p>
      </footer>
    </div>
  );
}
