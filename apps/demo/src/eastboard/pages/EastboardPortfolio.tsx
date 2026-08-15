import { decideOptionOutcome, getUnderlying } from "../core";
import { useTranslation } from "react-i18next";
import { isEastboardFixtureMode } from "../lib/fixtureMode";
import {
  useSimulationStore,
  type SimulatedPosition,
} from "../store/useSimulationStore";

function money(value: number, locale: string): string {
  return value.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function EastboardPortfolio() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en-US";
  const balance = useSimulationStore((state) => state.balance);
  const positionsById = useSimulationStore((state) => state.positions);
  const settle = useSimulationStore((state) => state.settle);
  const redeem = useSimulationStore((state) => state.redeem);
  const positions = Object.values(positionsById);
  const fixtureMode = isEastboardFixtureMode();

  const runResolver = (position: SimulatedPosition) => {
    const underlying = getUnderlying(position.template.underlyingId);
    const observations = [
      {
        source: `${underlying.source}-fixture`,
        valueRaw: underlying.referencePriceRaw,
      },
      { source: "independent-fixture", valueRaw: underlying.referencePriceRaw },
    ];
    const decision = decideOptionOutcome({
      template: position.template,
      observations,
      observedAt: new Date().toISOString(),
    });
    settle(
      position.template.id,
      decision.outcome,
      decision.reason,
      decision.rawValue,
    );
  };

  if (!fixtureMode) {
    return <FixtureRouteDisabled title={t("eastboard.portfolio.title")} />;
  }

  return (
    <section className="mx-auto max-w-[1080px]">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-accent">
            {t("eastboard.portfolio.eyebrow")}
          </p>
          <h1 className="mt-4 font-heading text-4xl uppercase tracking-[-0.05em] text-ink md:text-5xl">
            {t("eastboard.portfolio.title")}
          </h1>
        </div>
        <div className="border-l border-rule pl-5">
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
            {t("eastboard.portfolio.simulatedBalance")}
          </p>
          <p className="mt-2 font-mono text-2xl font-semibold text-ink">
            {money(balance, locale)} MUSDC
          </p>
        </div>
      </div>
      <div className="mt-7 border border-warn/40 bg-warn-soft p-4 font-mono text-[10px] leading-relaxed text-warn">
        {t("eastboard.portfolio.notice")}
      </div>

      {positions.length === 0 ? (
        <div className="mt-9 border-y border-rule py-12">
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-faint">
            {t("eastboard.portfolio.emptyEyebrow")}
          </p>
          <h2 className="mt-4 font-heading text-xl uppercase tracking-[-0.03em] text-ink">
            {t("eastboard.portfolio.emptyTitle")}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {t("eastboard.portfolio.emptyBody")}
          </p>
        </div>
      ) : (
        <div className="mt-8 grid gap-4">
          {positions.map((position) => (
            <article
              key={position.template.id}
              className="grid gap-5 border border-rule bg-raised/40 p-5 md:grid-cols-[minmax(0,1fr)_230px] md:items-center"
            >
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent">
                  {t(`eastboard.portfolio.status.${position.status}`)}
                </p>
                <h2 className="mt-2 font-heading text-xl uppercase tracking-[-0.03em] text-ink">
                  {position.template.underlyingSymbol} ≥{" "}
                  {position.template.strikeLabel}
                </h2>
                <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
                  {t("eastboard.portfolio.summary", {
                    expiry: position.template.expiry,
                    yes: money(position.yesShares, locale),
                    no: money(position.noShares, locale),
                    cost: money(position.totalCost, locale),
                  })}
                </p>
                {position.reason && (
                  <p className="mt-3 text-[12px] text-muted">
                    {t("eastboard.portfolio.evidence", {
                      value: position.rawValue,
                      reason: position.reason,
                    })}
                  </p>
                )}
                {position.payout !== undefined && (
                  <p className="mt-3 font-mono text-[10px] text-pos">
                    {t("eastboard.portfolio.redeemed", {
                      amount: money(position.payout, locale),
                    })}
                  </p>
                )}
              </div>
              <div>
                {position.status === "live" && (
                  <button
                    type="button"
                    onClick={() => runResolver(position)}
                    className="w-full border border-warn/50 bg-warn-soft px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-warn active:translate-y-px"
                  >
                    {t("eastboard.portfolio.runResolver")}
                  </button>
                )}
                {position.status === "settled" && (
                  <button
                    type="button"
                    onClick={() => redeem(position.template.id)}
                    className="w-full bg-accent px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-canvas active:translate-y-px"
                  >
                    {t("eastboard.portfolio.redeem")}
                  </button>
                )}
                {position.status === "redeemed" && (
                  <p className="text-center font-mono text-[10px] uppercase tracking-[0.12em] text-pos">
                    {t("eastboard.portfolio.complete")}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function FixtureRouteDisabled({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <section className="mx-auto max-w-[880px]">
      <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-accent">
        {t("eastboard.portfolio.fixtureOnly")}
      </p>
      <h1 className="mt-4 font-heading text-4xl uppercase tracking-[-0.05em] text-ink md:text-5xl">
        {title}
      </h1>
      <div className="mt-8 border border-rule bg-raised p-5 text-sm leading-relaxed text-muted">
        {t("eastboard.portfolio.disabledBodyBefore")}{" "}
        <code className="font-mono text-accent">?fixtures</code>{" "}
        {t("eastboard.portfolio.disabledBodyAfter")}
      </div>
    </section>
  );
}
