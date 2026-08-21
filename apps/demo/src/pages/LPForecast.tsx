import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { formatUnits } from "@/lib/chain-shim";
import {
  Database,
  Info,
  LineChart,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useVisibleMarkets } from "../hooks";
import {
  calculateCreatorDeposit,
  runLpForecast,
  type LpForecastAssumptions,
  type LpForecastPoint,
  type LpScenarioResult,
} from "../lib/lp-forecast";

type ChartMode = "pnl" | "fees" | "exposure" | "cashflow";

interface ForecastFormState {
  initialLiquidity: string;
  initialProbability: string;
  expectedOutcomeProbability: string;
  durationDays: string;
  dailyVolume: string;
  volatility: string;
  preGradFeeRate: string;
  postGradFeeRate: string;
  bBaseShare: string;
  lpYieldShare: string;
  creatorLpShare: string;
  depositDay: string;
  depositAmount: string;
  withdrawalDay: string;
  withdrawalAmount: string;
}

const DEFAULT_FORM: ForecastFormState = {
  initialLiquidity: "1000",
  initialProbability: "50",
  expectedOutcomeProbability: "58",
  durationDays: "30",
  dailyVolume: "2500",
  volatility: "18",
  preGradFeeRate: "5",
  postGradFeeRate: "1",
  bBaseShare: "50",
  lpYieldShare: "30",
  creatorLpShare: "100",
  depositDay: "10",
  depositAmount: "0",
  withdrawalDay: "24",
  withdrawalAmount: "0",
};

export function LPForecast() {
  const { markets, isLoading: marketsLoading } = useVisibleMarkets();
  const [selectedAddress, setSelectedAddress] = useState<
    `0x${string}` | undefined
  >(undefined);
  const [form, setForm] = useState<ForecastFormState>(DEFAULT_FORM);
  const [selectedScenarioId, setSelectedScenarioId] =
    useState<LpScenarioResult["id"]>("expected");
  const [chartMode, setChartMode] = useState<ChartMode>("pnl");

  useEffect(() => {
    if (!selectedAddress && markets[0]) {
      setSelectedAddress(markets[0].address);
    }
  }, [markets, selectedAddress]);

  const selectedMarket = useMemo(
    () => markets.find((market) => market.address === selectedAddress),
    [markets, selectedAddress],
  );

  useEffect(() => {
    if (!selectedMarket) return;
    const liquidity = Number(formatUnits(selectedMarket.bBase, 18));
    const nowSec = Date.now() / 1000;
    const durationDays = selectedMarket.deadline
      ? Math.max(1, Math.ceil((selectedMarket.deadline - nowSec) / 86_400))
      : Number(DEFAULT_FORM.durationDays);

    setForm((current) => ({
      ...current,
      initialLiquidity: formatInputNumber(liquidity || 1_000),
      durationDays: String(durationDays),
      expectedOutcomeProbability:
        selectedMarket.winningOutcome === 1
          ? "95"
          : selectedMarket.winningOutcome === 0
            ? "5"
            : current.expectedOutcomeProbability,
    }));
  }, [selectedMarket?.address]);

  const assumptions = useMemo(
    () => buildAssumptions(form, selectedMarket?.question),
    [form, selectedMarket?.question],
  );
  const forecast = useMemo(() => runLpForecast(assumptions), [assumptions]);
  const selectedScenario =
    forecast.scenarios.find((scenario) => scenario.id === selectedScenarioId) ??
    forecast.scenarios[1];

  const series = useMemo(
    () => buildChartSeries(chartMode, forecast.scenarios),
    [chartMode, forecast.scenarios],
  );

  const creatorDeposit = calculateCreatorDeposit(
    assumptions.initialLiquidity,
    assumptions.initialProbability,
  );

  return (
    <div className="space-y-5">
      <header className="border-b border-rule pb-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="font-mono text-ui uppercase text-accent">
              Creator LP cashflow lab
            </p>
            <h1 className="mt-2 text-h1 text-ink">
              Forecast whether liquidity pays for itself
            </h1>
            <p className="mt-3 text-body text-muted">
              Model creator deposits, Soo fees, LP dilution, inventory
              exposure, drawdowns, and ending P&L.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-px bg-rule text-small lg:w-[420px]">
            <StatTile label="Creator deposit" value={formatUsd(creatorDeposit)} />
            <StatTile
              label="Selected market"
              value={selectedMarket ? shortLabel(selectedMarket.question) : "None"}
            />
            <StatTile
              label="Model horizon"
              value={`${assumptions.durationDays}d`}
            />
          </div>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[370px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <Panel
            eyebrow="Market"
            title="Select a Soo market"
            icon={Database}
          >
            <label className="block space-y-2">
              <span className="font-mono text-[10px] uppercase tracking-mono-ui text-faint">
                Market
              </span>
              <select
                value={selectedAddress ?? ""}
                onChange={(event) =>
                  setSelectedAddress(event.target.value as `0x${string}`)
                }
                className="input-field"
              >
                {marketsLoading && <option value="">Loading markets...</option>}
                {!marketsLoading && markets.length === 0 && (
                  <option value="">No markets on this chain</option>
                )}
                {markets.map((market) => (
                  <option key={market.address} value={market.address}>
                    {market.question || market.address}
                  </option>
                ))}
              </select>
            </label>
            {selectedMarket && (
              <div className="mt-4 border-t border-rule pt-4 text-small text-muted">
                <div className="flex items-center justify-between gap-3">
                  <span>Stage</span>
                  <span className="font-mono uppercase text-ink">
                    {selectedMarket.stage}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span>Creator</span>
                  <span className="font-mono text-ink">
                    {shortAddress(selectedMarket.creator)}
                  </span>
                </div>
              </div>
            )}
          </Panel>

          <Panel
            eyebrow="Modeled"
            title="Assumptions"
            icon={SlidersHorizontal}
          >
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Initial liquidity b"
                value={form.initialLiquidity}
                prefix="$"
                onChange={(value) => patchForm(setForm, "initialLiquidity", value)}
              />
              <NumberField
                label="Starting YES"
                value={form.initialProbability}
                suffix="%"
                min={1}
                max={99}
                onChange={(value) =>
                  patchForm(setForm, "initialProbability", value)
                }
              />
              <NumberField
                label="Outcome probability"
                value={form.expectedOutcomeProbability}
                suffix="%"
                min={1}
                max={99}
                onChange={(value) =>
                  patchForm(setForm, "expectedOutcomeProbability", value)
                }
              />
              <NumberField
                label="Duration"
                value={form.durationDays}
                suffix="d"
                min={1}
                onChange={(value) => patchForm(setForm, "durationDays", value)}
              />
              <NumberField
                label="Daily volume"
                value={form.dailyVolume}
                prefix="$"
                min={0}
                onChange={(value) => patchForm(setForm, "dailyVolume", value)}
              />
              <NumberField
                label="Volatility"
                value={form.volatility}
                suffix="%"
                min={0}
                max={75}
                onChange={(value) => patchForm(setForm, "volatility", value)}
              />
              <NumberField
                label="Pre-grad fee"
                value={form.preGradFeeRate}
                suffix="%"
                min={0}
                onChange={(value) => patchForm(setForm, "preGradFeeRate", value)}
              />
              <NumberField
                label="Post-grad fee"
                value={form.postGradFeeRate}
                suffix="%"
                min={0}
                onChange={(value) => patchForm(setForm, "postGradFeeRate", value)}
              />
              <NumberField
                label="b growth share"
                value={form.bBaseShare}
                suffix="%"
                min={0}
                max={100}
                onChange={(value) => patchForm(setForm, "bBaseShare", value)}
              />
              <NumberField
                label="LP yield share"
                value={form.lpYieldShare}
                suffix="%"
                min={0}
                max={100}
                onChange={(value) => patchForm(setForm, "lpYieldShare", value)}
              />
            </div>
            <div className="mt-4 border-t border-rule pt-4">
              <p className="font-mono text-ui uppercase text-muted">
                Deposits and withdrawals
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <NumberField
                  label="Deposit day"
                  value={form.depositDay}
                  min={0}
                  onChange={(value) => patchForm(setForm, "depositDay", value)}
                />
                <NumberField
                  label="Deposit amount"
                  value={form.depositAmount}
                  prefix="$"
                  min={0}
                  onChange={(value) => patchForm(setForm, "depositAmount", value)}
                />
                <NumberField
                  label="Withdraw day"
                  value={form.withdrawalDay}
                  min={0}
                  onChange={(value) => patchForm(setForm, "withdrawalDay", value)}
                />
                <NumberField
                  label="Withdraw amount"
                  value={form.withdrawalAmount}
                  prefix="$"
                  min={0}
                  onChange={(value) =>
                    patchForm(setForm, "withdrawalAmount", value)
                  }
                />
              </div>
            </div>
          </Panel>

          <Panel eyebrow="Explain" title="Transparent math" icon={Info}>
            <div className="space-y-3 text-small text-muted">
              <p>
                The model estimates creator capital using the Soo launch formula, then
                allocates pre-graduation fees to liquidity growth and
                post-graduation fees across b growth and LP yield.
              </p>
              <ul className="space-y-2 font-mono text-[11px] text-ink">
                {forecast.formulas.map((formula) => (
                  <li key={formula} className="border-l border-accent pl-3">
                    {formula}
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        </aside>

        <main className="min-w-0 space-y-4">
          <Panel eyebrow="Modeled forecast" title="Scenario P&L" icon={LineChart}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                {forecast.scenarios.map((scenario) => (
                  <button
                    key={scenario.id}
                    type="button"
                    onClick={() => setSelectedScenarioId(scenario.id)}
                    className={cn(
                      "h-9 border px-3 font-mono text-ui uppercase transition-colors active:translate-y-px",
                      selectedScenario.id === scenario.id
                        ? "border-accent bg-accent text-canvas"
                        : "border-rule text-muted hover:text-ink",
                    )}
                  >
                    {scenario.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {(["pnl", "fees", "exposure", "cashflow"] as ChartMode[]).map(
                  (mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setChartMode(mode)}
                      className={cn(
                        "h-8 px-2 font-mono text-[10px] uppercase tracking-mono-ui transition-colors",
                        chartMode === mode
                          ? "bg-raised text-accent"
                          : "text-muted hover:text-ink",
                      )}
                    >
                      {mode}
                    </button>
                  ),
                )}
              </div>
            </div>

            <MetricGrid scenario={selectedScenario} />

            <div className="mt-5">
              <ForecastChart mode={chartMode} series={series} />
            </div>
          </Panel>

          <Panel eyebrow="Audit trail" title="Scenario cashflow checkpoints">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-rule font-mono text-ui uppercase text-faint">
                    <th className="py-2 pr-4">Day</th>
                    <th className="py-2 pr-4">YES price</th>
                    <th className="py-2 pr-4">Cumulative fees</th>
                    <th className="py-2 pr-4">LP fee income</th>
                    <th className="py-2 pr-4">Exposure</th>
                    <th className="py-2 pr-4">Equity</th>
                    <th className="py-2 pr-4">Drawdown</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-small text-muted">
                  {samplePoints(selectedScenario.points).map((point) => (
                    <tr key={`${point.day}-${point.cumulativeVolume}`}>
                      <td className="border-b border-subtle py-2 pr-4">
                        {point.day.toFixed(point.day % 1 === 0 ? 0 : 1)}
                      </td>
                      <td className="border-b border-subtle py-2 pr-4">
                        {(point.price * 100).toFixed(1)}%
                      </td>
                      <td className="border-b border-subtle py-2 pr-4">
                        {formatUsd(point.cumulativeFees)}
                      </td>
                      <td className="border-b border-subtle py-2 pr-4">
                        {formatUsd(point.feeIncome)}
                      </td>
                      <td className="border-b border-subtle py-2 pr-4">
                        {formatUsd(point.inventoryExposure)}
                      </td>
                      <td className="border-b border-subtle py-2 pr-4">
                        {formatUsd(point.equity)}
                      </td>
                      <td className="border-b border-subtle py-2 pr-4">
                        {formatUsd(point.drawdown)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </main>
      </section>
    </div>
  );
}

function Panel({
  eyebrow,
  title,
  icon: Icon,
  children,
}: {
  eyebrow: string;
  title: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="border border-rule bg-raised p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-ui uppercase text-accent">{eyebrow}</p>
          <h2 className="mt-1 text-h3 text-ink">{title}</h2>
        </div>
        {Icon && <Icon className="h-5 w-5 text-faint" />}
      </div>
      {children}
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  prefix,
  suffix,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block space-y-2">
      <span className="font-mono text-[10px] uppercase tracking-mono-ui text-faint">
        {label}
      </span>
      <div className="flex border border-subtle bg-inset focus-within:border-accent">
        {prefix && (
          <span className="flex items-center px-2 font-mono text-small text-faint">
            {prefix}
          </span>
        )}
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent px-2 py-2 font-mono text-small text-ink outline-none"
        />
        {suffix && (
          <span className="flex items-center px-2 font-mono text-small text-faint">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

function MetricGrid({ scenario }: { scenario: LpScenarioResult }) {
  const metrics = scenario.metrics;
  return (
    <div className="mt-5 grid grid-cols-2 gap-px bg-rule lg:grid-cols-4">
      <StatTile
        label="Final P&L"
        value={formatSignedUsd(metrics.finalPnl)}
        tone={metrics.finalPnl >= 0 ? "pos" : "neg"}
      />
      <StatTile label="Fee income" value={formatUsd(metrics.feeIncome)} />
      <StatTile
        label="Max exposure"
        value={formatUsd(metrics.maxInventoryExposure)}
      />
      <StatTile label="Drawdown" value={formatUsd(metrics.maxDrawdown)} />
      <StatTile label="Total fees" value={formatUsd(metrics.totalFees)} />
      <StatTile label="Capital at risk" value={formatUsd(metrics.capitalAtRisk)} />
      <StatTile
        label="ROI"
        value={formatPercent(metrics.roi)}
        tone={metrics.roi >= 0 ? "pos" : "neg"}
      />
      <StatTile
        label="Graduation"
        value={metrics.graduationDay === null ? "Not reached" : `Day ${metrics.graduationDay}`}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="bg-raised p-3">
      <p className="font-mono text-[10px] uppercase tracking-mono-ui text-faint">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate font-mono text-small text-ink",
          tone === "pos" && "text-pos",
          tone === "neg" && "text-neg",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function ForecastChart({
  mode,
  series,
}: {
  mode: ChartMode;
  series: { label: string; values: number[]; color: string; dashed?: boolean }[];
}) {
  const width = 720;
  const height = 260;
  const padding = 24;
  const allValues = series.flatMap((entry) => entry.values);
  const min = Math.min(0, ...allValues);
  const max = Math.max(1, ...allValues);
  const range = max - min || 1;

  const pathFor = (values: number[]) =>
    values
      .map((value, index) => {
        const x =
          padding +
          (values.length <= 1
            ? 0
            : (index / (values.length - 1)) * (width - padding * 2));
        const y = height - padding - ((value - min) / range) * (height - 52);
        return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-mono text-ui uppercase text-muted">
          {chartLabel(mode)}
        </p>
        <div className="flex flex-wrap gap-3">
          {series.map((entry) => (
            <span
              key={entry.label}
              className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-mono-ui text-muted"
            >
              <span
                className="h-2 w-5"
                style={{ backgroundColor: entry.color }}
              />
              {entry.label}
            </span>
          ))}
        </div>
      </div>
      <div className="border border-rule bg-inset p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[260px] w-full"
          role="img"
          aria-label={`${chartLabel(mode)} chart`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
            const y = padding + tick * (height - padding * 2);
            return (
              <line
                key={tick}
                x1={padding}
                x2={width - padding}
                y1={y}
                y2={y}
                stroke="var(--border-subtle)"
                strokeWidth="1"
              />
            );
          })}
          {series.map((entry) => (
            <path
              key={entry.label}
              d={pathFor(entry.values)}
              fill="none"
              stroke={entry.color}
              strokeWidth="2"
              strokeDasharray={entry.dashed ? "6 6" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

function buildAssumptions(
  form: ForecastFormState,
  marketName?: string,
): LpForecastAssumptions {
  const depositAmount = parseNumber(form.depositAmount, 0);
  const withdrawalAmount = parseNumber(form.withdrawalAmount, 0);
  return {
    marketName: marketName ?? "Selected Soo market",
    initialLiquidity: parseNumber(form.initialLiquidity, 1_000),
    initialProbability: parsePercent(form.initialProbability, 0.5),
    expectedOutcomeProbability: parsePercent(
      form.expectedOutcomeProbability,
      0.58,
    ),
    durationDays: parseNumber(form.durationDays, 30),
    dailyVolume: parseNumber(form.dailyVolume, 2_500),
    volatility: parsePercent(form.volatility, 0.18),
    preGradFeeRate: parsePercent(form.preGradFeeRate, 0.05),
    postGradFeeRate: parsePercent(form.postGradFeeRate, 0.01),
    bBaseShare: parsePercent(form.bBaseShare, 0.5),
    lpYieldShare: parsePercent(form.lpYieldShare, 0.3),
    protocolShare: 0.1,
    adjudicatorShare: 0.1,
    creatorLpShare: parsePercent(form.creatorLpShare, 1),
    graduationThresholdMultiplier: 1,
    cashflowEvents: [
      ...(depositAmount > 0
        ? [
            {
              day: parseNumber(form.depositDay, 0),
              type: "deposit" as const,
              amount: depositAmount,
              label: "Creator adds liquidity",
            },
          ]
        : []),
      ...(withdrawalAmount > 0
        ? [
            {
              day: parseNumber(form.withdrawalDay, 0),
              type: "withdrawal" as const,
              amount: withdrawalAmount,
              label: "Creator redeems liquidity",
            },
          ]
        : []),
    ],
  };
}


function buildChartSeries(mode: ChartMode, scenarios: LpScenarioResult[]) {
  return scenarios.map((scenario) => ({
    label: scenario.label,
    values: scenario.points.map((point) => chartValue(mode, point)),
    color:
      scenario.id === "downside"
        ? "var(--neg)"
        : scenario.id === "upside"
          ? "var(--pos)"
          : "var(--accent)",
  }));
}

function chartValue(mode: ChartMode, point: LpForecastPoint): number {
  if (mode === "fees") return point.cumulativeFees;
  if (mode === "exposure") return point.inventoryExposure;
  if (mode === "cashflow") return point.netContributedCapital;
  return point.equity - point.netContributedCapital;
}

function chartLabel(mode: ChartMode): string {
  if (mode === "fees") return "Cumulative fees";
  if (mode === "exposure") return "Inventory exposure";
  if (mode === "cashflow") return "Net contributed capital";
  return "Cumulative P&L";
}

function samplePoints(points: LpForecastPoint[]) {
  if (points.length <= 7) return points;
  const indexes = new Set<number>([
    0,
    Math.floor(points.length * 0.2),
    Math.floor(points.length * 0.4),
    Math.floor(points.length * 0.6),
    Math.floor(points.length * 0.8),
    points.length - 1,
  ]);
  points.forEach((point, index) => {
    if (point.cashflowType) indexes.add(index);
  });
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => points[index])
    .filter(Boolean);
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePercent(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed / 100;
}

function patchForm(
  setForm: Dispatch<SetStateAction<ForecastFormState>>,
  key: keyof ForecastFormState,
  value: string,
) {
  setForm((current) => ({ ...current, [key]: value }));
}

function formatInputNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 100) return value.toFixed(0);
  return value.toFixed(2);
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return "$0";
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(value / 1_000).toFixed(1)}k`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(2)}k`;
  return `$${value.toFixed(abs >= 100 ? 0 : 2)}`;
}

function formatSignedUsd(value: number): string {
  if (value === 0) return "$0";
  return `${value > 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortLabel(label: string): string {
  return label.length > 34 ? `${label.slice(0, 31)}...` : label;
}

export default LPForecast;
