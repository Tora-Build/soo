/**
 * Market Stats Math Hook
 * 
 * LMSR Accounting Model:
 * - Seed = bBase * ln(2)
 * - Fees = feesAccrued
 * - P&L = C(qYes, qNo, bCurrent) - C(0, 0, bCurrent)
 * - Gross Cash = Seed + Fees + P&L
 * - Liability = max(qYes, qNo) = worst-case payout to traders
 * - Floor = Gross - Liability = LP's guaranteed minimum equity
 */
import { useMemo } from 'react';
import { formatUnits, parseUnits } from '@/lib/chain-shim';

// Types from our other hooks
interface LaunchpadData {
    creatorDeposit: bigint;
    feesAccrued: bigint;
    lpYieldPool: bigint;
    lpSupply: bigint;
    currentBBase: bigint;
    initialBBase: bigint;
    floorValue?: bigint;
}

interface AMMStateData {
    qYes: bigint;
    qNo: bigint;
    lockedProceeds?: bigint; // USDC balance of AMMEngine (total locked proceeds)
}

export const LN2 = 0.693147180559945309;

// Stable log-sum-exp LMSR cost function: C(q) = b * ln(e^(qYes/b) + e^(qNo/b))
export function calculateLMSRCost(qYes: bigint, qNo: bigint, b: bigint): number {
    if (b === 0n) return 0;
    const bNum = Number(formatUnits(b, 18));
    const qYesNum = Number(formatUnits(qYes, 18));
    const qNoNum = Number(formatUnits(qNo, 18));

    // Stable Log-Sum-Exp: ln(e^x + e^y) = max(x, y) + ln(1 + e^(-|x-y|))
    const x = qYesNum / bNum;
    const y = qNoNum / bNum;
    const max = x > y ? x : y;
    const diff = Math.abs(x - y);

    // C = b * (max(x, y) + ln(1 + e^-|diff|))
    return bNum * (max + Math.log(1 + Math.exp(-diff)));
}

export const useMarketStatsMath = (launchpad: LaunchpadData | undefined, ammState: AMMStateData | undefined, usdcDecimals: number) => {
    return useMemo(() => {
        if (!launchpad || !ammState) return null;

        // Scale factors
        const usdcFactor = BigInt(10 ** usdcDecimals);
        const wad = 1_000_000_000_000_000_000n;

        const seed = launchpad.creatorDeposit;
        const fees = launchpad.feesAccrued;
        const lpYieldPool = launchpad.lpYieldPool;

        const bCurrent = launchpad.currentBBase;
        const bBase = launchpad.initialBBase;
        const rawQYes = ammState.qYes;
        const rawQNo = ammState.qNo;

        // 1. LMSR Cost Components
        const currentCostNum = calculateLMSRCost(rawQYes, rawQNo, bCurrent);
        const initialCostNum = calculateLMSRCost(0n, 0n, bCurrent); // C(0,0,bCurrent)

        // P&L is the profit/loss compared to the "flat" state at current liquidity
        const pnlNum = currentCostNum - initialCostNum;
        const pnl = parseUnits(pnlNum.toFixed(usdcDecimals), usdcDecimals);

        // 2. Cash = MaxLoss + Yield + P&L
        // MaxLoss = bCurrent × ln(2) (LMSR max loss capacity)
        // Yield = lpYieldPool (accumulated LP yield)
        // P&L = pnl (current cost deviation)
        const maxLossNum = Number(formatUnits(bCurrent, 18)) * LN2;
        const maxLoss = parseUnits(maxLossNum.toFixed(usdcDecimals), usdcDecimals);
        const cash = maxLoss + lpYieldPool + pnl;

        // Gross = Seed + Fees + P&L, before the LP share is netted out.
        const gross = seed + fees + pnl;

        // 3. Liability = max(qYes, qNo) - worst case payout
        const qYesUsdc = usdcDecimals === 18 ? rawQYes : rawQYes / (wad / usdcFactor);
        const qNoUsdc = usdcDecimals === 18 ? rawQNo : rawQNo / (wad / usdcFactor);
        const liability = qYesUsdc > qNoUsdc ? qYesUsdc : qNoUsdc;

        // 4. Floor = Cash - max(qYes, qNo) - guaranteed LP equity
        const floor = cash > liability ? cash - liability : 0n;

        // 5. Ceiling = Cash - min(qYes, qNo) - best case LP equity
        const minLiability = qYesUsdc < qNoUsdc ? qYesUsdc : qNoUsdc;
        const ceilingEquity = cash > minLiability ? cash - minLiability : 0n;

        // 6. Supply & Rates
        const supply = launchpad.lpSupply;
        const supplyNum = Number(formatUnits(supply, 18));

        const floorRate = supplyNum > 0 ? Number(formatUnits(floor, usdcDecimals)) / supplyNum : 0;
        const ceilingRate = supplyNum > 0 ? Number(formatUnits(ceilingEquity, usdcDecimals)) / supplyNum : 0;

        // 7. Anchor Supply = b × ln(2) ≈ initial LP supply at creation
        const anchorSupply = Number(formatUnits(bBase, 18)) * LN2;

        // 8. Liquidity growth = bCurrent - bBase (from fee reinvestment)
        const liquidityGrowth = bCurrent > bBase ? bCurrent - bBase : 0n;

        // 9. TVL = Cash + Locked
        // Locked = Total spendable proceeds in AMMEngine (USDC balance of AMMEngine)
        const lockedProceeds = ammState.lockedProceeds ?? 0n;
        const tvl = cash + lockedProceeds;

        return {
            seed,
            fees,
            pnl,
            gross,
            lpYieldPool,
            maxLoss,
            cash,
            lockedProceeds,
            tvl,
            liability,
            floor,
            ceilingEquity,
            supply,
            floorRate,
            ceilingRate,
            b: bCurrent,
            bBase,
            liquidityGrowth,
            anchorSupply,
            qYes: qYesUsdc,
            qNo: qNoUsdc,
            rawQYes,
            rawQNo,
            decimals: usdcDecimals
        };
    }, [launchpad, ammState, usdcDecimals]);
};
