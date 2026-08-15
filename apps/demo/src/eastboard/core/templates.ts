// Ported from sooth-alpha's @sooth/options-core (branch `east`), minus the
// EVM pieces: `questionHash` was keccak256 for the EVM contracts, but the
// Solana program verifies sha256(question) itself at create time and the SDK
// derives it from the text — so the template carries only the QUESTION, which
// is also how cells are matched to on-chain markets (the program emits the
// verified text in MarketCreated). `encodeCanonicalTemplate` (ABI-encoded
// adjudicator config) has no Solana equivalent and is dropped.
import { getSessionClose, type IsoDate } from "./calendar";
import { buildOptionRule, type OptionRule } from "./rulebook";
import { buildSettlementRequest, type SettlementRequest } from "./urls";
import {
  formatPrice,
  OPTION_UNDERLYINGS,
  type OptionUnderlying,
} from "./underlyings";

export const OPTION_B_BASE_WAD = 25_000_000_000_000_000_000n;
export const OPTION_PROBABILITY_WAD = 500_000_000_000_000_000n;
export const ATTESTATION_WINDOW_SECONDS = 21_600;

export type AttestationMode = "simulated" | "primus";

export interface OptionTemplate {
  id: string;
  underlyingId: string;
  underlyingSymbol: string;
  underlyingName: string;
  underlyingKind: OptionUnderlying["kind"];
  expiry: IsoDate;
  strikeRaw: bigint;
  strikeDecimals: number;
  strikeLabel: string;
  closeTs: number;
  closeLabel: string;
  cfgDeadline: number;
  attestationMode: AttestationMode;
  question: string;
  event: string;
  request: SettlementRequest;
  rule: OptionRule;
  bBaseWad: bigint;
  probabilityWad: bigint;
  meta: Readonly<Record<string, string>>;
}

export interface BuildOptionTemplateOptions {
  attestationMode?: AttestationMode;
}

function roundToStep(value: bigint, step: bigint): bigint {
  return ((value + step / 2n) / step) * step;
}

export function buildStrikeLadder(
  underlying: OptionUnderlying,
  width = 2,
): bigint[] {
  const center = roundToStep(
    underlying.referencePriceRaw,
    underlying.strikeStepRaw,
  );
  return Array.from({ length: width * 2 + 1 }, (_, index) =>
    center + BigInt(index - width) * underlying.strikeStepRaw,
  ).filter((strike) => strike > 0n);
}

export function buildOptionTemplate(
  underlying: OptionUnderlying,
  expiry: IsoDate,
  strikeRaw: bigint,
  options: BuildOptionTemplateOptions = {},
): OptionTemplate {
  const attestationMode = options.attestationMode ?? "simulated";
  const request = buildSettlementRequest(underlying, expiry);
  const session = getSessionClose(underlying.session, expiry);
  const strikeLabel = formatPrice(strikeRaw, underlying.priceDecimals);
  const question = `${attestationMode === "simulated" ? "[TESTNET MANUAL SIMULATION] " : ""}Will the ${underlying.name} official close on ${expiry} be greater than or equal to ${strikeLabel}?`;
  const id = `${underlying.id}-${expiry.replaceAll("-", "")}-${strikeRaw}`;
  return {
    id,
    underlyingId: underlying.id,
    underlyingSymbol: underlying.symbol,
    underlyingName: underlying.name,
    underlyingKind: underlying.kind,
    expiry,
    strikeRaw,
    strikeDecimals: underlying.priceDecimals,
    strikeLabel,
    closeTs: session.closeTs,
    closeLabel: session.label,
    cfgDeadline: session.closeTs + ATTESTATION_WINDOW_SECONDS,
    attestationMode,
    question,
    event: `${underlying.id}-${expiry}`,
    request,
    rule: buildOptionRule(underlying, expiry, strikeRaw, request.jsonPath),
    bBaseWad: OPTION_B_BASE_WAD,
    probabilityWad: OPTION_PROBABILITY_WAD,
    meta: {
      "template-id": id,
      underlying: underlying.id,
      "strike-raw": strikeRaw.toString(),
      "strike-decimals": underlying.priceDecimals.toString(),
      expiry,
      source: underlying.source,
      jsonpath: request.jsonPath,
      "settlement-mode":
        attestationMode === "simulated" ? "manual-simulation" : "v2-zktls",
      "attestation-mode": attestationMode,
    },
  };
}

export function buildOptionTemplates(
  underlying: OptionUnderlying,
  expiries: readonly IsoDate[],
  options: BuildOptionTemplateOptions & { strikeWidth?: number } = {},
): OptionTemplate[] {
  const strikes = buildStrikeLadder(underlying, options.strikeWidth);
  return expiries.flatMap((expiry) =>
    strikes.map((strike) =>
      buildOptionTemplate(underlying, expiry, strike, options),
    ),
  );
}

export interface ParsedOptionQuestion {
  underlyingId: string;
  expiry: IsoDate;
  strikeRaw: bigint;
  attestationMode: AttestationMode;
}

/**
 * Inverse of the canonical question built by buildOptionTemplate. Accepts
 * only the exact canonical shape (including the simulation prefix); returns
 * null for anything else so discovery can skip foreign questions safely.
 */
export function parseOptionQuestion(
  question: string,
): ParsedOptionQuestion | null {
  const text = question.trim();
  const prefix = "[TESTNET MANUAL SIMULATION] ";
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length);
  const match = body.match(
    /^Will the (.+?) official close on (\d{4}-\d{2}-\d{2}) be greater than or equal to ([0-9]+(?:\.[0-9]+)?)\?$/,
  );
  if (!match) return null;
  const [, name, expiry, label] = match;
  const underlying = OPTION_UNDERLYINGS.find((item) => item.name === name);
  if (!underlying) return null;
  const [whole, fraction = ""] = label.split(".");
  if (!/^\d+$/.test(whole)) return null;
  if (fraction && !/^\d+$/.test(fraction)) return null;
  if (fraction.length > underlying.priceDecimals) return null;
  const strikeRaw =
    BigInt(whole) * 10n ** BigInt(underlying.priceDecimals) +
    BigInt(fraction.padEnd(underlying.priceDecimals, "0"));
  return {
    underlyingId: underlying.id,
    expiry: expiry as IsoDate,
    strikeRaw,
    attestationMode: "simulated",
  };
}
