
/**
 * Canonical LMSR Math for Sooth Protocol V4 (Continuous)
 * Implements log-sum-exp with overflow protection.
 */

// Helper: Calculate Cost function C(q)
// C = b * ln(sum(exp(q_i / b)))
// Robust: M + b * ln(sum(exp((q_i - M) / b)))
export function calculateLMSRCost(qYes: number, qNo: number, b: number): number {
    if (b === 0) return 0; // Avoid potential div/0 if b=0 (shouldn't happen in valid market)
    const maxQ = Math.max(qYes, qNo);
    // Formula: M + b * ln(exp((q1-M)/b) + exp((q2-M)/b))
    const sumExp = Math.exp((qYes - maxQ) / b) + Math.exp((qNo - maxQ) / b);
    return maxQ + b * Math.log(sumExp);
}

// Calculate Trade Cost and Price Impact
export function getLMSRQuote(
    currentQYes: number,
    currentQNo: number,
    bParam: number,
    shareAmount: number, // Positive for buy, negative usually handled by caller or interpreted as delta
    outcomeIndex: 0 | 1 // V8.13.0: 0=NO, 1=YES (unified with TruthMarket)
    // NOTE: This function uses LMSR position indices where:
    //   outcomeIndex=0 corresponds to qYes position modification
    //   outcomeIndex=1 corresponds to qNo position modification
    // This is internal LMSR math, NOT the same as contract outcome encoding.
    // Contract outcome: YES=1, NO=0 per TruthMarket canonical semantics.
) {
    // Current State
    const currentCost = calculateLMSRCost(currentQYes, currentQNo, bParam);

    // New State
    // shareAmount is the DELTA. (Positive = Buy, Negative = Sell)
    // If buying YES (0), add to qYes.
    const delta = shareAmount;
    const newQYes = outcomeIndex === 0 ? currentQYes + delta : currentQYes;
    const newQNo = outcomeIndex === 1 ? currentQNo + delta : currentQNo;

    const newCost = calculateLMSRCost(newQYes, newQNo, bParam);
    const expectedCost = newCost - currentCost; // Amount user pays. (Negative if sell)

    // New Prices (Marginal Price = exp(q/b) / sum(exp(q/b)))
    // P = exp((q-M)/b) / sum...
    const maxNew = Math.max(newQYes, newQNo);
    const expYes = Math.exp((newQYes - maxNew) / bParam);
    const expNo = Math.exp((newQNo - maxNew) / bParam);
    const sumExp = expYes + expNo;

    const newPriceYes = expYes / sumExp;
    const newPriceNo = expNo / sumExp;

    return {
        expectedCost, // Raw cost
        newPriceYes,
        newPriceNo,
        newQYes,
        newQNo
    };
}
