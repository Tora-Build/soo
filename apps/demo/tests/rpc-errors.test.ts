// Telling "the chain said no" apart from "the chain did not answer".
//
// Most shim reads degrade to an empty value on failure, which is right for
// depth or order lists — a market with no book really has no orders.
//
// `isGraduated` is different: it is a claim, and it decides routing. A market
// reading as not-graduated has no orderbook tab at all. When the validator was
// killed out from under a running dev server, every read failed, the catch
// returned `false`, and the orderbook silently disappeared — the app looked
// healthy while reporting a graduated market as still bonding.
//
// So the two cases must not collapse. These pin the classifier, including the
// conservative direction: an unrecognised error is NOT called a transport
// failure, because dressing a real program bug as "chain unreachable" sends
// the reader to restart infrastructure instead of reading a stack trace.

import { describe, expect, it } from "vitest";

import {
  fallbackUnlessUnreachable,
  isTransportFailure,
} from "../src/lib/chain-shim/rpc-errors";

describe("isTransportFailure", () => {
  it("recognises a dead local validator", () => {
    // The exact shape node throws at a closed port — the case that caused the
    // vanishing orderbook.
    expect(isTransportFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isTransportFailure(new Error("connect ECONNREFUSED 127.0.0.1:8899"))).toBe(
      true,
    );
  });

  it("digs the reason out of `cause`", () => {
    // `fetch` reports a bare "fetch failed" and hides the real reason one level
    // down, so checking only `message` would miss most real failures.
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = new Error("connect ECONNREFUSED ::1:8899");
    expect(isTransportFailure(err)).toBe(true);
  });

  it("recognises gateway and timeout failures", () => {
    expect(isTransportFailure(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransportFailure(new Error("request timed out"))).toBe(true);
    expect(isTransportFailure({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("does NOT claim a missing account is a transport failure", () => {
    // The legitimate `false`. A pre-launch market has no AmmState, and that is
    // an answer, not a failure to answer.
    expect(isTransportFailure(new Error("Account does not exist"))).toBe(false);
    expect(
      isTransportFailure(new Error("book account not found for market X")),
    ).toBe(false);
  });

  it("does NOT claim a program error is a transport failure", () => {
    // Mislabelling this would send someone to restart their validator when the
    // real problem is in the program.
    expect(isTransportFailure(new Error("custom program error: 0x1771"))).toBe(false);
    expect(isTransportFailure(new Error("Math overflow"))).toBe(false);
  });

  it("treats an unrecognised or empty error as NOT transport", () => {
    // Conservative on purpose: the fallback still happens, so an unknown error
    // degrades exactly as before rather than becoming a hard failure.
    expect(isTransportFailure(new Error("something odd"))).toBe(false);
    expect(isTransportFailure(null)).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
    expect(isTransportFailure({})).toBe(false);
  });
});

describe("fallbackUnlessUnreachable", () => {
  it("returns the fallback when the chain gave a real answer", () => {
    expect(fallbackUnlessUnreachable(new Error("Account does not exist"), false)).toBe(
      false,
    );
  });

  it("re-throws when the chain never answered", () => {
    // The point: an error the user can see, instead of a confident wrong
    // answer they cannot.
    expect(() =>
      fallbackUnlessUnreachable(new TypeError("fetch failed"), false),
    ).toThrow(/fetch failed/);
  });

  it("preserves the original error rather than wrapping it", () => {
    // Whoever reads the console needs the cause, not a re-badged message.
    const original = new Error("connect ECONNREFUSED 127.0.0.1:8899");
    try {
      fallbackUnlessUnreachable(original, false);
      throw new Error("should have re-thrown");
    } catch (e) {
      expect(e).toBe(original);
    }
  });
});
