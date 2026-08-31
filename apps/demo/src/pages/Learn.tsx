/**
 * Learn — actor-centric onboarding
 *
 * Based on Sooth Whitepaper (Dec 2025)
 * Organised around the actors and the three pillars of decentralization.
 */
import React, { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  ChevronRight,
  ChevronLeft,
  CheckCircle,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Clock,
  Lock,
  GraduationCap,
  Rocket,
  Shield,
  BarChart3,
  Users,
  Palette,
  Gamepad2,
  ArrowLeftRight,
  Swords,
  Info,
  RefreshCw,
  CircleDollarSign,
} from "lucide-react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Tooltip } from "../components/ui/Tooltip";
import { cn } from "../lib/utils";

const STEP_IDS = ["thesis", "creator", "gaming", "pro", "ready"] as const;

// --- Subcomponents ---

const PillarCard: React.FC<{
  icon: any;
  title: string;
  description: string;
  innovation: string;
}> = ({ icon: Icon, title, description, innovation }) => (
  <div className="p-4 border border-rule bg-raised hover:bg-raised transition-colors h-full">
    <Icon className="w-5 h-5 text-muted mb-4" />
    <h3 className="font-bold text-ink mb-2">{title}</h3>
    <p className="text-sm text-muted mb-4">{description}</p>
    <div className="pt-3 border-t border-rule">
      <p className="font-mono text-xs uppercase tracking-[0.12em] text-accent mb-1">
        Innovation
      </p>
      <p className="text-xs text-ink">{innovation}</p>
    </div>
  </div>
);

const ActorCard: React.FC<{
  icon: any;
  title: string;
  motivation: string;
  colorClass: string;
  onClick?: () => void;
}> = ({ icon: Icon, title, motivation, colorClass, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full h-full text-left p-4 border border-rule bg-raised hover:bg-raised transition-all focus-ring group flex flex-col items-start`}
  >
    <Icon className={`w-5 h-5 mb-3 text-muted`} />
    <h3 className="font-bold text-ink group-hover:text-accent transition-colors">
      {title}
    </h3>
    <p className="text-xs text-muted mt-1 leading-relaxed">{motivation}</p>
  </button>
);

// Interactive LMSR curve component (reused and contextualized)
const LMSRCurve: React.FC = () => {
  const [shares, setShares] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const calculatePrice = (q: number) => {
    const b = 1000;
    const Q = 1000;
    return Math.exp(q / b) / (Math.exp(q / b) + Math.exp((Q - q) / b));
  };

  const price = calculatePrice(500 + shares);
  const cost = shares > 0 ? shares * price : 0;

  const handleDrag = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const width = rect.width;
      const newShares = Math.round((x / width - 0.5) * 1000);
      setShares(Math.max(-400, Math.min(400, newShares)));
    },
    [isDragging],
  );

  return (
    <div className="bg-raised p-4 border border-rule">
      <div className="flex justify-between text-sm mb-4">
        <span className="text-muted">Current Price (Probability)</span>
        <span className="font-mono text-lg text-ink tabular-nums">
          {(price * 100).toFixed(1)}%
        </span>
      </div>

      <div
        className="relative h-40 cursor-crosshair"
        onMouseDown={() => setIsDragging(true)}
        onMouseUp={() => setIsDragging(false)}
        onMouseLeave={() => setIsDragging(false)}
        onMouseMove={handleDrag}
      >
        <svg viewBox="0 0 400 160" className="w-full h-full">
          <line
            x1="0"
            y1="80"
            x2="400"
            y2="80"
            stroke="#2a2a28"
            strokeDasharray="4"
          />
          <line
            x1="200"
            y1="0"
            x2="200"
            y2="160"
            stroke="#2a2a28"
            strokeDasharray="4"
          />
          <path
            d="M 0,140 Q 100,130 150,100 T 200,80 T 250,60 T 400,20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle
            cx={200 + shares / 2.5}
            cy={160 - price * 140}
            r="8"
            fill="currentColor"
            stroke="white"
            strokeWidth="2"
            className="cursor-grab"
          />
          <text x="10" y="155" fill="#706b63" fontSize="10">
            $0.00
          </text>
          <text x="10" y="15" fill="#706b63" fontSize="10">
            $1.00
          </text>
          <text x="380" y="155" fill="#706b63" fontSize="10" textAnchor="end">
            Inventory Shift →
          </text>
        </svg>
      </div>

      <p className="text-center text-xs text-muted mt-2">
        👆 Drag to see how tradingYES vs NO shifts the price curve
      </p>

      {shares !== 0 && (
        <div className="mt-4 p-3 bg-accent-muted border border-accent text-sm">
          <div className="flex justify-between">
            <span className="text-muted font-medium">
              {shares > 0 ? "Buying" : "Selling"} {Math.abs(shares)} shares
            </span>
            <span className="text-ink font-mono font-bold">
              {shares > 0 ? "Impact" : "Recovery"}: +
              {(Math.abs(shares) / 10).toFixed(1)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

// Sandbox trading panel (reused for Gaming Trader)
const SandboxTradingPanel: React.FC<{
  onTrade: (amount: number, isYes: boolean) => void;
}> = ({ onTrade }) => {
  const [amount, setAmount] = useState("100");
  const [selectedOutcome, setSelectedOutcome] = useState<"yes" | "no">("yes");
  const [isPending, setIsPending] = useState(false);

  const handleTrade = () => {
    setIsPending(true);
    setTimeout(() => {
      onTrade(parseFloat(amount), selectedOutcome === "yes");
      setIsPending(false);
      setAmount("100");
    }, 1000);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setSelectedOutcome("yes")}
          className={`p-4 border-2 transition-all focus-ring ${
            selectedOutcome === "yes"
              ? "border-accent bg-accent-muted"
              : "border-rule bg-raised hover:border-accent hover:-translate-y-0.5"
          }`}
        >
          <TrendingUp
            className={`w-6 h-6 mx-auto mb-2 transition-transform ${
              selectedOutcome === "yes" ? "text-ink scale-110" : "text-muted"
            }`}
          />
          <p
            className={`font-bold ${
              selectedOutcome === "yes" ? "text-ink" : "text-muted"
            }`}
          >
            YES
          </p>
          <p className="text-2xl font-bold mt-1 text-ink tabular-nums">62%</p>
        </button>
        <button
          onClick={() => setSelectedOutcome("no")}
          className={`p-4 border-2 transition-all focus-ring ${
            selectedOutcome === "no"
              ? "border-error bg-raised"
              : "border-rule bg-raised hover:border-error hover:-translate-y-0.5"
          }`}
        >
          <TrendingDown
            className={`w-6 h-6 mx-auto mb-2 transition-transform ${
              selectedOutcome === "no" ? "text-muted scale-110" : "text-muted"
            }`}
          />
          <p
            className={`font-bold ${
              selectedOutcome === "no" ? "text-muted" : "text-muted"
            }`}
          >
            NO
          </p>
          <p className="text-2xl font-bold mt-1 text-ink tabular-nums">38%</p>
        </button>
      </div>

      <div>
        <label className="block text-sm text-muted mb-2">Amount (USDC)</label>
        <div className="flex gap-2 mb-3">
          {["50", "100", "500"].map((preset) => (
            <button
              key={preset}
              onClick={() => setAmount(preset)}
              className={`quick-trade-btn flex-1 ${amount === preset ? "active" : ""}`}
            >
              ${preset}
            </button>
          ))}
        </div>
        <div className="relative">
          <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input-field pl-9"
            placeholder="Custom amount"
          />
        </div>
      </div>

      <div className="bg-raised p-3 space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted">You receive</span>
          <span className="text-ink font-mono font-bold">
            ~
            {(
              parseFloat(amount || "0") /
              (selectedOutcome === "yes" ? 0.62 : 0.38)
            ).toFixed(0)}{" "}
            shares
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted">Fee (5% Internal Phase)</span>
          <span className="text-ink font-mono font-bold text-right">
            +${(parseFloat(amount || "0") * 0.05).toFixed(2)} LP Reward
          </span>
        </div>
      </div>

      <Button
        variant={selectedOutcome === "yes" ? "success" : "danger"}
        className="w-full py-4 font-bold"
        onClick={handleTrade}
        isLoading={isPending}
      >
        Trade {selectedOutcome.toUpperCase()}
      </Button>
    </div>
  );
};

export const Learn = () => {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState(0);
  const [sandboxBalance, setSandboxBalance] = useState(10000);
  const [sandboxPositions, setSandboxPositions] = useState<
    Array<{
      isYes: boolean;
      shares: number;
      entryPrice: number;
    }>
  >([]);

  const handleSandboxTrade = (amount: number, isYes: boolean) => {
    const price = isYes ? 0.62 : 0.38;
    const shares = amount / price;
    setSandboxBalance((prev) => prev - amount);
    setSandboxPositions((prev) => [
      ...prev,
      { isYes, shares, entryPrice: price },
    ]);
  };

  const stepId = STEP_IDS[currentStep];

  return (
    <div className="min-h-dvh pb-12">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <BookOpen className="w-6 h-6 text-accent" />
              <h1 className="text-xl font-bold text-ink">
                {t("uc.learn.header.title")}
              </h1>
            </div>
            <p className="text-muted max-w-lg">
              {t("uc.learn.header.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/amm">
              <Button
                variant="ghost"
                className="text-muted hover:text-ink hover:border-transparent"
              >
                Skip to Trade →
              </Button>
            </Link>
          </div>
        </div>

        {/* Progress Timeline */}
        <div className="relative mb-16">
          <div className="absolute top-1/2 left-0 w-full h-0.5 bg-raised -translate-y-1/2" />
          <div className="flex justify-between relative z-10">
            {STEP_IDS.map((id, i) => (
              <div key={id} className="flex flex-col items-center">
                <button
                  onClick={() => setCurrentStep(i)}
                  className={`w-10 h-10 flex items-center justify-center transition-all font-mono text-sm focus:outline-none ${
                    i <= currentStep ? "bg-accent text-canvas" : "text-faint"
                  }`}
                >
                  {i + 1}
                </button>
                <span
                  className={`font-mono text-xs uppercase tracking-[0.12em] mt-3 ${
                    i <= currentStep ? "text-accent" : "text-muted"
                  }`}
                >
                  {id}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Content Container */}
        <div className="grid lg:grid-cols-12 gap-8 items-start">
          {/* Main Tutorial Card */}
          <div className="lg:col-span-8">
            <Card className="p-8 border-rule min-h-[500px] flex flex-col">
              {/* Step 1: Decentralization Thesis */}
              {currentStep === 0 && (
                <div className="space-y-8 flex-1">
                  <div>
                    <Badge
                      variant="outline"
                      className="mb-4 text-accent border-accent/30"
                    >
                      {t(`uc.learn.steps.${currentStep}.badge`)}
                    </Badge>
                    <h2 className="text-2xl font-bold text-ink mb-4">
                      {t(`uc.learn.steps.${currentStep}.title`)}
                    </h2>
                    <p className="text-muted leading-relaxed">
                      {t(`uc.learn.steps.${currentStep}.description`)
                        .split("**")
                        .map((part, i) =>
                          i % 2 === 1 ? (
                            <strong key={i} className="text-ink">
                              {part}
                            </strong>
                          ) : (
                            part
                          ),
                        )}
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-3 gap-4">
                    <PillarCard
                      icon={Rocket}
                      title={t("uc.learn.pillars.launchpad.title")}
                      description={t("uc.learn.pillars.launchpad.description")}
                      innovation={t("uc.learn.pillars.launchpad.innovation")}
                    />
                    <PillarCard
                      icon={Shield}
                      title={t("uc.learn.pillars.zkRules.title")}
                      description={t("uc.learn.pillars.zkRules.description")}
                      innovation={t("uc.learn.pillars.zkRules.innovation")}
                    />
                    <PillarCard
                      icon={BarChart3}
                      title={t("uc.learn.pillars.soothBook.title")}
                      description={t("uc.learn.pillars.soothBook.description")}
                      innovation={t("uc.learn.pillars.soothBook.innovation")}
                    />
                  </div>

                  {/* The LP mechanism, explained where someone reading ABOUT
                      the product will look for it — the market page links
                      here rather than carrying four sentences of theory
                      above its own trade form. */}
                  <div
                    id="liquidity"
                    className="bg-raised p-6 border border-rule scroll-mt-24"
                  >
                    <h4 className="text-sm font-bold text-ink mb-3 flex items-center gap-2">
                      <CircleDollarSign className="w-4 h-4 text-accent" />
                      Liquidity, and why nobody deposits it
                    </h4>
                    <div className="space-y-3 text-sm text-muted leading-relaxed">
                      <p>
                        Most venues ask liquidity providers to deposit capital
                        up front. Soo never does — a market's liquidity comes
                        from two places, and neither is a deposit form.
                      </p>
                      <p>
                        <strong className="text-ink">The creator's seed.</strong>{" "}
                        Launching a market funds its bonding curve, and the
                        creator receives LP tokens for it. That seed is what
                        makes the first trade possible.
                      </p>
                      <p>
                        <strong className="text-ink">Fee rebates.</strong> Every
                        pre-graduation trade mints the trader LP equal to the
                        fee they just paid. Trading the curve makes you a
                        liquidity provider as a side effect — you are paid back
                        in claims on the pool rather than in cash.
                      </p>
                      <p>
                        <strong className="text-ink">What LP is worth.</strong>{" "}
                        Redeeming LP pays your share of the market's LP yield
                        vault — the slice of trading fees set aside for
                        liquidity providers. Fees reach that vault when anyone
                        runs the permissionless distribution step, so the
                        market page shows both what is claimable now and what
                        is still pending.
                      </p>
                      <p>
                        <strong className="text-ink">When you can redeem.</strong>{" "}
                        LP unlocks the moment a market graduates, settles, or is
                        dismissed — whichever happens first.
                      </p>
                    </div>
                  </div>

                  <div className="bg-raised p-6 border border-rule">
                    <h4 className="text-sm font-bold text-ink mb-4 flex items-center gap-2">
                      <Swords className="w-4 h-4 text-accent" />
                      {t("uc.learn.advantage.title")}
                    </h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left">
                        <thead>
                          <tr className="text-muted border-b border-rule">
                            {[0, 1, 2].map((hi) => {
                              const h = t(
                                `uc.learn.advantage.table.headers.${hi}`,
                              );
                              return (
                                <th
                                  key={hi}
                                  className={cn(
                                    "pb-2 font-medium",
                                    h === "Soo" && "font-bold text-ink",
                                  )}
                                >
                                  {h}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody className="text-muted">
                          {[0, 1, 2].map((ri) => (
                            <tr key={ri} className="border-b border-rule/30">
                              <td className="py-3">
                                {t(`uc.learn.advantage.table.rows.${ri}.0`)}
                              </td>
                              <td className="py-3">
                                {t(`uc.learn.advantage.table.rows.${ri}.1`)}
                              </td>
                              <td className="py-3 text-ink">
                                {t(`uc.learn.advantage.table.rows.${ri}.2`)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 2: The Creator */}
              {currentStep === 1 && (
                <div className="space-y-8 flex-1">
                  <div>
                    <Badge
                      variant="outline"
                      className="mb-4 text-accent border-accent/30"
                    >
                      {t(`uc.learn.steps.${currentStep}.badge`)}
                    </Badge>
                    <h2 className="text-2xl font-bold text-ink mb-4">
                      {t(`uc.learn.steps.${currentStep}.title`)}
                    </h2>
                    <p className="text-muted">
                      {t(`uc.learn.steps.${currentStep}.description`)
                        .split("**")
                        .map((part, i) =>
                          i % 2 === 1 ? (
                            <strong key={i} className="text-ink">
                              {part}
                            </strong>
                          ) : (
                            part
                          ),
                        )}
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <h4 className="text-sm font-bold text-ink flex items-center gap-2">
                        <TrendingUp className="w-4 h-4 text-accent" />
                        {t("uc.learn.creator.plTitle")}
                      </h4>
                      <div className="space-y-3">
                        {[0, 1, 2, 3].map((i) => (
                          <div
                            key={i}
                            className="flex justify-between items-center text-xs p-3 bg-raised border border-rule"
                          >
                            <span className="text-muted">
                              {t(`uc.learn.creator.plItems.${i}.event`)}
                            </span>
                            <span
                              className={
                                t(`uc.learn.creator.plItems.${i}.pos`) ===
                                "True"
                                  ? "text-ink"
                                  : "text-muted"
                              }
                            >
                              {t(`uc.learn.creator.plItems.${i}.impact`)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-accent-muted p-6">
                      <h4 className="text-sm font-bold text-accent mb-4 uppercase tracking-widest">
                        {t("uc.learn.creator.example.title")}
                      </h4>
                      <p className="text-xs text-accent leading-relaxed mb-4">
                        {t("uc.learn.creator.example.text")
                          .split("**")
                          .map((part, i) =>
                            i % 2 === 1 ? (
                              <strong key={i} className="text-accent">
                                {part}
                              </strong>
                            ) : (
                              part
                            ),
                          )}
                      </p>
                      <div className="p-3 bg-inset text-center">
                        <span className="text-muted font-mono text-xs uppercase tracking-[0.12em] block mb-1">
                          {t("uc.learn.creator.example.pnlLabel")}
                        </span>
                        <span className="text-2xl font-bold text-accent">
                          {t("uc.learn.creator.example.pnlValue")}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h4 className="text-sm font-bold text-ink uppercase tracking-widest">
                      {t("uc.learn.creator.tiersTitle")}
                    </h4>
                    <div className="grid grid-cols-4 gap-2">
                      {[0, 1, 2, 3].map((i) => (
                        <div
                          key={i}
                          className="text-center p-3 border border-rule bg-raised"
                        >
                          <p className="text-xs text-muted mb-1">
                            {t(`uc.learn.creator.tiers.${i}.tier`)}
                          </p>
                          <p className="text-sm font-bold text-ink">
                            {t(`uc.learn.creator.tiers.${i}.b`)}
                          </p>
                          <p className="text-xs text-muted mt-1">
                            Deposit: {t(`uc.learn.creator.tiers.${i}.dep`)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Step 3: Gaming Trader */}
              {currentStep === 2 && (
                <div className="space-y-8 flex-1">
                  <div>
                    <Badge
                      variant="outline"
                      className="mb-4 text-ink border-accent"
                    >
                      {t(`uc.learn.steps.${currentStep}.badge`)}
                    </Badge>
                    <h2 className="text-2xl font-bold text-ink mb-4">
                      {t(`uc.learn.steps.${currentStep}.title`)}
                    </h2>
                    <p className="text-muted">
                      {t(`uc.learn.steps.${currentStep}.description`)
                        .split("**")
                        .map((part, i) =>
                          i % 2 === 1 ? (
                            <strong key={i} className="text-ink">
                              {part}
                            </strong>
                          ) : (
                            part
                          ),
                        )}
                    </p>
                  </div>

                  <div className="grid md:grid-cols-2 gap-8">
                    <div className="space-y-6">
                      <div className="bg-accent-muted p-5">
                        <h4 className="text-sm font-bold text-ink mb-4 flex items-center gap-2">
                          <RefreshCw className="w-4 h-4" />
                          {t("uc.learn.gaming.mechanismTitle")}
                        </h4>
                        <div className="space-y-4 relative">
                          {[0, 1, 2].map((i) => (
                            <div key={i} className="flex items-center gap-3">
                              <div
                                className={cn(
                                  "w-8 h-8 flex items-center justify-center text-xs font-bold font-mono",
                                  i === 2
                                    ? "bg-accent text-canvas"
                                    : "bg-raised text-ink",
                                )}
                              >
                                {i + 1}
                              </div>
                              <p
                                className={cn(
                                  "text-xs",
                                  i === 2 ? "text-ink font-medium" : "text-ink",
                                )}
                              >
                                {t(`uc.learn.gaming.mechanismSteps.${i}`)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="bg-raised p-5 border border-rule">
                        <h4 className="text-sm font-bold text-ink mb-4">
                          {t("uc.learn.gaming.pricingTitle")}
                        </h4>
                        <LMSRCurve />
                      </div>
                    </div>

                    <div className="space-y-6">
                      <div className="p-5 border border-rule bg-raised">
                        <h4 className="text-sm font-bold text-ink mb-4">
                          {t("uc.learn.gaming.practiceTitle")}
                        </h4>
                        <SandboxTradingPanel onTrade={handleSandboxTrade} />
                      </div>

                      <div className="flex items-start gap-3 p-4 bg-raised border border-rule">
                        <Lock className="w-5 h-5 text-muted shrink-0 mt-0.5" />
                        <div>
                          <p className="font-mono text-xs text-muted mb-1 uppercase tracking-[0.12em]">
                            {t("uc.learn.gaming.sellLock.title")}
                          </p>
                          <p className="text-xs text-muted leading-relaxed">
                            {t("uc.learn.gaming.sellLock.description")}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 4: Pro Traders */}
              {currentStep === 3 && (
                <div className="space-y-8 flex-1">
                  <div>
                    <Badge
                      variant="outline"
                      className="mb-4 text-accent border-accent/30"
                    >
                      {t(`uc.learn.steps.${currentStep}.badge`)}
                    </Badge>
                    <h2 className="text-2xl font-bold text-ink mb-4">
                      {t(`uc.learn.steps.${currentStep}.title`)}
                    </h2>
                    <p className="text-muted">
                      {t(`uc.learn.steps.${currentStep}.description`)
                        .split("**")
                        .map((part, i) =>
                          i % 2 === 1 ? (
                            <strong key={i} className="text-ink">
                              {part}
                            </strong>
                          ) : (
                            part
                          ),
                        )}
                    </p>
                  </div>

                  <div className="bg-raised p-6 border border-rule">
                    <h4 className="text-sm font-bold text-ink mb-6 text-center uppercase tracking-widest">
                      {t("uc.learn.pro.architectureTitle")}
                    </h4>
                    <div className="grid md:grid-cols-2 gap-0 border border-rule overflow-hidden">
                      <div className="p-6 border-b md:border-b-0 md:border-r border-rule">
                        <div className="flex items-center gap-2 mb-4">
                          <div className="w-8 h-8 bg-raised flex items-center justify-center">
                            <TrendingUp className="w-4 h-4 text-muted" />
                          </div>
                          <h5 className="font-bold text-ink">
                            {t("uc.learn.pro.amm.title")}
                          </h5>
                        </div>
                        <ul className="space-y-3 text-xs text-muted">
                          {[0, 1, 2, 3].map((i) => {
                            const val = t(`uc.learn.pro.amm.items.${i}.1`);
                            return (
                              <li key={i} className="flex justify-between">
                                <span>
                                  {t(`uc.learn.pro.amm.items.${i}.0`)}
                                </span>
                                <span
                                  className={cn(
                                    "text-ink",
                                    val.includes("24h") && "text-muted",
                                  )}
                                >
                                  {val}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                      <div className="p-6 bg-accent-muted">
                        <div className="flex items-center gap-2 mb-4">
                          <div className="w-8 h-8 bg-accent-muted flex items-center justify-center">
                            <BarChart3 className="w-4 h-4 text-accent" />
                          </div>
                          <h5 className="font-bold text-ink text-accent">
                            {t("uc.learn.pro.soothBook.title")}
                          </h5>
                        </div>
                        <ul className="space-y-3 text-xs text-muted">
                          {[0, 1, 2, 3].map((i) => {
                            const val = t(
                              `uc.learn.pro.soothBook.items.${i}.1`,
                            );
                            return (
                              <li key={i} className="flex justify-between">
                                <span>
                                  {t(`uc.learn.pro.soothBook.items.${i}.0`)}
                                </span>
                                <span
                                  className={cn(
                                    "text-ink",
                                    (val.includes("Instant") ||
                                      val.includes("ERC20")) &&
                                      "font-bold text-ink",
                                  )}
                                >
                                  {val}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-6">
                    <div className="p-5 border border-rule bg-raised">
                      <h4 className="text-sm font-bold text-ink mb-4 flex items-center gap-2">
                        <ArrowLeftRight className="w-4 h-4 text-accent" />
                        {t("uc.learn.pro.arb.title")}
                      </h4>
                      <p className="text-xs text-muted leading-relaxed mb-4">
                        {t("uc.learn.pro.arb.description")}
                      </p>
                      <div className="p-4 bg-raised font-mono text-xs text-ink">
                        AMM Price: 62% <br />
                        SooBook Ask: 58% <br />
                        <span className="text-ink">→ Arb: +4¢ per share</span>
                      </div>
                    </div>
                    <div className="p-5 border border-rule bg-raised">
                      <h4 className="text-sm font-bold text-ink mb-4 flex items-center gap-2">
                        <Swords className="w-4 h-4 text-muted" />
                        {t("uc.learn.pro.pvp.title")}
                      </h4>
                      <p className="text-xs text-muted leading-relaxed">
                        {t("uc.learn.pro.pvp.description")}
                      </p>
                    </div>
                  </div>

                  <div className="p-5 border border-rule bg-raised">
                    <h4 className="text-sm font-bold text-accent mb-4 uppercase tracking-widest">
                      {t("uc.learn.pro.evolutionTitle")}
                    </h4>
                    <div className="flex items-center justify-between text-xs font-bold text-muted">
                      {[0, 1, 2].map((i) => (
                        <React.Fragment key={i}>
                          <span className={i === 2 ? "text-accent" : ""}>
                            {t(`uc.learn.pro.evolutionStages.${i}`)}
                          </span>
                          {i < 2 && (
                            <ChevronRight className="w-4 h-4 text-faint" />
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                    <div className="w-full h-1 bg-rule mt-3">
                      <div className="h-1 bg-accent" style={{ width: "66%" }} />
                    </div>
                    <div className="grid grid-cols-3 mt-3 text-xs text-muted text-center">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className={i === 2 ? "text-ink" : ""}>
                          {t(`uc.learn.pro.evolutionStates.${i}`)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Step 5: Start Journey */}
              {currentStep === 4 && (
                <div className="space-y-12 flex-1 flex flex-col items-center justify-center text-center">
                  <div className="max-w-xl mx-auto space-y-4">
                    <GraduationCap className="w-10 h-10 text-accent mx-auto mb-6" />
                    <h2 className="text-3xl font-bold text-ink">
                      {t("uc.learn.ready.title")}
                    </h2>
                    <p className="text-muted text-lg">
                      {t("uc.learn.ready.subtitle")}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 w-full max-w-4xl auto-rows-fr">
                    {[0, 1, 2, 3].map((i) => (
                      <ActorCard
                        key={i}
                        icon={[Palette, Gamepad2, ArrowLeftRight, Swords][i]}
                        title={t(`uc.learn.ready.actors.${i}.title`)}
                        motivation={t(`uc.learn.ready.actors.${i}.motivation`)}
                        colorClass={
                          [
                            "text-accent",
                            "text-accent",
                            "text-accent",
                            "text-accent",
                          ][i]
                        }
                        onClick={() =>
                          (window.location.href = [
                            "/create",
                            "/amm",
                            "/orderbook",
                            "/orderbook",
                          ][i])
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Navigation */}
              <div className="mt-auto pt-8 flex justify-between">
                <Button
                  variant="secondary"
                  size="lg"
                  className="px-8"
                  onClick={() =>
                    setCurrentStep((prev) => Math.max(0, prev - 1))
                  }
                  disabled={currentStep === 0}
                >
                  <ChevronLeft className="w-4 h-4 mr-2" />
                  Back
                </Button>

                {currentStep < STEP_IDS.length - 1 ? (
                  <Button
                    variant="primary"
                    size="lg"
                    className="px-8"
                    onClick={() => setCurrentStep((prev) => prev + 1)}
                  >
                    Next Step
                    <ChevronRight className="w-4 h-4 ml-2" />
                  </Button>
                ) : (
                  <Link to="/amm">
                    <Button variant="primary" size="lg" className="px-8">
                      <Rocket className="w-4 h-4 mr-2" />
                      Launch App
                    </Button>
                  </Link>
                )}
              </div>
            </Card>
          </div>

          {/* Right Sidebar - Whitepaper Snip/Notes */}
          <div className="lg:col-span-4 space-y-4">
            <Card className="p-6 bg-raised border-rule">
              <h3 className="font-mono text-xs text-accent uppercase tracking-[0.12em] mb-4 flex items-center gap-2">
                <Info className="w-3 h-3" />
                {t("uc.learn.context.title")}
              </h3>

              <div className="space-y-4">
                <div className="p-4 bg-raised border border-rule">
                  <p className="text-xs text-muted italic leading-relaxed">
                    "{t(`uc.learn.context.quotes.${stepId}`)}"
                  </p>
                </div>

                <div className="space-y-3">
                  <h4 className="font-mono text-xs text-muted uppercase tracking-[0.12em]">
                    {t("uc.learn.context.mechanismsTitle")}
                  </h4>
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="w-1.5 h-1.5 bg-accent mt-1" />
                      <div>
                        <span className="text-xs font-bold text-ink block">
                          {t(`uc.learn.context.mechanisms.${i}.label`)}
                        </span>
                        <span className="text-xs text-muted">
                          {t(`uc.learn.context.mechanisms.${i}.desc`)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="p-6 bg-accent-muted border-accent/20">
              <h3 className="text-xs font-bold text-ink mb-3">Pro Tip</h3>
              <p className="text-xs text-accent leading-relaxed">
                {t("uc.learn.proTip")}
              </p>
            </Card>
          </div>
        </div>

        {/* Footer info */}
        <p className="text-center text-xs text-muted mt-8 uppercase tracking-[0.2em]">
          Soo Protocol Tutorial • Step {currentStep + 1} of {STEP_IDS.length}
        </p>
      </div>
    </div>
  );
};
