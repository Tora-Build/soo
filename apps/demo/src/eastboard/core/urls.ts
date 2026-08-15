import type { IsoDate } from "./calendar";
import type { OptionUnderlying } from "./underlyings";

function compactDate(date: IsoDate): string {
  return date.replaceAll("-", "");
}

function hktMidnightEpoch(date: IsoDate): number {
  return Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1_000);
}

export interface SettlementRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  jsonPath: string;
}

export function buildSettlementRequest(
  underlying: OptionUnderlying,
  date: IsoDate,
): SettlementRequest {
  const path = underlying.jsonPath.replace("{date}", date);
  switch (underlying.source) {
    case "sse-dayk":
      return {
        url: `https://yunhq.sse.com.cn:32042/v1/sh1/dayk/${underlying.sourceCode}?date=${compactDate(date)}&select=date,close`,
        headers: {},
        jsonPath: path,
      };
    case "szse-history":
      return {
        url: `https://www.szse.cn/api/market/ssjjhq/getHistoryData?cycleType=32&marketId=1&code=${underlying.sourceCode}`,
        headers: {},
        jsonPath: path,
      };
    case "tencent-hkfqkline": {
      return {
        url: `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=${underlying.sourceCode},day,${date},${date},1,qfq`,
        headers: {},
        jsonPath: path,
      };
    }
    case "yahoo-chart": {
      const period1 = hktMidnightEpoch(date);
      return {
        url: `https://query1.finance.yahoo.com/v8/finance/chart/${underlying.sourceCode}?period1=${period1}&period2=${period1 + 86_400}&interval=1d`,
        headers: { "User-Agent": "Mozilla/5.0" },
        jsonPath: path,
      };
    }
  }
}
