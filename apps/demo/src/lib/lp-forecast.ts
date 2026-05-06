const MIN_PROBABILITY = 0.01;
const MAX_PROBABILITY = 0.99;
const WAD_NUMBER = 1e18;

export type CashflowType = "deposit" | "withdrawal";
export type LpScenarioId = "downside" | "expected" | "upside";
export type LpActivitySource = "amm" | "orderbook";

export interface LpCashflowEvent {
  day: number;
  type: CashflowType;
  amount: number;
  label?: string;
}

export interface LpForecastAssumptions {
  marketName: string;
  initialLiquidity: number;
  initialProbability: number;
  expectedOutcomeProbability: number;
  durationDays: number;
  dailyVolume: number;
  volatility: number;
  preGradFeeRate: number;
  postGradFeeRate: number;
  bBaseShare: number;
  lpYieldShare: number;
  protocolShare: number;
  adjudicatorShare: number;
  creatorLpShare: number;
  graduationThresholdMultiplier: number;
  cashflowEvents: LpCashflowEvent[];
}

export interface LpScenarioConfig {
  id: LpScenarioId;
  label: string;
  description: string;
  terminalProbability: number;
  volumeMultiplier: number;
  volatilityMultiplier: number;
}

export interface LpForecastPoint {
  day: number;
  timestamp?: number;
  source: "modeled" | LpActivitySource;
  price: number;
  bCurrent: number;
  lpShare: number;
  cumulativeVolume: number;
  cumulativeFees: number;
  feeIncome: number;
  poolCapital: number;
  netContributedCapital: number;
  withdrawnCapital: number;
  netInventoryShares: number;
  inventoryExposure: number;
  capitalAtRisk: number;
  equity: number;
  drawdown: number;
  cashflowAmount: number;
  cashflowType?: CashflowType;
  note?: string;
}

export interface LpMetrics {
  totalVolume: number;
  totalFees: number;
  feeIncome: number;
  maxInventoryExposure: number;
  capitalAtRisk: number;
  maxDrawdown: number;
  endingEquity: number;
  finalPnl: number;
  roi: number;
  netContributedCapital: number;
  withdrawnCapital: number;
  graduationDay: number | null;
  breakEvenDailyVolume: number;
}

export interface LpScenarioResult {
  id: LpScenarioId;
  label: string;
  description: string;
  points: LpForecastPoint[];
  metrics: LpMetrics;
}

export interface LpForecastResult {
  assumptions: LpForecastAssumptions;
  formulas: string[];
  scenarios: LpScenarioResult[];
}

export interface IndexerAmmTrade {
  timestamp: string;
  cost: string;
  qYesAfter: string;
  qNoAfter: string;
  bAfter: string;
  yesProbability: number;
}

export interface IndexerFill {
  timestamp: string;
  amount: string;
  yesTick: number;
}

export interface LpObservedActivity {
  source: LpActivitySource;
  timestamp: number;
  volume: number;
  price: number;
  qYesAfter?: number;
  qNoAfter?: number;
  bAfter?: number;
}

export interface LpBacktestResult {
  actual: Omit<LpScenarioResult, "id" | "label" | "description">;
  forecastScenario: LpScenarioResult;
  comparison: {
    totalVolumeDelta: number;
    totalFeesDelta: number;
    feeIncomeDelta: number;
    maxExposureDelta: number;
    finalPnlDelta: number;
  };
}

interface AccountingState {
  poolCapital: number;
  bCurrent: number;
  creatorLpTokens: number;
  totalLpSupply: number;
  cumulativeVolume: number;
  preGradFees: number;
  postGradFees: number;
  lpYieldPool: number;
  netContributedCapital: number;
  grossContributedCapital: number;
  withdrawnCapital: number;
  graduationDay: number | null;
  highWaterEquity: number;
}

export const LP_FORECAST_FORMULAS = [
  "creatorDeposit = b * -ln(min(p, 1 - p))",
  "preGraduationFees = volume * preGradFeeRate until cumulative fees reach creatorDeposit",
  "postGraduationFees = volume * postGradFeeRate after graduation",
  "bGrowth = preGraduationFees + postGraduationFees * bBaseShare",
  "lpFeeIncome = postGraduationFees * lpYieldShare * creatorLpShare",
  "inventoryExposure = abs(bCurrent * log(pYes / (1 - pYes))) * creatorLpShare",
  "finalPnl = endingEquity + withdrawals - contributedCapital",
];

export function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(MAX_PROBABILITY, Math.max(MIN_PROBABILITY, value));
}

export function calculateCreatorDeposit(
  initialLiquidity: number,
  initialProbability: number,
): number {
  const p = clampProbability(initialProbability);
  return Math.max(0, initialLiquidity) * -Math.log(Math.min(p, 1 - p));
}

export function normalizeIndexerAmmTrades(
  trades: IndexerAmmTrade[],
): LpObservedActivity[] {
  return trades
    .map((trade) => {
      const cost = Math.abs(wadStringToNumber(trade.cost));
      const timestamp = Number(trade.timestamp);
      return {
        source: "amm" as const,
        timestamp,
        volume: cost,
        price: clampProbability(Number(trade.yesProbability)),
        qYesAfter: wadStringToNumber(trade.qYesAfter),
        qNoAfter: wadStringToNumber(trade.qNoAfter),
        bAfter: wadStringToNumber(trade.bAfter),
      };
    })
    .filter((activity) => isValidActivity(activity));
}

export function normalizeIndexerFills(fills: IndexerFill[]): LpObservedActivity[] {
  return fills
    .map((fill) => {
      const amount = wadStringToNumber(fill.amount);
      const price = clampProbability(Number(fill.yesTick) / 1000);
      return {
        source: "orderbook" as const,
        timestamp: Number(fill.timestamp),
        volume: amount * price,
        price,
      };
    })
    .filter((activity) => isValidActivity(activity));
}

export function runLpForecast(
  assumptions: LpForecastAssumptions,
): LpForecastResult {
  const normalized = normalizeAssumptions(assumptions);
  return {
    assumptions: normalized,
    formulas: LP_FORECAST_FORMULAS,
    scenarios: buildScenarios(normalized).map((scenario) =>
      simulateScenario(normalized, scenario),
    ),
  };
}

export function runLpBacktest(
  activities: LpObservedActivity[],
  assumptions: LpForecastAssumptions,
): LpBacktestResult {
  const normalized = normalizeAssumptions(assumptions);
  const forecastScenario = runLpForecast(normalized).scenarios.find(
    (scenario) => scenario.id === "expected",
  );
  if (!forecastScenario) {
    throw new Error("Expected forecast scenario missing");
  }

  const actual = replayObservedActivities(activities, normalized);
  return {
    actual,
    forecastScenario,
    comparison: {
      totalVolumeDelta:
        actual.metrics.totalVolume - forecastScenario.metrics.totalVolume,
      totalFeesDelta: actual.metrics.totalFees - forecastScenario.metrics.totalFees,
      feeIncomeDelta: actual.metrics.feeIncome - forecastScenario.metrics.feeIncome,
      maxExposureDelta:
        actual.metrics.maxInventoryExposure -
        forecastScenario.metrics.maxInventoryExposure,
      finalPnlDelta: actual.metrics.finalPnl - forecastScenario.metrics.finalPnl,
    },
  };
}

function normalizeAssumptions(
  assumptions: LpForecastAssumptions,
): LpForecastAssumptions {
  const feeShareSum =
    assumptions.bBaseShare +
    assumptions.lpYieldShare +
    assumptions.protocolShare +
    assumptions.adjudicatorShare;
  const shareScale = feeShareSum > 0 ? feeShareSum : 1;

  return {
    ...assumptions,
    marketName: assumptions.marketName.trim() || "Selected Sooth market",
    initialLiquidity: Math.max(1, assumptions.initialLiquidity),
    initialProbability: clampProbability(assumptions.initialProbability),
    expectedOutcomeProbability: clampProbability(
      assumptions.expectedOutcomeProbability,
    ),
    durationDays: Math.max(1, Math.round(assumptions.durationDays)),
    dailyVolume: Math.max(0, assumptions.dailyVolume),
    volatility: Math.max(0, Math.min(0.75, assumptions.volatility)),
    preGradFeeRate: Math.max(0, assumptions.preGradFeeRate),
    postGradFeeRate: Math.max(0, assumptions.postGradFeeRate),
    bBaseShare: Math.max(0, assumptions.bBaseShare / shareScale),
    lpYieldShare: Math.max(0, assumptions.lpYieldShare / shareScale),
    protocolShare: Math.max(0, assumptions.protocolShare / shareScale),
    adjudicatorShare: Math.max(0, assumptions.adjudicatorShare / shareScale),
    creatorLpShare: Math.max(0.01, Math.min(1, assumptions.creatorLpShare)),
    graduationThresholdMultiplier: Math.max(
      0.1,
      assumptions.graduationThresholdMultiplier,
    ),
    cashflowEvents: assumptions.cashflowEvents
      .filter((event) => Number.isFinite(event.day) && event.amount > 0)
      .map((event) => ({
        ...event,
        day: Math.max(0, Math.round(event.day)),
        amount: Math.max(0, event.amount),
      }))
      .sort((a, b) => a.day - b.day),
  };
}

function buildScenarios(
  assumptions: LpForecastAssumptions,
): LpScenarioConfig[] {
  const expected = assumptions.expectedOutcomeProbability;
  const adverse =
    expected >= 0.5
      ? Math.max(MIN_PROBABILITY, 1 - expected)
      : Math.min(MAX_PROBABILITY, 1 - expected);
  const upside =
    expected >= 0.5
      ? Math.min(MAX_PROBABILITY, expected + 0.2)
      : Math.max(MIN_PROBABILITY, expected - 0.2);

  return [
    {
      id: "downside",
      label: "Downside",
      description: "Lower volume and price action moving against the thesis.",
      terminalProbability: adverse,
      volumeMultiplier: 0.55,
      volatilityMultiplier: 1.25,
    },
    {
      id: "expected",
      label: "Expected",
      description: "The selected assumptions with the creator's base thesis.",
      terminalProbability: expected,
      volumeMultiplier: 1,
      volatilityMultiplier: 1,
    },
    {
      id: "upside",
      label: "Upside",
      description: "Higher participation and price action supporting the thesis.",
      terminalProbability: upside,
      volumeMultiplier: 1.45,
      volatilityMultiplier: 0.8,
    },
  ];
}

function simulateScenario(
  assumptions: LpForecastAssumptions,
  scenario: LpScenarioConfig,
): LpScenarioResult {
  const creatorDeposit = calculateCreatorDeposit(
    assumptions.initialLiquidity,
    assumptions.initialProbability,
  );
  const state = createInitialState(assumptions, creatorDeposit);
  const points: LpForecastPoint[] = [];
  const volumePerDay = assumptions.dailyVolume * scenario.volumeMultiplier;

  for (let day = 0; day <= assumptions.durationDays; day += 1) {
    const price = modeledProbability(assumptions, scenario, day);
    let cashflowAmount = 0;
    let cashflowType: CashflowType | undefined;
    let note: string | undefined;

    if (day > 0 && volumePerDay > 0) {
      allocateTradingVolume(state, assumptions, volumePerDay, day);
    }

    for (const event of assumptions.cashflowEvents.filter(
      (candidate) => candidate.day === day,
    )) {
      applyCashflow(state, event);
      cashflowAmount += event.type === "deposit" ? event.amount : -event.amount;
      cashflowType = event.type;
      note = event.label;
    }

    points.push(
      snapshotPoint({
        state,
        assumptions,
        day,
        price,
        source: "modeled",
        cashflowAmount,
        cashflowType,
        note,
      }),
    );
  }

  return {
    id: scenario.id,
    label: scenario.label,
    description: scenario.description,
    points,
    metrics: calculateMetrics(points, state, assumptions),
  };
}

function replayObservedActivities(
  activities: LpObservedActivity[],
  assumptions: LpForecastAssumptions,
): Omit<LpScenarioResult, "id" | "label" | "description"> {
  const creatorDeposit = calculateCreatorDeposit(
    assumptions.initialLiquidity,
    assumptions.initialProbability,
  );
  const state = createInitialState(assumptions, creatorDeposit);
  const valid = activities
    .filter((activity) => isValidActivity(activity))
    .sort((a, b) => a.timestamp - b.timestamp);
  const firstTimestamp = valid[0]?.timestamp ?? 0;
  const points: LpForecastPoint[] = [];

  for (const activity of valid) {
    const elapsedDays =
      firstTimestamp > 0
        ? Math.max(0, (activity.timestamp - firstTimestamp) / 86_400)
        : points.length;

    allocateTradingVolume(
      state,
      assumptions,
      activity.volume,
      Math.ceil(elapsedDays),
    );
    if (activity.bAfter !== undefined) {
      state.bCurrent = Math.max(1, activity.bAfter);
    }

    const price = clampProbability(activity.price);
    const point = snapshotPoint({
      state,
      assumptions,
      day: elapsedDays,
      timestamp: activity.timestamp,
      price,
      source: activity.source,
      cashflowAmount: 0,
    });

    if (
      activity.qYesAfter !== undefined &&
      activity.qNoAfter !== undefined &&
      Number.isFinite(activity.qYesAfter) &&
      Number.isFinite(activity.qNoAfter)
    ) {
      point.netInventoryShares = activity.qYesAfter - activity.qNoAfter;
      point.inventoryExposure =
        Math.abs(point.netInventoryShares) * point.lpShare;
      point.capitalAtRisk = Math.max(
        point.capitalAtRisk,
        point.inventoryExposure,
      );
    }
    points.push(point);
  }

  return {
    points,
    metrics: calculateMetrics(points, state, assumptions),
  };
}

function createInitialState(
  assumptions: LpForecastAssumptions,
  creatorDeposit: number,
): AccountingState {
  const totalLpSupply =
    assumptions.creatorLpShare > 0
      ? creatorDeposit / assumptions.creatorLpShare
      : creatorDeposit;
  return {
    poolCapital: creatorDeposit,
    bCurrent: assumptions.initialLiquidity,
    creatorLpTokens: creatorDeposit,
    totalLpSupply: Math.max(creatorDeposit, totalLpSupply),
    cumulativeVolume: 0,
    preGradFees: 0,
    postGradFees: 0,
    lpYieldPool: 0,
    netContributedCapital: creatorDeposit,
    grossContributedCapital: creatorDeposit,
    withdrawnCapital: 0,
    graduationDay: null,
    highWaterEquity: 0,
  };
}

function allocateTradingVolume(
  state: AccountingState,
  assumptions: LpForecastAssumptions,
  volume: number,
  day: number,
) {
  if (volume <= 0) return;
  state.cumulativeVolume += volume;

  const creatorDeposit = calculateCreatorDeposit(
    assumptions.initialLiquidity,
    assumptions.initialProbability,
  );
  const graduationThreshold =
    creatorDeposit * assumptions.graduationThresholdMultiplier;
  const remainingPreGradFees = Math.max(
    0,
    graduationThreshold - state.preGradFees,
  );

  if (remainingPreGradFees > 0 && assumptions.preGradFeeRate > 0) {
    const volumeToGraduate = remainingPreGradFees / assumptions.preGradFeeRate;
    const preGradVolume = Math.min(volume, volumeToGraduate);
    const preGradFees = preGradVolume * assumptions.preGradFeeRate;
    applyPreGradFees(state, preGradFees);

    const remainingVolume = volume - preGradVolume;
    if (
      remainingVolume > 0 &&
      assumptions.postGradFeeRate > 0 &&
      state.graduationDay === null
    ) {
      state.graduationDay = day;
    }
    if (remainingVolume > 0) {
      applyPostGradFees(
        state,
        remainingVolume * assumptions.postGradFeeRate,
        assumptions,
      );
    }
    return;
  }

  if (state.graduationDay === null) {
    state.graduationDay = day;
  }
  applyPostGradFees(state, volume * assumptions.postGradFeeRate, assumptions);
}

function applyPreGradFees(state: AccountingState, fees: number) {
  if (fees <= 0) return;
  state.preGradFees += fees;
  state.poolCapital += fees;
  state.bCurrent += fees;
  state.totalLpSupply += fees;
}

function applyPostGradFees(
  state: AccountingState,
  fees: number,
  assumptions: LpForecastAssumptions,
) {
  if (fees <= 0) return;
  state.postGradFees += fees;
  const bGrowth = fees * assumptions.bBaseShare;
  state.poolCapital += bGrowth;
  state.bCurrent += bGrowth;
  state.lpYieldPool += fees * assumptions.lpYieldShare;
}

function applyCashflow(state: AccountingState, event: LpCashflowEvent) {
  const tokenPrice =
    state.totalLpSupply > 0 ? state.poolCapital / state.totalLpSupply : 1;

  if (event.type === "deposit") {
    const minted = event.amount / Math.max(0.01, tokenPrice);
    state.poolCapital += event.amount;
    state.creatorLpTokens += minted;
    state.totalLpSupply += minted;
    state.bCurrent += event.amount;
    state.grossContributedCapital += event.amount;
    state.netContributedCapital += event.amount;
    return;
  }

  const redeemable = Math.min(event.amount, state.poolCapital * lpShare(state));
  const burned = redeemable / Math.max(0.01, tokenPrice);
  state.poolCapital = Math.max(0, state.poolCapital - redeemable);
  state.creatorLpTokens = Math.max(0, state.creatorLpTokens - burned);
  state.totalLpSupply = Math.max(0.000001, state.totalLpSupply - burned);
  state.bCurrent = Math.max(1, state.bCurrent - redeemable);
  state.withdrawnCapital += redeemable;
  state.netContributedCapital -= redeemable;
}

function snapshotPoint(args: {
  state: AccountingState;
  assumptions: LpForecastAssumptions;
  day: number;
  timestamp?: number;
  price: number;
  source: "modeled" | LpActivitySource;
  cashflowAmount: number;
  cashflowType?: CashflowType;
  note?: string;
}): LpForecastPoint {
  const share = lpShare(args.state);
  const price = clampProbability(args.price);
  const netInventoryShares = inventoryShares(args.state.bCurrent, price);
  const liabilityYes = Math.max(0, netInventoryShares);
  const liabilityNo = Math.max(0, -netInventoryShares);
  const expectedLiability =
    (liabilityYes * price + liabilityNo * (1 - price)) * share;
  const worstCaseLiability = Math.max(liabilityYes, liabilityNo) * share;
  const grossCreatorEquity =
    args.state.poolCapital * share + args.state.lpYieldPool * share;
  const equity = Math.max(0, grossCreatorEquity - expectedLiability);
  args.state.highWaterEquity = Math.max(args.state.highWaterEquity, equity);
  const drawdown = Math.max(0, args.state.highWaterEquity - equity);

  return {
    day: args.day,
    timestamp: args.timestamp,
    source: args.source,
    price,
    bCurrent: args.state.bCurrent,
    lpShare: share,
    cumulativeVolume: args.state.cumulativeVolume,
    cumulativeFees: args.state.preGradFees + args.state.postGradFees,
    feeIncome: args.state.lpYieldPool * share,
    poolCapital: args.state.poolCapital,
    netContributedCapital: args.state.netContributedCapital,
    withdrawnCapital: args.state.withdrawnCapital,
    netInventoryShares,
    inventoryExposure: Math.abs(netInventoryShares) * share,
    capitalAtRisk: Math.max(0, grossCreatorEquity - (grossCreatorEquity - worstCaseLiability)),
    equity,
    drawdown,
    cashflowAmount: args.cashflowAmount,
    cashflowType: args.cashflowType,
    note: args.note,
  };
}

function calculateMetrics(
  points: LpForecastPoint[],
  state: AccountingState,
  assumptions: LpForecastAssumptions,
): LpMetrics {
  const last = points[points.length - 1];
  const totalFees = state.preGradFees + state.postGradFees;
  const finalPnl =
    (last?.equity ?? 0) +
    state.withdrawnCapital -
    state.grossContributedCapital;
  const roi =
    state.grossContributedCapital > 0
      ? finalPnl / state.grossContributedCapital
      : 0;
  const creatorDeposit = calculateCreatorDeposit(
    assumptions.initialLiquidity,
    assumptions.initialProbability,
  );
  const breakEvenVolume =
    assumptions.preGradFeeRate > 0
      ? creatorDeposit / assumptions.preGradFeeRate / assumptions.durationDays
      : 0;

  return {
    totalVolume: state.cumulativeVolume,
    totalFees,
    feeIncome: state.lpYieldPool * lpShare(state),
    maxInventoryExposure: maxOf(points, "inventoryExposure"),
    capitalAtRisk: maxOf(points, "capitalAtRisk"),
    maxDrawdown: maxOf(points, "drawdown"),
    endingEquity: last?.equity ?? 0,
    finalPnl,
    roi,
    netContributedCapital: state.netContributedCapital,
    withdrawnCapital: state.withdrawnCapital,
    graduationDay: state.graduationDay,
    breakEvenDailyVolume: breakEvenVolume,
  };
}

function modeledProbability(
  assumptions: LpForecastAssumptions,
  scenario: LpScenarioConfig,
  day: number,
): number {
  const duration = Math.max(1, assumptions.durationDays);
  const progress = Math.min(1, Math.max(0, day / duration));
  const trend =
    assumptions.initialProbability +
    (scenario.terminalProbability - assumptions.initialProbability) * progress;
  const wave =
    Math.sin(progress * Math.PI * 2) *
      assumptions.volatility *
      scenario.volatilityMultiplier *
      0.5 +
    Math.sin(progress * Math.PI * 5 + 0.4) *
      assumptions.volatility *
      scenario.volatilityMultiplier *
      0.18;
  return clampProbability(trend + wave);
}

function inventoryShares(bCurrent: number, price: number): number {
  const p = clampProbability(price);
  return bCurrent * Math.log(p / (1 - p));
}

function lpShare(state: AccountingState): number {
  if (state.totalLpSupply <= 0) return 0;
  return Math.max(0, Math.min(1, state.creatorLpTokens / state.totalLpSupply));
}

function wadStringToNumber(value: string): number {
  try {
    return Number(BigInt(value)) / WAD_NUMBER;
  } catch {
    return Number(value) / WAD_NUMBER;
  }
}

function isValidActivity(activity: LpObservedActivity): boolean {
  return (
    Number.isFinite(activity.timestamp) &&
    activity.timestamp > 0 &&
    Number.isFinite(activity.volume) &&
    activity.volume >= 0 &&
    Number.isFinite(activity.price)
  );
}

function maxOf(points: LpForecastPoint[], key: keyof LpForecastPoint): number {
  return points.reduce((max, point) => {
    const value = point[key];
    return typeof value === "number" ? Math.max(max, value) : max;
  }, 0);
}
