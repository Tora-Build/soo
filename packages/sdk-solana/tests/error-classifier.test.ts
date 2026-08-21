// decodeSubmitError must disambiguate Anchor error codes by failing-program
// ID. With a single `sooth_core` program, every error code has one canonical
// meaning. These tests verify:
//   1. Known sooth_core codes are correctly decoded (kind + code preserved).
//   2. Unknown program IDs → bare ProgramError, code preserved.
//   3. Missing logs → falls back to ProgramError without guessing.
//   4. extractFailingProgramId scans logs newest-first.

import { describe, expect, it } from "vitest";
import { __testing } from "../src/adapter.js";
import { soothCoreIdl } from "../src/anchor/index.js";

const IDL_ERRORS = (
  soothCoreIdl as unknown as {
    errors: Array<{ code: number; name: string; msg: string }>;
  }
).errors;

const CORE_ID = "EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw";

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

describe("decodeSubmitError with sooth_core error table", () => {
  it("sooth_core code 6022 (0x1786) → LockNotElapsed", () => {
    // 6022 = 0x1786 — LockNotElapsed
    const e = __testing.decodeSubmitError(
      makeErr(CORE_ID, "1786"),
      "sig1",
      lookup,
    );
    expect(e.kind).toBe("LockNotElapsed");
    expect(e.fields.code).toBe(0x1786);
  });

  it("sooth_core code 6007 (0x1777) → ProgramError with authority-mismatch msg", () => {
    // 6007 = 0x1777 — VaultAuthorityMismatch
    const e = __testing.decodeSubmitError(
      makeErr(CORE_ID, "1777"),
      "sig2",
      lookup,
    );
    expect(e.kind).toBe("ProgramError");
    expect(e.fields.code).toBe(0x1777);
    expect(e.fields.msg).toMatch(/authority mismatch/i);
  });

  it("sooth_core code 6025 (0x1789) → AlreadyGraduated", () => {
    // 6025 = 0x1789 — AlreadyGraduated
    const e = __testing.decodeSubmitError(
      makeErr(CORE_ID, "1789"),
      "sig3",
      lookup,
    );
    expect(e.kind).toBe("AlreadyGraduated");
    expect(e.fields.code).toBe(0x1789);
  });

  it("sooth_core code 6021 (0x1785) → SellNotImplemented", () => {
    // 6021 = 0x1785 — SellNotImplemented
    const e = __testing.decodeSubmitError(
      makeErr(CORE_ID, "1785"),
      "sig4",
      lookup,
    );
    expect(e.kind).toBe("SellNotImplemented");
    expect(e.fields.code).toBe(0x1785);
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

describe("the error table covers the whole program", () => {
  it("decodes every code the program can raise, with the program's message", () => {
    // Codes the table does not know decode as "Unknown program error code
    // 6072" — a number, from a path a user reached, that names nothing. The
    // zk and veto variants were exactly that until the table was read out of
    // the IDL instead of restated.
    const unmapped: string[] = [];
    for (const { code, name, msg } of IDL_ERRORS) {
      const e = __testing.decodeSubmitError(
        makeErr(CORE_ID, code.toString(16)),
        undefined,
        lookup,
      );
      if (e.fields.msg !== msg) unmapped.push(`${code} ${name}`);
    }
    expect(unmapped, "codes with no message of their own").toEqual([]);
  });

  it("gives the kinds callers branch on to the codes that mean them", () => {
    // The rest are `ProgramError`; these are the ones a UI switches on, so a
    // renumbering that quietly moved one would change what the app does.
    const byName = new Map(IDL_ERRORS.map((e) => [e.name, e.code]));
    const expected: Array<[string, string]> = [
      ["MarketNotOpen", "MarketNotActive"],
      ["MarketDismissed", "MarketNotActive"],
      ["TradingClosed", "TradingClosed"],
      ["TradingNotStarted", "TradingNotStarted"],
      ["SlippageExceeded", "SlippageExceeded"],
      ["InsufficientShares", "InsufficientShares"],
      ["InsufficientOutcomeShares", "InsufficientShares"],
      ["AlreadyGraduated", "AlreadyGraduated"],
      ["AlreadyDismissed", "AlreadyDismissed"],
      ["NotGraduated", "NotGraduated"],
      ["LockNotElapsed", "LockNotElapsed"],
      ["TrialNotExpired", "TrialNotExpired"],
    ];
    for (const [errorName, kind] of expected) {
      const code = byName.get(errorName);
      expect(code, `${errorName} is missing from the IDL`).toBeTypeOf("number");
      const e = __testing.decodeSubmitError(
        makeErr(CORE_ID, code!.toString(16)),
        undefined,
        lookup,
      );
      expect(e.kind, `${errorName} (${code})`).toBe(kind);
    }
  });

  it("still refuses to read another program's codes off this table", () => {
    // Every code is mapped now, which makes the program-ID guard the only
    // thing stopping a foreign 6014 from being reported as slippage.
    const e = __testing.decodeSubmitError(
      makeErr("11111111111111111111111111111111", (6014).toString(16)),
      undefined,
      lookup,
    );
    expect(e.kind).toBe("ProgramError");
    expect(e.fields.msg).toMatch(/Unknown program error code/);
  });
});
