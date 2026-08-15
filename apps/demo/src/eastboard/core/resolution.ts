import { computeOptionDataHash } from "./dataHash";
import {
  resolvePriceQuorum,
  type PriceObservation,
  type QuorumResult,
} from "./quorum";
import type { OptionTemplate } from "./templates";
import { formatPrice } from "./underlyings";

export type OptionOutcome = 0 | 1 | 2;

export interface OptionResolutionFlags {
  closePublished?: boolean;
  fullSessionSuspended?: boolean;
  corporateActionExDate?: boolean;
}

export interface SimulatedEvidenceRecord {
  mode: "simulated";
  verified: false;
  templateId: string;
  observedAt: string;
  observations: ReadonlyArray<{ source: string; valueRaw: string }>;
  rawValue: string;
  decision: "YES" | "NO" | "INVALID";
  reason: string;
}

export interface OptionResolutionDecision {
  outcome: OptionOutcome;
  rawValue: string;
  dataHash: `0x${string}`;
  quorum: QuorumResult;
  reason: string;
  evidence: SimulatedEvidenceRecord;
}

function invalidReason(
  template: OptionTemplate,
  observations: readonly PriceObservation[],
  flags: OptionResolutionFlags,
  quorum: QuorumResult,
): string | null {
  if (flags.closePublished === false || observations.length === 0) {
    return `the exchange did not publish a ${template.expiry} close`;
  }
  if (template.underlyingKind === "equity" && flags.fullSessionSuspended) {
    return `${template.underlyingSymbol} was suspended for the full session`;
  }
  if (template.underlyingKind === "equity" && flags.corporateActionExDate) {
    return "a qualifying corporate-action ex-date occurred after activation";
  }
  if (quorum.status === "disagreed") {
    return "fewer than two independent sources agreed on the close";
  }
  return null;
}

export function decideOptionOutcome(input: {
  template: OptionTemplate;
  observations: readonly PriceObservation[];
  flags?: OptionResolutionFlags;
  toleranceRaw?: bigint;
  observedAt?: string;
}): OptionResolutionDecision {
  const flags = input.flags ?? {};
  const quorum = resolvePriceQuorum(
    input.observations,
    input.toleranceRaw ?? 0n,
  );
  const invalid = invalidReason(
    input.template,
    input.observations,
    flags,
    quorum,
  );
  const valueRaw =
    quorum.status === "agreed"
      ? (input.observations.find((observation) =>
          quorum.sources.includes(observation.source),
        )?.valueRaw ?? quorum.valueRaw)
      : null;
  const outcome: OptionOutcome = invalid
    ? 2
    : valueRaw! >= input.template.strikeRaw
      ? 1
      : 0;
  const rawValue = invalid
    ? `INVALID:${invalid}`
    : formatPrice(valueRaw!, input.template.strikeDecimals);
  const decision = outcome === 1 ? "YES" : outcome === 0 ? "NO" : "INVALID";
  const reason =
    invalid ??
    `${rawValue} ${outcome === 1 ? ">=" : "<"} ${input.template.strikeLabel}`;
  return {
    outcome,
    rawValue,
    dataHash: computeOptionDataHash(rawValue),
    quorum,
    reason,
    evidence: {
      mode: "simulated",
      verified: false,
      templateId: input.template.id,
      observedAt: input.observedAt ?? new Date().toISOString(),
      observations: input.observations.map((observation) => ({
        source: observation.source,
        valueRaw: observation.valueRaw.toString(),
      })),
      rawValue,
      decision,
      reason,
    },
  };
}
