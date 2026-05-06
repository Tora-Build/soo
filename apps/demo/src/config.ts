import marketsJson from './config/markets.json';
import poolsJson from './config/pools.json';
import protocolJson from './config/protocol.json';
import type {
  AdjudicatorKind,
  MarketConfig,
  PoolConfig,
  ProtocolConfig,
  Market,
  Pool,
} from './types';

export const marketConfigs = marketsJson.markets as MarketConfig[];
export const poolConfigs = poolsJson.pools as PoolConfig[];
export const protocolConfig = protocolJson as ProtocolConfig;

export const adjudicatorLabelsByKind: Record<AdjudicatorKind, string> =
  poolConfigs.reduce((acc, pool) => {
    const cleaned = pool.label.replace(/\s*Pool$/i, '').trim();
    acc[pool.adjudicatorKind] = cleaned;
    return acc;
  }, {} as Record<AdjudicatorKind, string>);

export function buildInitialMarkets(): Market[] {
  return marketConfigs.map((m, idx) => ({
    ...m,
    adjudicatorLabel:
      adjudicatorLabelsByKind[m.adjudicatorKind] ??
      m.adjudicatorLabel ??
      m.adjudicatorKind,
    status: m.initialStatus ?? 'trading',
    priceYes:
      typeof m.initialYes === 'number'
        ? Math.min(1, Math.max(0, m.initialYes))
        : 0.5 + (idx - 1) * 0.07, // spread around 0.5 for demo fallback
    priceNo:
      1 -
      (typeof m.initialYes === 'number'
        ? Math.min(1, Math.max(0, m.initialYes))
        : 0.5 + (idx - 1) * 0.07),
    virtualYesStake: 1000 * (typeof m.initialYes === 'number'
        ? Math.min(1, Math.max(0, m.initialYes))
        : 0.5 + (idx - 1) * 0.07),
    virtualNoStake: 1000 * (1 -
      (typeof m.initialYes === 'number'
        ? Math.min(1, Math.max(0, m.initialYes))
        : 0.5 + (idx - 1) * 0.07)),
    userYesShares: 0,
    userNoShares: 0,
    userAvgEntryYes: null,
    userAvgEntryNo: null,
    adjudicatorProofUploaded: false,
    qYes: 0n,
    qNo: 0n,
    bParam: 0n,
    userYesOutcomeTokens: 0,
    userNoOutcomeTokens: 0,
  }));
}

export function buildInitialPools(): Pool[] {
  return poolConfigs.map((p, idx) => ({
    ...p,
    tvl: 1_000_000 - idx * 150_000,
    locked: 80_000 + idx * 20_000,
    apy: 15 + idx * 2.5,
    marketsExposed: 5 + idx * 3,
    userLpBalance: 0,
  }));
}
