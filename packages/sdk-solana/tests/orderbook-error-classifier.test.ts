import { describe, expect, it } from "vitest";

import { classifyError } from "../src/orderbook/error-classifier.js";

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
