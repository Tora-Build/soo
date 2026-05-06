// Tagged-union error class. Mirrors the `SoothError` taxonomy from the
// integrator contract (`docs/integrator-contract.md §3` "SoothError variants").
//
// We don't implement the full taxonomy yet — only the kinds the AMM buy path
// raises plus a `NotImplemented` escape hatch for stubs. The shape is
// deliberately loose so additional variants can be added without breaking
// existing throw sites.
//
// When `@sooth/sdk@0.3.0` ships its canonical `SoothError`, the adapter
// re-uses it; the swap is mechanical because the variants below are a strict
// subset of the upstream union.

import type { MarketRef } from "./types.js";

export type SoothErrorKind =
  | "InsufficientShares"
  | "OrderNotActive"
  | "MarketNotActive"
  | "InvalidTick"
  | "SlippageExceeded"
  | "InsufficientApproval"
  | "BookMoved"
  | "ProgramError"
  | "NotImplemented"
  | "AccountNotFound";

export interface SoothErrorInit {
  kind: SoothErrorKind;
  // Variant-specific fields.
  needed?: bigint;
  available?: bigint;
  orderId?: string;
  market?: MarketRef;
  tick?: number;
  expected?: bigint;
  actual?: bigint;
  attempt?: number;
  code?: number;
  msg?: string;
  // Adapter-specific stub annotation.
  method?: string;
}

export class SoothError extends Error {
  readonly kind: SoothErrorKind;
  readonly fields: Readonly<Omit<SoothErrorInit, "kind">>;

  constructor(init: SoothErrorInit, cause?: unknown) {
    const { kind, ...rest } = init;
    super(formatMessage(kind, rest), cause ? { cause } : undefined);
    this.name = "SoothError";
    this.kind = kind;
    this.fields = rest;
  }
}

function formatMessage(
  kind: SoothErrorKind,
  fields: Omit<SoothErrorInit, "kind">,
): string {
  switch (kind) {
    case "NotImplemented":
      return `SoothError: ${kind} (${fields.method ?? "?"})`;
    case "ProgramError":
      return `SoothError: ${kind} code=${fields.code ?? "?"} msg=${fields.msg ?? ""}`;
    case "SlippageExceeded":
      return `SoothError: ${kind} expected=${fields.expected} actual=${fields.actual}`;
    case "InsufficientShares":
      return `SoothError: ${kind} needed=${fields.needed} available=${fields.available}`;
    case "AccountNotFound":
      return `SoothError: ${kind} ${fields.msg ?? ""}`;
    default:
      return `SoothError: ${kind}`;
  }
}

// Convenience factory — keeps call sites short.
export function notImplemented(method: string): never {
  throw new SoothError({ kind: "NotImplemented", method });
}
