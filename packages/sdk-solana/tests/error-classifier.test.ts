// decodeSubmitError must disambiguate Anchor error codes by failing-program
// ID. With the single merged `sooth_core` program, every error code has one
// canonical meaning. These tests verify:
//   1. Known sooth_core codes are correctly decoded (kind + code preserved).
//   2. Unknown program IDs → bare ProgramError, code preserved.
//   3. Missing logs → falls back to ProgramError without guessing.
//   4. extractFailingProgramId scans logs newest-first.

import { describe, expect, it } from "vitest";
import { __testing } from "../src/adapter.js";

const CORE_ID = "BgcooFgTuDQdoQkjLrZNRM6zM4Bu9bnAEenqdKjjR25W";

const lookup = new Map([
  [CORE_ID, __testing.SOOTH_CORE_ERROR_TABLE],
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

describe("decodeSubmitError with merged sooth_core error table", () => {
  it("sooth_core code 6032 (0x1790) → LockNotElapsed", () => {
    // 6032 = 0x1790
    const e = __testing.decodeSubmitError(
      makeErr(CORE_ID, "1790"),
      "sig1",
      lookup,
    );
    expect(e.kind).toBe("LockNotElapsed");
    expect(e.fields.code).toBe(0x1790);
  });

  it("sooth_core code 6012 (0x177c) → ProgramError with allowlist msg", () => {
    // 6012 = 0x177c — AdjudicatorNotOnAllowlist
    const e = __testing.decodeSubmitError(
      makeErr(CORE_ID, "177c"),
      "sig2",
      lookup,
    );
    expect(e.kind).toBe("ProgramError");
    expect(e.fields.code).toBe(0x177c);
    expect(e.fields.msg).toMatch(/allowlist/i);
  });

  it("sooth_core code 6035 (0x1793) → AlreadyGraduated", () => {
    // 6035 = 0x1793 — AlreadyGraduated
    const e = __testing.decodeSubmitError(
      makeErr(CORE_ID, "1793"),
      "sig3",
      lookup,
    );
    expect(e.kind).toBe("AlreadyGraduated");
    expect(e.fields.code).toBe(0x1793);
  });

  it("sooth_core code 6054 (0x17a6) → NotImplemented", () => {
    // 6054 = 0x17a6 — DisputeNotImplemented
    const e = __testing.decodeSubmitError(
      makeErr(CORE_ID, "17a6"),
      "sig4",
      lookup,
    );
    expect(e.kind).toBe("NotImplemented");
    expect(e.fields.code).toBe(0x17a6);
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
    // No logs to extract program ID from — we must NOT assume sooth_core.
    expect(e.kind).toBe("ProgramError");
    expect(e.fields.code).toBe(0x177c);
    expect(e.fields.msg).toMatch(/Unknown program error code/);
  });
});

describe("extractFailingProgramId", () => {
  const ANOTHER_ID = "H8DtUDKvaJZVj2Vt2RZW9FmUCjpJAQunffGFcCTbctos";

  it("scans logs newest-first and matches the failing program", () => {
    const logs = [
      `Program ${CORE_ID} invoke [1]`,
      `Program ${ANOTHER_ID} invoke [2]`,
      `Program ${ANOTHER_ID} success`,
      `Program ${CORE_ID} invoke [2]`,
      `Program ${CORE_ID} failed: custom program error: 0x1774`,
      `Program ${ANOTHER_ID} failed: custom program error: 0x1774`,
    ];
    const err = Object.assign(new Error("..."), { logs });
    expect(__testing.extractFailingProgramId(err)).toBe(ANOTHER_ID);
  });

  it("returns undefined when no program-failed line exists", () => {
    expect(
      __testing.extractFailingProgramId(new Error("nope")),
    ).toBeUndefined();
  });
});
