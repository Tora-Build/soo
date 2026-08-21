// The client half of a zkTLS-adjudicated market: what the creator picks, and
// what we can show them before they sign.
//
// The market commits to `(url, parsePath)` as a hash, plus a comparator, a
// threshold and a decimal scale. Nothing here is trusted on chain — the
// program re-derives the hash and re-parses the value from the attestation
// Primus signs. What this file buys is the ONE thing the chain cannot give
// back: a look at the number the rule reads, before the rule is written and
// becomes immutable.

import { MAX_ZK_VALUE_SCALE, ZK_COMPARATOR } from "@sooth/sdk-solana";

/** Largest `value_scale` the program accepts. Re-exported so the form's clamp
 * and the program's check are the same number. */
export const MAX_SCALE = MAX_ZK_VALUE_SCALE;

/** Primus' global attestor. Every attestation the network returns is signed
 * by this address, and `register_zk_adjudicator` writes it once and forever,
 * so it is a constant rather than a field. */
export const PRIMUS_ATTESTOR_EVM = "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6";

export type ComparatorId = "Gt" | "Gte" | "Lt" | "Lte" | "Eq";

export const COMPARATORS: Array<{ id: ComparatorId; symbol: string }> = [
  { id: "Gt", symbol: ">" },
  { id: "Gte", symbol: "≥" },
  { id: "Lt", symbol: "<" },
  { id: "Lte", symbol: "≤" },
  { id: "Eq", symbol: "=" },
];

export const comparatorCode = (id: ComparatorId): 1 | 2 | 3 | 4 | 5 =>
  ZK_COMPARATOR[id] as 1 | 2 | 3 | 4 | 5;

export interface ZkPreset {
  id: string;
  /** i18n key under `launchpad.zk.presets`. */
  labelKey: string;
  url: string;
  parsePath: string;
  /** Decimal places to register. See `DEFAULT_VALUE_SCALE`. */
  valueScale: number;
}

/**
 * `value_scale` 8, not 2, for a price feed.
 *
 * The program REJECTS an attested value carrying more fractional digits than
 * the registered scale rather than truncating it, and Coinbase's spot amount
 * moves between two and three decimals from reading to reading. Registering
 * the scale you happen to see today makes the market unresolvable tomorrow.
 * Eight is headroom, not precision.
 */
export const DEFAULT_VALUE_SCALE = 8;

export const ZK_PRESETS: ZkPreset[] = [
  {
    id: "btc",
    labelKey: "btc",
    url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    parsePath: "$.data.amount",
    valueScale: DEFAULT_VALUE_SCALE,
  },
  {
    id: "eth",
    labelKey: "eth",
    url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    parsePath: "$.data.amount",
    valueScale: DEFAULT_VALUE_SCALE,
  },
  {
    id: "custom",
    labelKey: "custom",
    url: "",
    parsePath: "",
    valueScale: DEFAULT_VALUE_SCALE,
  },
];

/**
 * Resolves the subset of JSONPath the attestor supports: a `$` root followed
 * by dotted keys and numeric or quoted bracket indices.
 *
 * Deliberately not a general JSONPath engine. Primus resolves one value from
 * one path, and a path this parser cannot handle is a path that will not
 * resolve on the attestor's side either — better to say so in the form than
 * to preview a value the market will never see.
 */
export function evaluateParsePath(body: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed.startsWith("$")) {
    throw new Error("path must start with $");
  }
  let cursor: unknown = body;
  const tokens = trimmed
    .slice(1)
    .replace(/\[(['"])(.*?)\1\]/g, ".$2")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((t) => t.length > 0);
  for (const token of tokens) {
    if (cursor === null || typeof cursor !== "object") {
      throw new Error(`no value at "${token}"`);
    }
    cursor = (cursor as Record<string, unknown>)[token];
    if (cursor === undefined) {
      throw new Error(`no value at "${token}"`);
    }
  }
  return cursor;
}

/** How many fractional digits a decimal string carries. */
export function decimalPlaces(value: string): number {
  const frac = value.split(".")[1];
  return frac ? frac.length : 0;
}

/**
 * A decimal string to fixed point at `10 ** scale`, rejecting excess
 * precision rather than truncating — the same rule the program's
 * `parse_fixed_point` applies to the attested value.
 */
export function toFixedPoint(decimal: string, scale: number): bigint {
  const [intPart, fracPart = ""] = decimal.trim().split(".");
  if (!/^\d+$/.test(intPart ?? "") || (fracPart && !/^\d+$/.test(fracPart))) {
    throw new Error(`"${decimal}" is not a plain decimal number`);
  }
  if (fracPart.length > scale) {
    throw new Error(
      `${decimal} carries ${fracPart.length} decimals, more than scale ${scale}`,
    );
  }
  return BigInt((intPart ?? "0") + fracPart.padEnd(scale, "0"));
}

export interface PreviewResult {
  /** The raw value at `parsePath`, as a string. */
  raw: string;
  /** Its numeric reading, for comparison against the threshold. */
  numeric: number;
  /** Fractional digits in `raw` — compared against the chosen scale. */
  decimals: number;
}

/**
 * Fetches the endpoint and applies the path, exactly as the attestor will.
 *
 * A rule that reads the wrong field is the main way a zk market goes wrong,
 * and it goes wrong silently: registration succeeds, and the failure only
 * shows up when the first attestation is rejected. So we read it here.
 */
export async function previewRule(
  url: string,
  parsePath: string,
  signal?: AbortSignal,
): Promise<PreviewResult> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json();
  const value = evaluateParsePath(body, parsePath);
  if (typeof value === "object" && value !== null) {
    throw new Error("path resolves to an object, not a value");
  }
  const raw = String(value);
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    throw new Error(`"${raw}" is not a number`);
  }
  return { raw, numeric, decimals: decimalPlaces(raw) };
}

/** Which way the rule reads right now, given a live value. */
export function evaluateComparator(
  value: number,
  comparator: ComparatorId,
  threshold: number,
): boolean {
  switch (comparator) {
    case "Gt":
      return value > threshold;
    case "Gte":
      return value >= threshold;
    case "Lt":
      return value < threshold;
    case "Lte":
      return value <= threshold;
    case "Eq":
      return value === threshold;
  }
}

export interface ZkRuleDraft {
  presetId: string;
  url: string;
  parsePath: string;
  comparator: ComparatorId;
  threshold: string;
  valueScale: number;
}

export const initialZkDraft = (): ZkRuleDraft => ({
  presetId: "btc",
  url: ZK_PRESETS[0]!.url,
  parsePath: ZK_PRESETS[0]!.parsePath,
  comparator: "Gt",
  threshold: "",
  valueScale: DEFAULT_VALUE_SCALE,
});

/** Whether the draft is complete enough to register. */
export function zkDraftError(draft: ZkRuleDraft): string | null {
  if (!draft.url.trim()) return "url";
  if (!/^https?:\/\//i.test(draft.url.trim())) return "urlScheme";
  if (!draft.parsePath.trim().startsWith("$")) return "path";
  if (!draft.threshold.trim()) return "threshold";
  try {
    toFixedPoint(draft.threshold.trim(), draft.valueScale);
  } catch {
    return "thresholdPrecision";
  }
  return null;
}
