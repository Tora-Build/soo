import { WAD } from "../config";

/** WAD price → whole cents, the app's lingua franca. */
export function centsOf(priceWad: bigint): number {
  return Number((priceWad * 1000n) / WAD) / 10;
}

export function pct(priceWad: bigint): string {
  return `${Math.round(centsOf(priceWad))}%`;
}

export function cents(priceWad: bigint): string {
  const c = centsOf(priceWad);
  return `${c % 1 === 0 ? c.toFixed(0) : c.toFixed(1)}¢`;
}

export function tokens(wad: bigint, dp = 2): string {
  return (Number(wad) / 1e18).toLocaleString(undefined, {
    maximumFractionDigits: dp,
  });
}

export function shortPda(ref: string): string {
  const s = ref.replace(/^sol:/, "");
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
