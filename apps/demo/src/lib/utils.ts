import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { tokenSymbols } from "./config";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a currency value compactly when it grows beyond ~7 digits.
 * - < 1,000,000: standard USD formatting, two decimals
 * - >= 1M: abbreviated with K/M/B/T/Q suffix and two decimals
 *
 * Keeps small balances readable while preventing layout blowout when a
 * testnet faucet or over-minted deploy leaves the user with an absurd value.
 */
export function formatCurrencyCompact(
  value: number,
  currencySymbol = "$",
): string {
  if (!Number.isFinite(value)) return `${currencySymbol}0.00`;
  const abs = Math.abs(value);
  if (abs < 1_000_000) {
    return `${currencySymbol}${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  const suffixes: [number, string][] = [
    [1e15, "Q"],
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
  ];
  for (const [threshold, suffix] of suffixes) {
    if (abs >= threshold) {
      return `${currencySymbol}${(value / threshold).toFixed(2)}${suffix}`;
    }
  }
  return `${currencySymbol}${value.toFixed(2)}`;
}

/**
 * Money in the AMM venue's token.
 *
 * The AMM's collateral token is chosen per deployment via config — this
 * deployment fills both venue roles with the same mock USDC mint, so the
 * ticker comes from `tokenSymbols.amm` rather than being hardcoded here.
 *
 * Probabilities are a separate thing and stay as ¢ or %: a share price of 50¢
 * is the market's odds, not an amount of any token.
 */
export function formatAmmAmount(value: number): string {
  return `${formatCurrencyCompact(value, "")} ${tokenSymbols.amm}`;
}

