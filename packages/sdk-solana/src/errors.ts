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
  | "NetworkError"
  | "NotImplemented"
  | "AccountNotFound"
  | "TradingNotStarted"
  | "TradingClosed"
  | "SellNotImplemented"
  | "LockNotElapsed"
  | "LockVaultMismatch"
  | "TrialNotExpired"
  | "AlreadyGraduated"
  | "AlreadyDismissed"
  | "MarketNotDismissed"
  | "NotGraduated";

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
  // Solana-specific: the tx signature for explorer lookup on submit failures.
  signature?: string;
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
  const sigSuffix = fields.signature ? ` sig=${fields.signature}` : "";
  switch (kind) {
    case "NotImplemented":
      return `SoothError: ${kind} (${fields.method ?? "?"})`;
    case "ProgramError":
      return `SoothError: ${kind} code=${fields.code ?? "?"} msg=${fields.msg ?? ""}${sigSuffix}`;
    case "NetworkError":
      return `SoothError: ${kind} attempt=${fields.attempt ?? "?"} msg=${fields.msg ?? ""}${sigSuffix}`;
    case "SlippageExceeded":
      // expected/actual come from the on-chain program's `msg!` log, which
      // classifySubmitError doesn't currently parse. Fall back to the
      // generic msg + code so the toast doesn't read "expected=undefined
      // actual=undefined" (which is meaningless to users).
      if (fields.expected !== undefined || fields.actual !== undefined) {
        return `SoothError: ${kind} expected=${fields.expected ?? "?"} actual=${fields.actual ?? "?"}${sigSuffix}`;
      }
      return `SoothError: ${kind} ${fields.msg ?? "max_cost_wad exceeded"}${sigSuffix}`;
    case "InsufficientShares":
      return `SoothError: ${kind} needed=${fields.needed} available=${fields.available}${sigSuffix}`;
    case "AccountNotFound":
      return `SoothError: ${kind} ${fields.msg ?? ""}`;
    case "TradingNotStarted":
    case "TradingClosed":
    case "SellNotImplemented":
    case "LockNotElapsed":
    case "LockVaultMismatch":
    case "TrialNotExpired":
    case "AlreadyGraduated":
    case "AlreadyDismissed":
    case "MarketNotDismissed":
    case "NotGraduated":
      return `SoothError: ${kind} ${fields.msg ?? ""}${sigSuffix}`;
    default:
      return `SoothError: ${kind}${sigSuffix}`;
  }
}

// Convenience factory — keeps call sites short.
export function notImplemented(method: string): never {
  throw new SoothError({ kind: "NotImplemented", method });
}
