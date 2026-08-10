import { useState, useMemo } from "react";
import { tokenSymbols } from "../../../lib/config";
import { motion, AnimatePresence } from "framer-motion";
import {
  Palette,
  Gamepad2,
  ArrowLeftRight,
  Swords,
  Coins,
  TrendingUp,
  DollarSign,
  Percent,
  Clock,
  Target,
  Zap,
  AlertTriangle,
  HelpCircle,
  Sparkles,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { useTranslation } from "react-i18next";
import {
  calculateCreatorPnL,
  calculateGamingTraderPnL,
  calculateArbitrageurPnL,
  calculatePvPTraderPnL,
  formatCurrency,
  formatPercent,
  CreatorResult,
  GamingTraderResult,
  ArbitrageurResult,
  PvPTraderResult,
} from "../../../lib/pnl-calculators";

type Archetype = "creator" | "gaming" | "arb" | "pvp";

interface ArchetypeConfig {
  id: Archetype;
  nameKey: string;
  icon: typeof Palette;
  storyKey: string;
  surface: string;
}

// Archetype surface maps to a semantic token: creator=accent (brand),
// gaming=pos (upside/win), arb=neutral surface (infrastructure), pvp=neg
// (winner-takes-all risk).
const ARCHETYPES: ArchetypeConfig[] = [
  {
    id: "creator",
    nameKey: "launchpad.sim.creator",
    icon: Palette,
    storyKey: "launchpad.sim.carolStory",
    surface: "bg-accent-soft",
  },
  {
    id: "gaming",
    nameKey: "launchpad.sim.gamingTrader",
    icon: Gamepad2,
    storyKey: "launchpad.sim.aliceStory",
    surface: "bg-pos-soft",
  },
  {
    id: "arb",
    nameKey: "launchpad.sim.arbitrageur",
    icon: ArrowLeftRight,
    storyKey: "launchpad.sim.bobStory",
    surface: "bg-bg-raised",
  },
  {
    id: "pvp",
    nameKey: "launchpad.sim.pvpTrader",
    icon: Swords,
    storyKey: "launchpad.sim.daveStory",
    surface: "bg-neg-soft",
  },
];

interface SliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  icon?: typeof DollarSign;
  hint?: string;
}

const Slider = ({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  icon: Icon,
  hint,
}: SliderProps) => (
  <div className="space-y-2">
    <div className="flex justify-between items-center">
      <span className="text-sm text-muted flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4" />}
        {label}
        {hint && (
          <span className="group relative">
            <HelpCircle className="w-3.5 h-3.5 text-faint hover:text-muted cursor-help" />
            <span className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 bg-tooltip border border-rule text-xs text-ink w-48 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-[9999]">
              {hint}
            </span>
          </span>
        )}
      </span>
      <span className="text-sm font-mono font-bold text-ink">
        {format ? format(value) : value}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="slider"
    />
    <div className="flex justify-between text-xs text-faint font-mono">
      <span>{format ? format(min) : min}</span>
      <span>{format ? format(max) : max}</span>
    </div>
  </div>
);

const ResultCard = ({
  label,
  value,
  subtext,
  positive,
}: {
  label: string;
  value: string;
  subtext?: string;
  positive?: boolean;
}) => (
  <div className="p-3 bg-ink/5">
    <p className="font-mono text-xs text-faint uppercase tracking-[0.12em]">
      {label}
    </p>
    <p
      className={cn(
        "text-lg font-mono font-bold mt-1",
        positive === true && "text-ink",
        positive === false && "text-error",
        positive === undefined && "text-ink",
      )}
    >
      {value}
    </p>
    {subtext && <p className="text-xs text-faint mt-0.5">{subtext}</p>}
  </div>
);

interface EquationTerm {
  value: string;
  label: string;
}

const Equation = ({
  result,
  resultLabel,
  terms,
  useArrow = false,
}: {
  result: string;
  resultLabel: string;
  terms: EquationTerm[];
  useArrow?: boolean;
}) => (
  <div className="p-4 bg-ink/5">
    <div className="flex items-center justify-center gap-2 flex-wrap">
      <div className="text-center">
        <p className="text-xl font-mono font-black text-ink">{result}</p>
        <p className="font-mono text-xs text-faint uppercase tracking-[0.12em]">
          {resultLabel}
        </p>
      </div>
      <span className="text-faint text-lg font-mono">
        {useArrow ? "←" : "="}
      </span>
      {terms.map((term, i) => (
        <div key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-faint text-lg font-mono">+</span>}
          <div className="text-center">
            <p className="text-lg font-mono font-bold text-muted">
              {term.value}
            </p>
            <p className="font-mono text-xs text-faint uppercase tracking-[0.12em]">
              {term.label}
            </p>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const CreatorPanel = () => {
  const { t } = useTranslation();
  const [liquidityTier, setLiquidityTier] = useState(1000);
  const [volume, setVolume] = useState(100000);
  const [imbalance, setImbalance] = useState(0);
  const [initialProbability, setInitialProbability] = useState(50);

  const result = useMemo(
    () =>
      calculateCreatorPnL(liquidityTier, volume, imbalance, initialProbability),
    [liquidityTier, volume, imbalance, initialProbability],
  );

  return (
    <div className="space-y-6">
      <div className="p-4 bg-accent-muted">
        <p className="text-sm text-accent">
          <span className="font-bold">{t("launchpad.sim.carolStrategy")}</span>{" "}
          {t("launchpad.sim.carolDesc")}
        </p>
      </div>

      <div className="space-y-4">
        <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
          {t("launchpad.sim.influenceFactors")}
        </h4>

        <Slider
          label={t("launchpad.sim.liquidityB")}
          value={liquidityTier}
          onChange={setLiquidityTier}
          min={100}
          max={10000}
          step={100}
          format={(v) => `${v.toLocaleString()} ${tokenSymbols.amm}`}
          icon={DollarSign}
        />

        <Slider
          label={t("launchpad.initialProbabilityLabel")}
          value={initialProbability}
          onChange={setInitialProbability}
          min={1}
          max={99}
          step={1}
          format={(v) => `${v}% YES`}
          icon={Percent}
          hint={t("launchpad.initialProbabilityHint")}
        />

        <Slider
          label={t("launchpad.sim.tradingVolume")}
          value={volume}
          onChange={setVolume}
          min={1000}
          max={1000000}
          step={1000}
          format={(v) =>
            v >= 1000000
              ? `${(v / 1000000).toFixed(1)}M ${tokenSymbols.amm}`
              : `${(v / 1000).toFixed(0)}k ${tokenSymbols.amm}`
          }
          icon={TrendingUp}
        />

        <Slider
          label={t("launchpad.sim.settlementLuck")}
          value={imbalance}
          onChange={setImbalance}
          min={-0.5}
          max={0.5}
          step={0.1}
          format={(v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`}
          icon={Target}
          hint="How the market resolves for LP. Negative = unlucky (lose). Positive = lucky (gain)."
        />
      </div>

      <div className="space-y-3">
        <div className="p-3 bg-ink/5">
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted">
              {t("launchpad.sim.yourLpOwnership")}
            </span>
            <span className="font-mono font-bold text-ink">
              {result.lpTokens} / {result.totalLpSupply} ={" "}
              {(result.ownershipPercent * 100).toFixed(0)}%
            </span>
          </div>
        </div>

        <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
          {t("launchpad.sim.lpEquation")}{" "}
          <span className="text-faint font-mono normal-case">
            [{(result.ownershipPercent * 100).toFixed(0)}%]
          </span>
        </h4>

        <Equation
          result={formatCurrency(result.lpRedemption)}
          resultLabel={t("launchpad.sim.lpRedemption")}
          terms={[
            {
              value: formatCurrency(result.lpDeposit),
              label: t("launchpad.sim.deposit"),
            },
            {
              value: formatCurrency(result.flywheelGrowth),
              label: t("launchpad.sim.flywheel"),
            },
            {
              value: formatCurrency(result.settlementOutcome),
              label: t("launchpad.sim.settlement"),
            },
            {
              value: formatCurrency(result.feeYield),
              label: t("launchpad.sim.feeYield"),
            },
          ]}
        />

        <div className="p-4 bg-raised">
          <div className="flex justify-between items-center">
            <div>
              <p className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                {t("launchpad.sim.netPnL")}
              </p>
              <p className="text-2xl font-mono font-black text-accent">
                {formatCurrency(result.netPnL)}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                {t("launchpad.sim.roi")}
              </p>
              <p className="text-2xl font-mono font-black text-accent">
                {result.roi < 0
                  ? `(${Math.abs(result.roi)}%)`
                  : `${result.roi}%`}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 p-3 bg-ink/5 text-xs text-muted">
          <Sparkles className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <span>
            <span className="font-bold text-ink">
              {t("launchpad.sim.lmsrProperty")}
            </span>{" "}
            {t("launchpad.sim.lmsrMaxLoss")}
          </span>
        </div>
      </div>
    </div>
  );
};

const EntryTimingToggle = ({
  isPreGrad,
  onChange,
}: {
  isPreGrad: boolean;
  onChange: (v: boolean) => void;
}) => (
  <div className="grid grid-cols-2 gap-1 p-1 bg-ink/5">
    <button
      onClick={() => onChange(false)}
      className={cn(
        "py-2.5 px-3 text-sm font-bold transition-all",
        !isPreGrad ? "text-accent" : "text-muted hover:text-ink",
      )}
    >
      <span className="block">Post-Grad</span>
      <span className="block text-xs font-normal opacity-70">1% fee</span>
    </button>
    <button
      onClick={() => onChange(true)}
      className={cn(
        "py-2.5 px-3 text-sm font-bold transition-all",
        isPreGrad ? "text-accent" : "text-muted hover:text-ink",
      )}
    >
      <span className="block">Pre-Grad</span>
      <span className="block text-xs font-normal opacity-70">5% fee → LP</span>
    </button>
  </div>
);

const GamingTraderPanel = () => {
  const { t } = useTranslation();
  const [tradeSize, setTradeSize] = useState(200);
  const [entryPrice, setEntryPrice] = useState(0.5);
  const [isPreGrad, setIsPreGrad] = useState(true);
  const [isCorrect, setIsCorrect] = useState(true);
  const [volumeAfter, setVolumeAfter] = useState(50000);
  const [imbalance, setImbalance] = useState(0);

  const result = useMemo(
    () =>
      calculateGamingTraderPnL(
        tradeSize,
        entryPrice,
        isPreGrad,
        isCorrect,
        volumeAfter,
        imbalance,
      ),
    [tradeSize, entryPrice, isPreGrad, isCorrect, volumeAfter, imbalance],
  );

  return (
    <div className="space-y-6">
      <div className="p-4 bg-accent-muted">
        <p className="text-sm text-accent">
          <span className="font-bold">{t("launchpad.sim.aliceStrategy")}</span>{" "}
          {t("launchpad.sim.aliceDesc")}
        </p>
      </div>

      <div className="space-y-4">
        <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
          {t("launchpad.sim.influenceFactors")}
        </h4>

        <Slider
          label={t("launchpad.sim.tradeSize")}
          value={tradeSize}
          onChange={setTradeSize}
          min={50}
          max={2000}
          step={50}
          format={(v) => `${v} ${tokenSymbols.amm}`}
          icon={DollarSign}
        />

        <Slider
          label={t("launchpad.sim.entryPrice")}
          value={entryPrice}
          onChange={setEntryPrice}
          min={0.05}
          max={0.95}
          step={0.05}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          icon={Target}
        />

        <div className="space-y-2">
          <span className="text-sm text-muted flex items-center gap-2">
            <Target className="w-4 h-4" />
            {t("launchpad.sim.predictionOutcome")}
          </span>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setIsCorrect(true)}
              className={cn(
                "p-3 text-sm font-bold border transition-all",
                isCorrect
                  ? "bg-accent-muted border-accent text-ink"
                  : "bg-ink/5 border-rule text-muted",
              )}
            >
              {t("launchpad.sim.correct")}
            </button>
            <button
              onClick={() => setIsCorrect(false)}
              className={cn(
                "p-3 text-sm font-bold border transition-all",
                !isCorrect
                  ? "bg-raised border-error text-error"
                  : "bg-ink/5 border-rule text-muted",
              )}
            >
              {t("launchpad.sim.wrong")}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
            {t("launchpad.sim.tradeEquation")}
          </h4>
          <Equation
            result={formatCurrency(result.tradePnL)}
            resultLabel={t("launchpad.sim.tradePnL")}
            terms={[
              {
                value: `${result.sharesReceived}`,
                label: isCorrect
                  ? t("launchpad.sim.payout")
                  : `${t("launchpad.sim.payout")} ($0)`,
              },
              {
                value: formatCurrency(-result.positionValue),
                label: t("launchpad.sim.cost"),
              },
            ]}
          />
        </div>

        <EntryTimingToggle isPreGrad={isPreGrad} onChange={setIsPreGrad} />

        {isPreGrad && (
          <>
            <Slider
              label={t("launchpad.sim.volumeAfterEntry")}
              value={volumeAfter}
              onChange={setVolumeAfter}
              min={1000}
              max={1000000}
              step={1000}
              format={(v) =>
                v >= 1000000
                  ? `${(v / 1000000).toFixed(1)}M ${tokenSymbols.amm}`
                  : `${(v / 1000).toFixed(0)}k ${tokenSymbols.amm}`
              }
              icon={TrendingUp}
            />

            <Slider
              label={t("launchpad.sim.settlementLuck")}
              value={imbalance}
              onChange={setImbalance}
              min={-0.5}
              max={0.5}
              step={0.1}
              format={(v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`}
              icon={Target}
              hint="How market resolves for LP. Negative = unlucky. Positive = lucky."
            />
          </>
        )}
      </div>

      <div className="space-y-4">
        {isPreGrad && (
          <>
            <div className="p-3 bg-ink/5">
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted">
                  {t("launchpad.sim.yourLpOwnership")}
                </span>
                <span className="font-mono font-bold text-ink">
                  ${result.lpDeposit} / ${result.totalLpSupply} ={" "}
                  {(result.ownershipPercent * 100).toFixed(2)}%
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                  {t("launchpad.sim.lpEquation")}{" "}
                  <span className="text-faint font-mono normal-case">
                    [{(result.ownershipPercent * 100).toFixed(2)}%]
                  </span>
                </h4>
                <span className="text-xs text-faint italic">
                  *2k {tokenSymbols.amm} graduation
                </span>
              </div>
              <Equation
                result={formatCurrency(result.lpRedemption)}
                resultLabel={t("launchpad.sim.lpRedemption")}
                terms={[
                  {
                    value: formatCurrency(result.lpDeposit),
                    label: t("launchpad.sim.deposit"),
                  },
                  {
                    value: formatCurrency(result.flywheelGrowth),
                    label: t("launchpad.sim.flywheel"),
                  },
                  {
                    value: formatCurrency(result.settlementOutcome),
                    label: t("launchpad.sim.settlement"),
                  },
                  {
                    value: formatCurrency(result.feeYield),
                    label: t("launchpad.sim.feeYield"),
                  },
                ]}
              />
            </div>
          </>
        )}

        <div className="p-4 bg-raised">
          <div className="flex justify-between items-center">
            <div>
              <p className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                {t("launchpad.sim.netPnL")}
              </p>
              <p className="text-2xl font-mono font-black text-accent">
                {formatCurrency(result.netPnL)}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                {t("launchpad.sim.roi")}
              </p>
              <p className="text-2xl font-mono font-black text-accent">
                {result.roi < 0
                  ? `(${Math.abs(result.roi)}%)`
                  : `${result.roi}%`}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 p-3 bg-ink/5 text-xs text-muted">
          <Sparkles className="w-4 h-4 text-ink shrink-0 mt-0.5" />
          <span>
            {isPreGrad ? (
              <span>
                <span className="font-bold text-ink">
                  {t("launchpad.sim.preGradBonus")}
                </span>{" "}
                {isCorrect
                  ? "Trade profit + LP redemption = double upside!"
                  : `Trade loss cushioned by LP redemption of ${formatCurrency(result.lpRedemption)}.`}
              </span>
            ) : (
              <span>
                <span className="font-bold text-ink">
                  {t("launchpad.sim.postGrad")}:
                </span>{" "}
                {t("launchpad.sim.postGradNote")}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
};

const ArbitrageurPanel = () => {
  const { t } = useTranslation();
  const [tradeSize, setTradeSize] = useState(5000);
  const [spread, setSpread] = useState(0.04);
  const [gasCost, setGasCost] = useState(1);

  const result = useMemo(
    () => calculateArbitrageurPnL(tradeSize, spread, gasCost),
    [tradeSize, spread, gasCost],
  );

  return (
    <div className="space-y-6">
      <div className="p-4 bg-raised">
        <p className="text-sm text-accent">
          <span className="font-bold">{t("launchpad.sim.bobStrategy")}</span>{" "}
          {t("launchpad.sim.bobDesc")}
        </p>
      </div>

      <div className="space-y-4">
        <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
          {t("launchpad.sim.influenceFactors")}
        </h4>

        <Slider
          label={t("launchpad.sim.tradeSize")}
          value={tradeSize}
          onChange={setTradeSize}
          min={500}
          max={50000}
          step={500}
          format={(v) => `${(v / 1000).toFixed(1)}k ${tokenSymbols.amm}`}
          icon={DollarSign}
        />

        <Slider
          label={t("launchpad.sim.priceDivergence")}
          value={spread}
          onChange={setSpread}
          min={0.005}
          max={0.1}
          step={0.005}
          format={(v) => `${(v * 100).toFixed(1)}%`}
          icon={Percent}
        />

        <Slider
          label={t("launchpad.sim.gasCost")}
          value={gasCost}
          onChange={setGasCost}
          min={0.1}
          max={10}
          step={0.1}
          format={(v) => `$${v.toFixed(2)}`}
          icon={Zap}
        />
      </div>

      <div className="space-y-3">
        <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
          Bob's P&L
        </h4>

        <div className="grid grid-cols-3 gap-3">
          <ResultCard
            label={t("launchpad.sim.grossProfit")}
            value={formatCurrency(result.grossProfit)}
            subtext={`${result.spreadPercent.toFixed(1)}% spread`}
          />
          <ResultCard
            label={t("launchpad.sim.totalCosts")}
            value={formatCurrency(result.totalCosts)}
            subtext={`Gas + ${formatCurrency(result.ammFee)} fee`}
          />
          <ResultCard
            label={t("launchpad.sim.netProfit")}
            value={`${result.netProfit >= 0 ? "+" : ""}${formatCurrency(result.netProfit)}`}
            positive={result.isProfitable}
          />
        </div>

        <div
          className={cn(
            "p-4 border",
            result.isProfitable
              ? "bg-raised border-accent"
              : "bg-raised border-error",
          )}
        >
          <div className="flex justify-between items-center">
            <div>
              <p className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                {result.isProfitable
                  ? t("launchpad.sim.profitable")
                  : t("launchpad.sim.notProfitable")}
              </p>
              <p
                className={cn(
                  "text-2xl font-mono font-black",
                  result.isProfitable ? "text-ink" : "text-error",
                )}
              >
                {result.returnPercent >= 0 ? "+" : ""}
                {result.returnPercent}%
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                {t("launchpad.sim.minViableSpread")}
              </p>
              <p className="text-lg font-mono font-bold text-ink">
                {result.minViableSpread.toFixed(2)}%
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 p-3 bg-ink/5 text-xs text-muted">
          <Sparkles className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <span>
            <span className="font-bold text-ink">
              {t("launchpad.sim.keyInsight")}
            </span>{" "}
            {t("launchpad.sim.arbInsight")}
          </span>
        </div>
      </div>
    </div>
  );
};

const PvPTraderPanel = () => {
  const { t } = useTranslation();
  const [positionSize, setPositionSize] = useState(1000);
  const [entryPrice, setEntryPrice] = useState(0.35);
  const [winProb, setWinProb] = useState(0.6);
  const [outcome, setOutcome] = useState<"win" | "lose" | "expected">(
    "expected",
  );

  const result = useMemo(
    () => calculatePvPTraderPnL(positionSize, entryPrice, winProb, outcome),
    [positionSize, entryPrice, winProb, outcome],
  );

  return (
    <div className="space-y-6">
      <div className="p-4 bg-raised">
        <p className="text-sm text-accent">
          <span className="font-bold">{t("launchpad.sim.daveStrategy")}</span>{" "}
          {t("launchpad.sim.daveDesc")}
        </p>
      </div>

      <div className="space-y-4">
        <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
          {t("launchpad.sim.influenceFactors")}
        </h4>

        <Slider
          label={t("launchpad.sim.positionSize")}
          value={positionSize}
          onChange={setPositionSize}
          min={100}
          max={10000}
          step={100}
          format={(v) => `${v.toLocaleString()} ${tokenSymbols.amm}`}
          icon={DollarSign}
        />

        <Slider
          label={t("launchpad.sim.entryPrice")}
          value={entryPrice}
          onChange={setEntryPrice}
          min={0.05}
          max={0.95}
          step={0.05}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          icon={Target}
        />

        <Slider
          label={t("launchpad.sim.estimatedWinProb")}
          value={winProb}
          onChange={setWinProb}
          min={0.1}
          max={0.9}
          step={0.05}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          icon={Percent}
        />

        <div className="space-y-2">
          <span className="text-sm text-muted flex items-center gap-2">
            <Target className="w-4 h-4" />
            {t("launchpad.sim.outcomeScenario")}
          </span>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => setOutcome("win")}
              className={cn(
                "p-3 text-sm font-bold border transition-all",
                outcome === "win"
                  ? "text-accent border-accent"
                  : "text-muted border-rule",
              )}
            >
              {t("launchpad.sim.win")}
            </button>
            <button
              onClick={() => setOutcome("lose")}
              className={cn(
                "p-3 text-sm font-bold border transition-all",
                outcome === "lose"
                  ? "text-error border-error"
                  : "text-muted border-rule",
              )}
            >
              {t("launchpad.sim.lose")}
            </button>
            <button
              onClick={() => setOutcome("expected")}
              className={cn(
                "p-3 text-sm font-bold border transition-all",
                outcome === "expected"
                  ? "text-accent border-accent"
                  : "text-muted border-rule",
              )}
            >
              {t("launchpad.sim.expected")}
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
          Dave's P&L
        </h4>

        <div className="grid grid-cols-2 gap-3">
          <ResultCard
            label="Shares Received"
            value={result.sharesReceived.toLocaleString()}
            subtext={`@ ${(entryPrice * 100).toFixed(0)}%`}
          />
          <ResultCard
            label="Expected Value"
            value={`${result.expectedValue >= 0 ? "+" : ""}${formatCurrency(result.expectedValue)}`}
            subtext={result.expectedValue > 0 ? "+EV bet!" : "-EV bet"}
            positive={result.expectedValue > 0}
          />
          <ResultCard
            label="If Win"
            value={`+${formatCurrency(result.profitIfWin)}`}
            subtext={`+${Math.round((result.profitIfWin / positionSize) * 100)}% return`}
            positive={true}
          />
          <ResultCard
            label="If Lose"
            value={formatCurrency(result.lossIfWrong)}
            subtext="100% loss"
            positive={false}
          />
        </div>

        <div
          className={cn(
            "p-4 border",
            result.actualPnL >= 0
              ? "bg-raised border-rule"
              : "bg-raised border-error",
          )}
        >
          <div className="flex justify-between items-center">
            <div>
              <p className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                {outcome === "expected"
                  ? "Expected P&L"
                  : `Actual P&L (${outcome})`}
              </p>
              <p
                className={cn(
                  "text-2xl font-mono font-black",
                  result.actualPnL >= 0 ? "text-ink" : "text-error",
                )}
              >
                {result.actualPnL >= 0 ? "+" : ""}
                {formatCurrency(result.actualPnL)}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                Return
              </p>
              <p
                className={cn(
                  "text-2xl font-mono font-black",
                  result.returnPercent >= 0 ? "text-ink" : "text-error",
                )}
              >
                {result.returnPercent >= 0 ? "+" : ""}
                {result.returnPercent}%
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 p-3 bg-raised text-xs text-accent">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            <span className="font-bold">Warning:</span> PvP trading has NO LP
            safety net. If you don't have an edge, you're the counterparty smart
            money bets against.
          </span>
        </div>
      </div>
    </div>
  );
};

export const PnLSimulator = () => {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const activeArchetype = ARCHETYPES[activeIndex];

  const renderPanel = () => {
    switch (activeArchetype.id) {
      case "creator":
        return <CreatorPanel />;
      case "gaming":
        return <GamingTraderPanel />;
      case "arb":
        return <ArbitrageurPanel />;
      case "pvp":
        return <PvPTraderPanel />;
    }
  };

  return (
    <div className="relative overflow-hidden bg-inset/60">
      <div className="p-6 pb-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "w-10 h-10 flex items-center justify-center",
                activeArchetype.surface,
              )}
            >
              <activeArchetype.icon className="w-5 h-5 text-ink" />
            </div>
            <div>
              <h3 className="text-lg font-black text-ink flex items-center gap-2">
                {t(activeArchetype.nameKey)}
              </h3>
              <p className="text-xs text-muted">
                {t(activeArchetype.storyKey)}
              </p>
            </div>
          </div>
        </div>

        {/* Desktop: Tab navigation — accent-muted bg for selected (no frame) */}
        <div className="hidden sm:flex gap-2">
          {ARCHETYPES.map((arch, i) => (
            <button
              key={arch.id}
              onClick={() => setActiveIndex(i)}
              className={cn(
                "flex-1 p-3 font-mono text-xs uppercase tracking-[0.1em] border border-transparent transition-all",
                i === activeIndex
                  ? "bg-accent-muted text-accent"
                  : "text-muted hover:text-ink hover:bg-raised",
              )}
            >
              {t(arch.nameKey)}
            </button>
          ))}
        </div>

        <div className="sm:hidden flex justify-center gap-2">
          {ARCHETYPES.map((_, i) => (
            <button
              key={i}
              onClick={() => setActiveIndex(i)}
              className={cn(
                "h-2 rounded-full transition-all",
                i === activeIndex ? "w-6 bg-ink" : "w-2 bg-ink/30",
              )}
            />
          ))}
        </div>
      </div>

      <div className="p-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeArchetype.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            {renderPanel()}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};
