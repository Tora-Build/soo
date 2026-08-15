export interface PriceObservation {
  source: string;
  valueRaw: bigint;
}

export type QuorumResult =
  | { status: "agreed"; valueRaw: bigint; sources: readonly string[] }
  | { status: "disagreed"; observations: readonly PriceObservation[] };

export function resolvePriceQuorum(
  observations: readonly PriceObservation[],
  toleranceRaw = 0n,
): QuorumResult {
  if (observations.length < 2) {
    return { status: "disagreed", observations };
  }
  for (let left = 0; left < observations.length; left += 1) {
    const matches = observations.filter(
      (observation) =>
        observation.valueRaw >= observations[left]!.valueRaw - toleranceRaw &&
        observation.valueRaw <= observations[left]!.valueRaw + toleranceRaw,
    );
    if (matches.length >= 2) {
      const sorted = matches.map((item) => item.valueRaw).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        status: "agreed",
        valueRaw: sorted[Math.floor(sorted.length / 2)]!,
        sources: matches.map((item) => item.source),
      };
    }
  }
  return { status: "disagreed", observations };
}
