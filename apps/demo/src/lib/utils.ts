// Tiny utility surface. The upstream demo's `lib/utils.ts` carried a
// `clsx`-wrapper `cn()` plus a chain-aware `formatBalance` — we keep `cn`
// (chain-agnostic) and ship a Solana-shaped formatter for USDC base units.

import clsx, { type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs);
}

// Format USDC base units (6 decimals) with a trailing `USDC` suffix.
// Solana base units are always integer; bigint is the native shape.
export function formatUsdc(baseUnits: bigint, decimals = 4): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").slice(0, decimals);
  return `${negative ? "-" : ""}${whole}.${fracStr} USDC`;
}

// Format a WAD-scaled bigint (1e18) as a fixed-decimal string. Used for
// share counts and prices in the buy form.
export function formatWad(wad: bigint, decimals = 4): string {
  const WAD = 1_000_000_000_000_000_000n;
  const negative = wad < 0n;
  const abs = negative ? -wad : wad;
  const whole = abs / WAD;
  const frac = abs % WAD;
  const fracStr = frac.toString().padStart(18, "0").slice(0, decimals);
  return `${negative ? "-" : ""}${whole}.${fracStr}`;
}

// Truncate a base58 pubkey for display: `Abc1…XyZ9`.
export function truncatePubkey(s: string, head = 4, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
