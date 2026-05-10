// decodeSubmitError must disambiguate Anchor error codes by failing-program
// ID. The same numeric code (6012) means LockNotElapsed in sooth_amm but
// AdjudicatorNotAllowlisted in sooth_market — without the program ID the
// decoder previously labeled both as LockNotElapsed (wrong half the time).

import { describe, expect, it } from "vitest";
import { __testing } from "../src/adapter.js";

const AMM_ID = "JsDen5joP97Jo6qBQyzDncD9ZbaFAMdaXeUMrZ7udyr";
const MARKET_ID = "5jweuZk3hGpck2teNZv5KUAuYzVEGgFoj1cyu1jffhZH";
const LAUNCHPAD_ID = "8pHPMF1U86iDQTB5ig1xyjbcDMfS1PXi8LLD4EiqNqm8";
const ADJUDICATOR_ID = "H8DtUDKvaJZVj2Vt2RZW9FmUCjpJAQunffGFcCTbctos";

const lookup = new Map([
  [AMM_ID, __testing.SOOTH_AMM_ERROR_TABLE],
  [MARKET_ID, __testing.SOOTH_MARKET_ERROR_TABLE],
  [LAUNCHPAD_ID, __testing.SOOTH_LAUNCHPAD_ERROR_TABLE],
  [ADJUDICATOR_ID, __testing.SOOTH_ADJUDICATOR_ERROR_TABLE],
]);

function makeErr(programId: string, hexCode: string, logs?: string[]): Error {
  const baseLogs = logs ?? [
    `Program ${programId} invoke [1]`,
    `Program ${programId} failed: custom program error: 0x${hexCode}`,
  ];
  const err = new Error(
    `Error processing Instruction 0: custom program error: 0x${hexCode}`,
  ) as Error & { logs?: string[] };
  err.logs = baseLogs;
  return err;
}

describe("decodeSubmitError disambiguates by failing program ID", () => {
  it("sooth_amm code 6012 → LockNotElapsed", () => {
    const e = __testing.decodeSubmitError(
      makeErr(AMM_ID, "177c"),
      "sig1",
      lookup,
    );
    expect(e.kind).toBe("LockNotElapsed");
    expect(e.fields.code).toBe(0x177c);
  });

  it("sooth_market code 6012 → AdjudicatorNotAllowlisted (mapped to ProgramError)", () => {
    const e = __testing.decodeSubmitError(
      makeErr(MARKET_ID, "177c"),
      "sig2",
      lookup,
    );
    expect(e.kind).toBe("ProgramError");
    expect(e.fields.code).toBe(0x177c);
    expect(e.fields.msg).toMatch(/allowlist/i);
  });

  it("sooth_launchpad code 6005 → AlreadyGraduated msg", () => {
    const e = __testing.decodeSubmitError(
      makeErr(LAUNCHPAD_ID, "1775"),
      "sig3",
      lookup,
    );
    expect(e.kind).toBe("ProgramError");
    expect(e.fields.code).toBe(0x1775);
    expect(e.fields.msg).toMatch(/already graduated/i);
  });

  it("sooth_adjudicator code 6007 → DisputeNotImplemented msg", () => {
    const e = __testing.decodeSubmitError(
      makeErr(ADJUDICATOR_ID, "1777"),
      "sig4",
      lookup,
    );
    expect(e.kind).toBe("NotImplemented");
    expect(e.fields.code).toBe(0x1777);
  });

  it("unknown program ID → bare ProgramError, code preserved, no false mapping", () => {
    const unknownId = "11111111111111111111111111111111";
    const e = __testing.decodeSubmitError(
      makeErr(unknownId, "177c"),
      undefined,
      lookup,
    );
    expect(e.kind).toBe("ProgramError");
    expect(e.fields.code).toBe(0x177c);
    expect(e.fields.msg).toMatch(/Unknown program error code/);
  });

  it("missing logs → falls back to ProgramError without guessing", () => {
    const err = new Error(
      "Error processing Instruction 0: custom program error: 0x177c",
    );
    const e = __testing.decodeSubmitError(err, undefined, lookup);
    // No logs to extract program ID from — we must NOT assume sooth_amm.
    expect(e.kind).toBe("ProgramError");
    expect(e.fields.code).toBe(0x177c);
    expect(e.fields.msg).toMatch(/Unknown program error code/);
  });
});

describe("extractFailingProgramId", () => {
  it("scans logs newest-first and matches the failing program", () => {
    const logs = [
      `Program ${MARKET_ID} invoke [1]`,
      `Program ${ADJUDICATOR_ID} invoke [2]`,
      `Program ${ADJUDICATOR_ID} success`,
      `Program ${AMM_ID} invoke [2]`,
      `Program ${AMM_ID} failed: custom program error: 0x1774`,
      `Program ${MARKET_ID} failed: custom program error: 0x1774`,
    ];
    const err = Object.assign(new Error("..."), { logs });
    expect(__testing.extractFailingProgramId(err)).toBe(MARKET_ID);
  });

  it("returns undefined when no program-failed line exists", () => {
    expect(
      __testing.extractFailingProgramId(new Error("nope")),
    ).toBeUndefined();
  });
});
