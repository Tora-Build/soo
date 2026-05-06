// Chain-locked stub. Upstream's lib/sdk/utils re-exports formatting helpers
// from @sooth/sdk/core. The Solana fork provides minimal local
// implementations so the Geek terminal still renders message types.

import type { OutputLine, OutputLineType } from "@/lib/chain-shim";

export { WAD } from "@/lib/chain-shim";

export function formatWad(v: bigint, decimals = 4): string {
  const ONE = 10n ** 18n;
  const whole = v / ONE;
  const frac = v % ONE;
  const fracStr = frac.toString().padStart(18, "0").slice(0, decimals);
  return decimals > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

export function parseWad(s: string): bigint {
  const [w = "0", f = ""] = s.split(".");
  const padded = (f + "0".repeat(18)).slice(0, 18);
  return BigInt(w) * 10n ** 18n + BigInt(padded);
}

export function shortAddress(addr: string): string {
  if (!addr) return "";
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function shortTx(tx: string): string {
  if (!tx) return "";
  return tx.length > 14 ? `${tx.slice(0, 8)}…${tx.slice(-6)}` : tx;
}

export function parseTickRange(_s: string): { from: number; to: number } {
  return { from: 0, to: 999 };
}

export function parseOutcome(s: string): 0 | 1 | null {
  const t = s.trim().toLowerCase();
  if (t === "yes" || t === "1") return 1;
  if (t === "no" || t === "0") return 0;
  return null;
}

export function formatOutcome(o: number): string {
  return o === 1 ? "YES" : o === 0 ? "NO" : `?${o}`;
}

export function formatTick(t: number): string {
  return `${t}`;
}

const make =
  (type: OutputLineType) =>
  (text: string): OutputLine => ({ type, text });

export const plain = make("plain");
export const info = make("info");
export const success = make("success");
export const error = make("error");
export const warn = make("warn");
export const dim = make("dim");
export const bold = make("bold");
