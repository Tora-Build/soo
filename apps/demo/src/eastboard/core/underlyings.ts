export type OptionSession = "cn" | "hk";

export type SettlementSource =
  | "sse-dayk"
  | "szse-history"
  | "tencent-hkfqkline"
  | "yahoo-chart";

export interface OptionUnderlying {
  id: string;
  symbol: string;
  name: string;
  localName: string;
  kind: "index" | "equity";
  session: OptionSession;
  source: SettlementSource;
  sourceCode: string;
  jsonPath: string;
  priceDecimals: number;
  referencePriceRaw: bigint;
  strikeStepRaw: bigint;
  marketCapRank: number;
  dailyLimitBps?: number;
}

export const OPTION_UNDERLYINGS = [
  {
    id: "csi300",
    symbol: "CSI 300",
    name: "CSI 300 Index",
    localName: "沪深 300",
    kind: "index",
    session: "cn",
    source: "sse-dayk",
    sourceCode: "000300",
    jsonPath: "$.kline[0][1]",
    priceDecimals: 3,
    referencePriceRaw: 4_543_178n,
    strikeStepRaw: 50_000n,
    marketCapRank: 0,
  },
  {
    id: "sse",
    symbol: "SSE",
    name: "SSE Composite",
    localName: "上证指数",
    kind: "index",
    session: "cn",
    source: "sse-dayk",
    sourceCode: "000001",
    jsonPath: "$.kline[0][1]",
    priceDecimals: 3,
    referencePriceRaw: 3_583_310n,
    strikeStepRaw: 50_000n,
    marketCapRank: 1,
  },
  {
    id: "hsi",
    symbol: "HSI",
    name: "Hang Seng Index",
    localName: "恒生指数",
    kind: "index",
    session: "hk",
    source: "tencent-hkfqkline",
    sourceCode: "hkHSI",
    jsonPath: "$.data.hkHSI.day[0][2]",
    priceDecimals: 2,
    referencePriceRaw: 2_600_940n,
    strikeStepRaw: 50_000n,
    marketCapRank: 2,
  },
  {
    id: "tencent",
    symbol: "0700.HK",
    name: "Tencent",
    localName: "腾讯",
    kind: "equity",
    session: "hk",
    source: "yahoo-chart",
    sourceCode: "0700.HK",
    jsonPath: "$.chart.result[0].indicators.quote[0].close[0]",
    priceDecimals: 2,
    referencePriceRaw: 49_040n,
    strikeStepRaw: 2_000n,
    marketCapRank: 10,
  },
  {
    id: "cxmt",
    symbol: "688825",
    name: "CXMT",
    localName: "长鑫科技",
    kind: "equity",
    session: "cn",
    source: "sse-dayk",
    sourceCode: "688825",
    jsonPath: "$.kline[0][1]",
    priceDecimals: 2,
    referencePriceRaw: 20_600n,
    strikeStepRaw: 1_000n,
    marketCapRank: 11,
    dailyLimitBps: 2_000,
  },
  {
    id: "alibaba",
    symbol: "9988.HK",
    name: "Alibaba",
    localName: "阿里巴巴",
    kind: "equity",
    session: "hk",
    source: "yahoo-chart",
    sourceCode: "9988.HK",
    jsonPath: "$.chart.result[0].indicators.quote[0].close[0]",
    priceDecimals: 2,
    referencePriceRaw: 11_880n,
    strikeStepRaw: 500n,
    marketCapRank: 12,
  },
  {
    id: "smic",
    symbol: "688981",
    name: "SMIC",
    localName: "中芯国际",
    kind: "equity",
    session: "cn",
    source: "sse-dayk",
    sourceCode: "688981",
    jsonPath: "$.kline[0][1]",
    priceDecimals: 2,
    referencePriceRaw: 9_260n,
    strikeStepRaw: 500n,
    marketCapRank: 13,
    dailyLimitBps: 2_000,
  },
  {
    id: "cambricon",
    symbol: "688256",
    name: "Cambricon",
    localName: "寒武纪",
    kind: "equity",
    session: "cn",
    source: "sse-dayk",
    sourceCode: "688256",
    jsonPath: "$.kline[0][1]",
    priceDecimals: 2,
    referencePriceRaw: 68_800n,
    strikeStepRaw: 5_000n,
    marketCapRank: 14,
    dailyLimitBps: 2_000,
  },
  {
    id: "zhipu",
    symbol: "2513.HK",
    name: "Z.AI",
    localName: "智谱",
    kind: "equity",
    session: "hk",
    source: "yahoo-chart",
    sourceCode: "2513.HK",
    jsonPath: "$.chart.result[0].indicators.quote[0].close[0]",
    priceDecimals: 2,
    referencePriceRaw: 108_500n,
    strikeStepRaw: 5_000n,
    marketCapRank: 15,
  },
  {
    id: "minimax",
    symbol: "0100.HK",
    name: "MiniMax",
    localName: "稀宇科技",
    kind: "equity",
    session: "hk",
    source: "yahoo-chart",
    sourceCode: "0100.HK",
    jsonPath: "$.chart.result[0].indicators.quote[0].close[0]",
    priceDecimals: 2,
    referencePriceRaw: 30_000n,
    strikeStepRaw: 1_500n,
    marketCapRank: 16,
  },
  {
    id: "moorethreads",
    symbol: "688795",
    name: "Moore Threads",
    localName: "摩尔线程",
    kind: "equity",
    session: "cn",
    source: "sse-dayk",
    sourceCode: "688795",
    jsonPath: "$.kline[0][1]",
    priceDecimals: 2,
    referencePriceRaw: 59_313n,
    strikeStepRaw: 2_500n,
    marketCapRank: 17,
    dailyLimitBps: 2_000,
  },
  {
    id: "metax",
    symbol: "688802",
    name: "MetaX",
    localName: "沐曦",
    kind: "equity",
    session: "cn",
    source: "sse-dayk",
    sourceCode: "688802",
    jsonPath: "$.kline[0][1]",
    priceDecimals: 2,
    referencePriceRaw: 72_603n,
    strikeStepRaw: 2_500n,
    marketCapRank: 18,
    dailyLimitBps: 2_000,
  },
  {
    id: "biren",
    symbol: "6082.HK",
    name: "Biren",
    localName: "壁仞科技",
    kind: "equity",
    session: "hk",
    source: "yahoo-chart",
    sourceCode: "6082.HK",
    jsonPath: "$.chart.result[0].indicators.quote[0].close[0]",
    priceDecimals: 2,
    referencePriceRaw: 3_788n,
    strikeStepRaw: 150n,
    marketCapRank: 19,
  },
  {
    id: "iluvatar",
    symbol: "9903.HK",
    name: "Iluvatar CoreX",
    localName: "天数智芯",
    kind: "equity",
    session: "hk",
    source: "yahoo-chart",
    sourceCode: "9903.HK",
    jsonPath: "$.chart.result[0].indicators.quote[0].close[0]",
    priceDecimals: 2,
    referencePriceRaw: 44_880n,
    strikeStepRaw: 2_000n,
    marketCapRank: 20,
  },
] as const satisfies readonly OptionUnderlying[];

export function getUnderlying(id: string): OptionUnderlying {
  const underlying = OPTION_UNDERLYINGS.find((item) => item.id === id);
  if (!underlying) throw new Error(`Unknown option underlying: ${id}`);
  return underlying;
}

export function formatPrice(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0");
  const value = decimals === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${value}` : value;
}
