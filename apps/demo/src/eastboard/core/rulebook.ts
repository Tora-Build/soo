import type { IsoDate } from "./calendar";
import type { OptionUnderlying } from "./underlyings";

export interface OptionRule {
  description: string;
  source: string;
  params: string;
  op: "gte";
  target: string;
  invalidReasons: readonly string[];
}

export function buildOptionRule(
  underlying: OptionUnderlying,
  expiry: IsoDate,
  strikeRaw: bigint,
  jsonPath: string,
): OptionRule {
  const invalidReasons = [
    ...(underlying.kind === "equity"
      ? [
          `${underlying.symbol} is suspended for the full ${expiry} session`,
          `a dividend, split, rights issue, or other corporate-action ex-date falls after activation and on or before ${expiry}`,
        ]
      : []),
    "fewer than two independent sources agree by close plus six hours",
    `the exchange does not publish a ${expiry} close`,
  ];
  return {
    description: `YES iff the official unadjusted close of ${underlying.name} on ${expiry} is greater than or equal to the strike. INVALID if ${invalidReasons.join("; ")}.`,
    source: underlying.source,
    params: `code=${underlying.sourceCode},date=${expiry},jsonpath=${jsonPath}`,
    op: "gte",
    target: strikeRaw.toString(),
    invalidReasons,
  };
}
