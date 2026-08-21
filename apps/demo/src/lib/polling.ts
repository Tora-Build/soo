/**
 * Polling intervals for chain reads.
 *
 * Jitter is added to every interval so a page mounting N hooks at once does
 * not fire N requests on the same tick for the rest of the session.
 */

const BASE_INTERVALS = {
  FAST: 10000,
  NORMAL: 15000,
  SLOW: 30000,
  VERY_SLOW: 60000,
};

const JITTER_RATIO = 0.2;

function addJitter(interval: number): number {
  const jitter = interval * JITTER_RATIO * Math.random();
  return Math.floor(interval + jitter);
}

export function getPollingInterval(
  _chainId: number | undefined,
  speed: 'fast' | 'normal' | 'slow' | 'very_slow' = 'normal'
): number {
  const baseInterval =
    BASE_INTERVALS[speed.toUpperCase() as keyof typeof BASE_INTERVALS] ??
    BASE_INTERVALS.NORMAL;
  return addJitter(baseInterval);
}

/** How long a cached read is considered fresh. */
export function getStaleTime(_chainId: number | undefined): number {
  return 10000;
}
