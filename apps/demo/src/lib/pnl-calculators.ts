/**
 * P&L Calculation Utilities for Launchpad Simulator
 * 
 * Simplified formulas for instant UI updates.
 * All calculations use rounded approximations suitable for educational display.
 */

// ═══════════════════════════════════════════════════════════════════════════
//                              CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

export const LN2 = 0.693147;
export const PRE_GRAD_FEE_RATE = 0.05; // 5%
export const POST_GRAD_FEE_RATE = 0.01; // 1%
export const BBASE_SHARE = 0.50;        // 50% post-grad (bBaseShareBps = 5000)
export const LP_YIELD_SHARE = 0.30;     // 30% post-grad (lpYieldShareBps = 3000)
export const ADJUDICATOR_SHARE = 0.10;  // 10% post-grad (adjudicatorShareBps = 1000)
export const PROTOCOL_SHARE = 0.10;     // 10% post-grad (protocolShareBps = 1000)

// ═══════════════════════════════════════════════════════════════════════════
//                              TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CreatorResult {
    lpDeposit: number;
    lpTokens: number;
    totalLpSupply: number;
    ownershipPercent: number;
    graduationThreshold: number;
    isGraduated: boolean;
    preGradFees: number;
    postGradFees: number;
    totalFees: number;
    flywheelGrowth: number;
    feeYield: number;
    settlementOutcome: number;
    lpRedemption: number;
    netPnL: number;
    roi: number;
    breakEvenVolume: number;
}

export interface GamingTraderResult {
    tradeSize: number;
    entryPrice: number;
    sharesReceived: number;
    positionValue: number;
    feePaid: number;
    tradePnL: number;
    lpDeposit: number;
    totalLpSupply: number;
    ownershipPercent: number;
    flywheelGrowth: number;
    feeYield: number;
    settlementOutcome: number;
    lpRedemption: number;
    lpPnL: number;
    netPnL: number;
    roi: number;
}

export interface ArbitrageurResult {
    tradeSize: number;
    spreadPercent: number;
    grossProfit: number;
    gasCost: number;
    ammFee: number;
    totalCosts: number;
    netProfit: number;
    returnPercent: number;
    isProfitable: boolean;
    minViableSpread: number;
}

export interface PvPTraderResult {
    positionSize: number;
    entryPrice: number;
    sharesReceived: number;
    profitIfWin: number;
    lossIfWrong: number;
    estimatedWinProb: number;
    expectedValue: number;
    actualPnL: number;
    returnPercent: number;
}

// ═══════════════════════════════════════════════════════════════════════════
//                         CREATOR CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

export function calculateCreatorPnL(
    liquidityTier: number,
    totalVolume: number,
    positionImbalance: number = 0,
    initialProbability: number = 50
): CreatorResult {
    const probFraction = Math.max(0.01, Math.min(0.99, initialProbability / 100));
    const depthK = -Math.log(Math.min(probFraction, 1 - probFraction));
    const lpDeposit = Math.round(liquidityTier * depthK);
    const lpTokens = lpDeposit;
    const totalLpSupply = lpDeposit * 2;
    const ownershipPercent = 0.5;
    const graduationThreshold = lpDeposit;
    
    const preGradVolume = Math.min(totalVolume, graduationThreshold / PRE_GRAD_FEE_RATE);
    const preGradFees = Math.round(preGradVolume * PRE_GRAD_FEE_RATE);
    const isGraduated = preGradFees >= graduationThreshold;
    
    const postGradVolume = isGraduated ? Math.max(0, totalVolume - preGradVolume) : 0;
    const postGradFees = Math.round(postGradVolume * POST_GRAD_FEE_RATE);
    const totalFees = preGradFees + postGradFees;
    
    const feeYield = Math.round(postGradFees * LP_YIELD_SHARE * ownershipPercent);
    const flywheelGrowth = Math.round(postGradFees * BBASE_SHARE * ownershipPercent);
    
    const atRisk = lpDeposit + flywheelGrowth;
    const settlementOutcome = Math.round(atRisk * positionImbalance * 2);
    
    const lpRedemption = Math.max(0, lpDeposit + flywheelGrowth + settlementOutcome + feeYield);
    const netPnL = lpRedemption - lpDeposit;
    const roi = lpDeposit > 0 ? (netPnL / lpDeposit) * 100 : 0;
    const breakEvenVolume = Math.round(lpDeposit / PRE_GRAD_FEE_RATE);
    
    return {
        lpDeposit,
        lpTokens,
        totalLpSupply,
        ownershipPercent,
        graduationThreshold,
        isGraduated,
        preGradFees,
        postGradFees,
        totalFees,
        flywheelGrowth,
        feeYield,
        settlementOutcome,
        lpRedemption,
        netPnL,
        roi: Math.round(roi),
        breakEvenVolume
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//                      GAMING TRADER CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

export const GRADUATION_THRESHOLD = 2000;

export function calculateGamingTraderPnL(
    tradeSize: number,
    entryPrice: number,
    isPreGraduation: boolean,
    isPredictionCorrect: boolean,
    volumeAfterEntry: number,
    positionImbalance: number = 0
): GamingTraderResult {
    const feeRate = isPreGraduation ? PRE_GRAD_FEE_RATE : POST_GRAD_FEE_RATE;
    const feePaid = Math.round(tradeSize * feeRate);
    const positionValue = tradeSize - feePaid;
    const sharesReceived = entryPrice > 0 ? Math.round(positionValue / entryPrice) : 0;
    
    const tradePnL = isPredictionCorrect ? (sharesReceived - positionValue) : -positionValue;
    
    const lpDeposit = isPreGraduation ? feePaid : 0;
    const totalLpSupply = Math.round(GRADUATION_THRESHOLD / LN2);
    const ownershipPercent = totalLpSupply > 0 ? lpDeposit / totalLpSupply : 0;
    
    const postGradFees = Math.round(volumeAfterEntry * POST_GRAD_FEE_RATE);
    const flywheelGrowth = Math.round(postGradFees * BBASE_SHARE * ownershipPercent);
    const feeYield = Math.round(postGradFees * LP_YIELD_SHARE * ownershipPercent);
    
    const atRisk = lpDeposit + flywheelGrowth;
    const settlementOutcome = Math.round(atRisk * positionImbalance * 2);
    
    const lpRedemption = Math.max(0, lpDeposit + flywheelGrowth + settlementOutcome + feeYield);
    const lpPnL = lpRedemption - lpDeposit;
    
    const netPnL = tradePnL + (isPreGraduation ? lpRedemption : 0);
    const roi = tradeSize > 0 ? (netPnL / tradeSize) * 100 : 0;
    
    return {
        tradeSize,
        entryPrice,
        sharesReceived,
        positionValue,
        feePaid,
        tradePnL,
        lpDeposit,
        totalLpSupply,
        ownershipPercent,
        flywheelGrowth,
        feeYield,
        settlementOutcome,
        lpRedemption,
        lpPnL,
        netPnL,
        roi: Math.round(roi)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//                       ARBITRAGEUR CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate Arbitrageur P&L
 * 
 * Arb captures spread between AMM and SoothBook venues
 * Profit = Spread - Gas - AMM Fee
 */
export function calculateArbitrageurPnL(
    tradeSize: number,
    spreadPercent: number, // e.g., 0.04 for 4%
    gasCost: number,
    ammFeeRate: number = POST_GRAD_FEE_RATE // 1% default
): ArbitrageurResult {
    // Gross profit from spread
    const grossProfit = Math.round(tradeSize * spreadPercent);
    
    // AMM fee (charged on the sell side)
    const ammFee = Math.round(tradeSize * ammFeeRate);
    
    // Total costs
    const totalCosts = gasCost + ammFee;
    
    // Net profit
    const netProfit = grossProfit - totalCosts;
    
    // Return percent
    const returnPercent = tradeSize > 0 ? (netProfit / tradeSize) * 100 : 0;
    
    // Is it profitable?
    const isProfitable = netProfit > 0;
    
    // Minimum viable spread
    const minViableSpread = tradeSize > 0 
        ? ((gasCost + (tradeSize * ammFeeRate)) / tradeSize) * 100 
        : 0;
    
    return {
        tradeSize,
        spreadPercent: spreadPercent * 100, // Convert to percentage for display
        grossProfit,
        gasCost,
        ammFee,
        totalCosts,
        netProfit,
        returnPercent: Math.round(returnPercent * 100) / 100,
        isProfitable,
        minViableSpread: Math.round(minViableSpread * 100) / 100
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//                        PVP TRADER CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate PvP Trader P&L
 * 
 * Pure binary outcome: Win = shares × $1, Lose = $0
 * No LP safety net - winner takes all
 */
export function calculatePvPTraderPnL(
    positionSize: number,
    entryPrice: number, // e.g., 0.35 for 35%
    estimatedWinProb: number, // Trader's belief, e.g., 0.6 for 60%
    outcome: 'win' | 'lose' | 'expected'
): PvPTraderResult {
    // Shares received
    const sharesReceived = entryPrice > 0 ? Math.round(positionSize / entryPrice) : 0;
    
    // Profit if win (shares pay $1 each)
    const profitIfWin = sharesReceived - positionSize;
    
    // Loss if wrong
    const lossIfWrong = -positionSize;
    
    // Expected value
    const expectedValue = Math.round(
        (estimatedWinProb * profitIfWin) + ((1 - estimatedWinProb) * lossIfWrong)
    );
    
    // Actual P&L based on outcome
    let actualPnL: number;
    if (outcome === 'win') {
        actualPnL = profitIfWin;
    } else if (outcome === 'lose') {
        actualPnL = lossIfWrong;
    } else {
        actualPnL = expectedValue;
    }
    
    // Return percent
    const returnPercent = positionSize > 0 ? (actualPnL / positionSize) * 100 : 0;
    
    return {
        positionSize,
        entryPrice,
        sharesReceived,
        profitIfWin,
        lossIfWrong,
        estimatedWinProb,
        expectedValue,
        actualPnL,
        returnPercent: Math.round(returnPercent)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//                           HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export function formatCurrency(value: number, showSign: boolean = false): string {
    const absValue = Math.abs(value);
    const formatted = absValue >= 1000 
        ? `$${(absValue / 1000).toFixed(1)}k`
        : `$${absValue.toLocaleString()}`;
    
    if (value < 0) {
        return `(${formatted})`;
    }
    if (showSign && value > 0) {
        return `+${formatted}`;
    }
    return formatted;
}

/**
 * Format percentage for display
 */
export function formatPercent(value: number, showSign: boolean = false): string {
    const formatted = `${Math.abs(value).toFixed(1)}%`;
    if (showSign && value !== 0) {
        return value > 0 ? `+${formatted}` : `-${formatted}`;
    }
    return formatted;
}

/**
 * Get liquidity tier info
 */
export function getLiquidityTier(deposit: number): { name: string; b: number; threshold: number } {
    if (deposit <= 100) return { name: 'Micro', b: 100, threshold: 69 };
    if (deposit <= 1000) return { name: 'Small', b: 1000, threshold: 693 };
    if (deposit <= 10000) return { name: 'Medium', b: 10000, threshold: 6930 };
    return { name: 'Large', b: 100000, threshold: 69300 };
}

/**
 * Calculate deposit required for a given liquidity tier
 */
export function calculateDeposit(liquidityTier: number, initialProbability: number = 50): number {
    const probFraction = Math.max(0.01, Math.min(0.99, initialProbability / 100));
    const depthK = -Math.log(Math.min(probFraction, 1 - probFraction));
    return Math.round(liquidityTier * depthK);
}

/**
 * Calculate graduation threshold for a given deposit
 */
export function calculateGraduationThreshold(deposit: number, multiplier: number = 1): number {
    return Math.round(deposit * multiplier);
}
