import { describe, expect, it } from "vitest";

import { classifyError } from "../src/orderbook/error-classifier.js";
import { soothCoreIdl } from "../src/anchor/index.js";

function anchorErr(code: string): Error & {
  error: { errorCode: { code: string } };
} {
  const err = new Error(`AnchorError caused by account: ${code}`) as Error & {
    error: { errorCode: { code: string } };
  };
  err.error = { errorCode: { code } };
  return err;
}

describe("classifyError", () => {
  it("classifies BookSideFull", () => {
    const out = classifyError(anchorErr("BookSideFull"));
    expect(out.code).toBe("BookSideFull");
    expect(out.category).toBe("state");
    expect(out.retriable).toBe(false);
  });

  it("classifies MissingCrossingBookSide", () => {
    const out = classifyError(anchorErr("MissingCrossingBookSide"));
    expect(out.code).toBe("MissingCrossingBookSide");
    expect(out.category).toBe("protocol-internal");
    expect(out.retriable).toBe(true);
  });

  it("classifies MakerAccountMismatch", () => {
    const out = classifyError(anchorErr("MakerAccountMismatch"));
    expect(out.code).toBe("MakerAccountMismatch");
    expect(out.category).toBe("protocol-internal");
    expect(out.retriable).toBe(true);
  });

  it("classifies WrongBundleArity", () => {
    const out = classifyError(anchorErr("WrongBundleArity"));
    expect(out.code).toBe("WrongBundleArity");
    expect(out.category).toBe("protocol-internal");
    expect(out.retriable).toBe(false);
  });

  it("classifies AccumulatorNotReset", () => {
    const out = classifyError(anchorErr("AccumulatorNotReset"));
    expect(out.code).toBe("AccumulatorNotReset");
    expect(out.category).toBe("protocol-internal");
    expect(out.retriable).toBe(false);
  });

  it("classifies OrderIdSeedMismatch", () => {
    const out = classifyError(anchorErr("OrderIdSeedMismatch"));
    expect(out.code).toBe("OrderIdSeedMismatch");
    expect(out.category).toBe("validation");
    expect(out.retriable).toBe(false);
  });

  it("classifies MarketNotGraduated", () => {
    const out = classifyError(anchorErr("MarketNotGraduated"));
    expect(out.code).toBe("MarketNotGraduated");
    expect(out.category).toBe("state");
    expect(out.retriable).toBe(false);
  });

  it("classifies Slippage", () => {
    const out = classifyError(anchorErr("Slippage"));
    expect(out.code).toBe("Slippage");
    expect(out.category).toBe("validation");
    expect(out.retriable).toBe(false);
  });

  it("classifies WrongBaseMint", () => {
    const out = classifyError(anchorErr("WrongBaseMint"));
    expect(out.code).toBe("WrongBaseMint");
    expect(out.category).toBe("protocol-internal");
    expect(out.retriable).toBe(false);
  });

  it("classifies BaseMintDrift", () => {
    const out = classifyError(anchorErr("BaseMintDrift"));
    expect(out.code).toBe("BaseMintDrift");
    expect(out.category).toBe("protocol-internal");
    expect(out.retriable).toBe(false);
  });

  it("classifies MarketNotOpen", () => {
    const out = classifyError(anchorErr("MarketNotOpen"));
    expect(out.code).toBe("MarketNotOpen");
    expect(out.category).toBe("state");
    expect(out.retriable).toBe(false);
  });

  it("classifies AMM MarketNotActive alias as MarketNotOpen", () => {
    const out = classifyError(anchorErr("MarketNotActive"));
    expect(out.code).toBe("MarketNotOpen");
    expect(out.category).toBe("state");
  });

  it("classifies PositionInsufficient alias as InsufficientShares", () => {
    const out = classifyError(anchorErr("PositionInsufficient"));
    expect(out.code).toBe("InsufficientShares");
    expect(out.category).toBe("validation");
  });

  it("classifies NothingToDistribute by program log text", () => {
    const out = classifyError(
      new Error("SoothError: ProgramError code=6032 msg=Fee pool is empty — nothing to distribute"),
    );
    expect(out.code).toBe("NothingToDistribute");
    expect(out.category).toBe("state");
  });

  it("classifies LegacyDrainAlreadyExecuted by program log text", () => {
    const out = classifyError(
      new Error("SoothError: ProgramError code=6036 msg=Legacy fee drain already executed"),
    );
    expect(out.code).toBe("LegacyDrainAlreadyExecuted");
    expect(out.category).toBe("state");
  });
});

describe("bare numeric codes", () => {
  const errorsByName = new Map(
    (
      soothCoreIdl as unknown as {
        errors: Array<{ code: number; name: string }>;
      }
    ).errors.map((e) => [e.name, e.code]),
  );

  function customErr(code: number): Error {
    return new Error(
      `Transaction simulation failed: custom program error: 0x${code.toString(16)}`,
    );
  }

  it("resolves a code with no log line to the same entry the name resolves to", () => {
    // A failure caught before the logs are attached — a wallet rejection, an
    // RPC that returns only `err: { InstructionError: [0, { Custom: 6044 }] }`
    // — arrives as a number. It has to land on the same advice.
    const byName = classifyError(anchorErr("BookSideFull"));
    const byCode = classifyError(customErr(errorsByName.get("BookSideFull")!));
    expect(byCode).toEqual(byName);
  });

  it("follows the aliases the named path follows", () => {
    // `SlippageExceeded` is the program's name; `Slippage` is the catalog's.
    // The numeric path went through a separate hand-written table that knew
    // neither, so it reported the raw ordinal instead.
    const out = classifyError(
      customErr(errorsByName.get("SlippageExceeded")!),
    );
    expect(out.code).toBe("Slippage");
    expect(out.category).toBe("validation");
  });

  it("names an unmapped code instead of printing the ordinal", () => {
    // Not in the catalog, so there is no advice to give — but the program has
    // a name for it, and "ZkAttestorMismatch" is answerable where "6077" is
    // not.
    const out = classifyError(
      customErr(errorsByName.get("ZkAttestorMismatch")!),
    );
    expect(out.code).toBe("ZkAttestorMismatch");
    expect(out.category).toBe("unknown");
  });
});

describe("claim_refund's position-parse failures", () => {
  // The program reports these by NUMBER, and the classifier maps numbers back
  // to names through the bundled IDL. So this exercises the numeric path —
  // the one a real `sendTransaction` rejection takes — rather than the name
  // path, and it fails if the IDL copy is stale.
  const byName = new Map(
    ((soothCoreIdl as { errors?: Array<{ code: number; name: string }> })
      .errors ?? []).map((e) => [e.name, e.code]),
  );

  const names = [
    "PositionAddressMismatch",
    "PositionOwnerMismatch",
    "PositionMalformed",
    "PositionUserMismatch",
    "PositionMarketMismatch",
  ];

  it.each(names)("classifies %s from its numeric code", (name) => {
    const code = byName.get(name);
    expect(code, `${name} is missing from the bundled IDL`).toBeDefined();
    const err = new Error(
      `failed to send transaction: custom program error: 0x${code!.toString(16)}`,
    );
    const out = classifyError(err);
    expect(out.code).toBe(name);
    expect(out.category).not.toBe("unknown");
    expect(out.retriable).toBe(false);
  });

  it("no longer hides behind VaultAuthorityMismatch", () => {
    // Every one of these used to surface as the vault error, which sent a
    // debugger to look at the vault for a fault in the position.
    const codes = new Set(names.map((n) => byName.get(n)));
    expect(codes.size).toBe(names.length);
    expect(codes.has(byName.get("VaultAuthorityMismatch"))).toBe(false);
  });
});
