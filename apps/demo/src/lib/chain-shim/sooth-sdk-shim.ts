// chain-shim/sooth-sdk-shim.ts — stand-in for `@sooth/sdk/core` and
// `@sooth/sdk/core/abis`. Upstream's demo imports these for ABIs (EVM-only),
// command output types, and a few constants. The Solana fork has no
// EVM ABI dispatcher — return empty ABIs so `useReadContract` calls
// short-circuit to "no data" via the wagmi-shim's sentinel return.

// ─── Constants ──────────────────────────────────────────────────────────────

export const WAD = 10n ** 18n;
export const MAX_UINT256 = (1n << 256n) - 1n;

// ─── Output / command types ────────────────────────────────────────────────

export type OutputLineType =
  | "plain"
  | "info"
  | "success"
  | "error"
  | "warn"
  | "dim"
  | "bold";

export interface OutputLine {
  type: OutputLineType;
  text: string;
}

export type OutputCallback = (line: OutputLine) => void;

export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

// ─── ABI stubs ─────────────────────────────────────────────────────────────
//
// Each upstream import resolves to an empty array. `useReadContract` in the
// wagmi-shim ignores its arguments, so the runtime cost of empty ABIs is
// zero — the value is purely to satisfy compile-time imports.

const EMPTY_ABI = [] as const;

export const AMMEngineABI = EMPTY_ABI;
export const LaunchpadEngineABI = EMPTY_ABI;
export const OutcomeTokenABI = EMPTY_ABI;
export const TruthMarketABI = EMPTY_ABI;
