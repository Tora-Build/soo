import type { AnchorError } from "@coral-xyz/anchor";
import type { SendTransactionError } from "@solana/web3.js";

export interface ClassifiedError {
  code: string;
  message: string;
  retriable: boolean;
  category: "validation" | "state" | "auth" | "protocol-internal" | "unknown";
}

type KnownClassifiedError = Omit<ClassifiedError, "code">;

const CATALOG: Record<string, KnownClassifiedError> = {
  BookSideFull: {
    category: "state",
    message:
      "This price level is full (50 orders max). Try a different tick or wait for someone to cancel.",
    retriable: false,
  },
  MissingCrossingBookSide: {
    category: "protocol-internal",
    message: "Stale state detected. Retrying with fresh order-book data...",
    retriable: true,
  },
  MakerAccountMismatch: {
    category: "protocol-internal",
    message: "Stale state detected. Retrying with fresh order-book data...",
    retriable: true,
  },
  WrongBundleArity: {
    category: "protocol-internal",
    message: "Internal SDK error. Please report this.",
    retriable: false,
  },
  AccumulatorNotReset: {
    category: "protocol-internal",
    message: "Internal program invariant violated. Please report.",
    retriable: false,
  },
  OrderIdSeedMismatch: {
    category: "validation",
    message:
      "The order ID you provided doesn't match the side/tick. Check your order ID.",
    retriable: false,
  },
  MarketNotGraduated: {
    category: "state",
    message: "This market hasn't graduated yet. Use the AMM to trade.",
    retriable: false,
  },
  Slippage: {
    category: "validation",
    message:
      "Price moved against you. Adjust your slippage tolerance or wait for stable prices.",
    retriable: false,
  },
  WrongBaseMint: {
    category: "protocol-internal",
    message: "Mint mismatch detected. Please report.",
    retriable: false,
  },
  BaseMintDrift: {
    category: "protocol-internal",
    message: "Mint mismatch detected. Please report.",
    retriable: false,
  },
  MathOverflow: {
    category: "protocol-internal",
    message: "Internal program math overflow. Please report.",
    retriable: false,
  },
  MarketNotOpen: {
    category: "state",
    message: "This market is not open for trading.",
    retriable: false,
  },
  InsufficientShares: {
    category: "validation",
    message: "Insufficient shares for this order.",
    retriable: false,
  },
  NothingToDistribute: {
    category: "state",
    message: "There are no fees to distribute for this market.",
    retriable: false,
  },
  LegacyDrainAlreadyExecuted: {
    category: "state",
    message: "The legacy fee drain has already been executed.",
    retriable: false,
  },
};

const ALIASES: Record<string, keyof typeof CATALOG> = {
  NotGraduated: "MarketNotGraduated",
  SlippageExceeded: "Slippage",
  MarketNotActive: "MarketNotOpen",
  PositionInsufficient: "InsufficientShares",
  InsufficientOutcomeShares: "InsufficientShares",
};

const NUMERIC_CODES: Record<number, keyof typeof CATALOG> = {
  // sooth_core SoothCoreError ordinals (Anchor user errors start at 6000).
  6006: "MathOverflow",
  6043: "OrderIdSeedMismatch",
  6044: "BookSideFull",
  6047: "WrongBaseMint",
  6048: "BaseMintDrift",
  6049: "AccumulatorNotReset",
  6051: "MissingCrossingBookSide",
  6052: "MakerAccountMismatch",
  6053: "WrongBundleArity",
};

export function classifyError(
  err: SendTransactionError | AnchorError | Error | unknown,
): ClassifiedError {
  const extracted = extractCode(err);
  const code = extracted.code ? canonicalCode(extracted.code) : undefined;
  if (code && CATALOG[code]) {
    return { code, ...CATALOG[code] };
  }

  const textCode = codeFromText(rawProgramLog(err));
  if (textCode && CATALOG[textCode]) {
    return { code: textCode, ...CATALOG[textCode] };
  }

  const numericCode = extracted.numericCode;
  if (numericCode !== undefined && NUMERIC_CODES[numericCode]) {
    const mapped = NUMERIC_CODES[numericCode];
    return { code: mapped, ...CATALOG[mapped] };
  }
  const raw = rawProgramLog(err);
  return {
    code: code ?? (numericCode != null ? String(numericCode) : "Unknown"),
    category: "unknown",
    message: raw,
    retriable: false,
  };
}

function codeFromText(text: string): keyof typeof CATALOG | undefined {
  const lowered = text.toLowerCase();
  if (lowered.includes("fee pool is empty")) return "NothingToDistribute";
  if (lowered.includes("legacy fee drain already executed")) {
    return "LegacyDrainAlreadyExecuted";
  }
  if (lowered.includes("market is not in the open lifecycle state")) {
    return "MarketNotOpen";
  }
  if (
    lowered.includes("insufficient shares") ||
    lowered.includes("insufficient outcome-token balance")
  ) {
    return "InsufficientShares";
  }
  return undefined;
}

function canonicalCode(code: string): keyof typeof CATALOG | string {
  return ALIASES[code] ?? code;
}

function extractCode(err: unknown): {
  code?: string;
  numericCode?: number;
} {
  const anchorCode =
    readStringPath(err, ["error", "errorCode", "code"]) ??
    readStringPath(err, ["errorCode", "code"]) ??
    readStringPath(err, ["code"]);
  if (anchorCode) return { code: anchorCode };

  const logs = readLogs(err);
  for (const line of logs) {
    const anchorLog = /Error Code:\s*([A-Za-z][A-Za-z0-9_]*)\./.exec(line);
    if (anchorLog?.[1]) return { code: anchorLog[1] };
  }

  const text = rawProgramLog(err);
  const named = /Error Code:\s*([A-Za-z][A-Za-z0-9_]*)\./.exec(text);
  if (named?.[1]) return { code: named[1] };
  const custom = /custom program error:\s*0x([0-9a-f]+)/i.exec(text);
  if (custom?.[1]) {
    const parsed = Number.parseInt(custom[1], 16);
    if (Number.isFinite(parsed)) return { numericCode: parsed };
  }
  const decimal = /\bcode=(\d+)\b/.exec(text);
  if (decimal?.[1]) {
    const parsed = Number.parseInt(decimal[1], 10);
    if (Number.isFinite(parsed)) return { numericCode: parsed };
  }
  return {};
}

function readStringPath(value: unknown, path: string[]): string | undefined {
  let cur = value;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : undefined;
}

function readLogs(value: unknown): string[] {
  const logs = (value as { logs?: unknown })?.logs;
  return Array.isArray(logs)
    ? logs.filter((line): line is string => typeof line === "string")
    : [];
}

function rawProgramLog(err: unknown): string {
  const logs = readLogs(err);
  if (logs.length > 0) return logs.join("\n");
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
