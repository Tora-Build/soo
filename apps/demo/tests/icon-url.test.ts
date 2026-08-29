// The icon link shares the question's 300-byte on-chain budget, so its
// rules are a creation-time contract, not cosmetics: a link that passes
// here must survive the program's MAX_QUESTION_LEN, and one that fails
// must say why while the creator can still fix it.
import { describe, expect, it } from "vitest";

import { iconUrlIssue, sqfByteLength, MAX_QUESTION_BYTES } from "../src/lib/iconUrl";
import { parseSQF, generateSQF } from "../src/lib/sqf";

describe("iconUrlIssue", () => {
  it("accepts an https image link and an empty field", () => {
    expect(iconUrlIssue("https://example.com/logo.png")).toBeNull();
    expect(iconUrlIssue("")).toBeNull();
    expect(iconUrlIssue("   ")).toBeNull();
  });

  it("refuses http and other schemes — mixed content breaks the tile", () => {
    expect(iconUrlIssue("http://example.com/logo.png")).toMatch(/https/i);
    expect(iconUrlIssue("ftp://example.com/logo.png")).toMatch(/https/i);
    expect(iconUrlIssue("javascript:alert(1)")).toMatch(/https/i);
  });

  it("refuses a link that would eat the question's budget", () => {
    expect(iconUrlIssue(`https://example.com/${"x".repeat(220)}.png`)).toMatch(
      /too long/i,
    );
  });
});

describe("the on-chain budget meter", () => {
  it("counts question, icon and envelope together", () => {
    const withIcon = sqfByteLength("Will BTC pass 100k?", "https://e.com/b.png");
    const without = sqfByteLength("Will BTC pass 100k?", "");
    expect(withIcon).toBeGreaterThan(without);
    expect(without).toBeLessThan(MAX_QUESTION_BYTES);
  });

  it("flags a combination the program would reject", () => {
    const long = "Will ".repeat(50);
    expect(sqfByteLength(long, "https://example.com/logo.png")).toBeGreaterThan(
      MAX_QUESTION_BYTES,
    );
  });
});

describe("SQF carries the link", () => {
  it("round-trips an https icon", () => {
    const raw = generateSQF({
      question: "Will SOL flip ETH?",
      icon: "https://example.com/sol.png",
      rule: {},
    });
    expect(parseSQF(raw).icon).toBe("https://example.com/sol.png");
  });

  it("still reads a legacy emoji icon from older markets", () => {
    expect(parseSQF("§question\nQ?\n§icon\n◎").icon).toBe("◎");
  });

  it("discards a non-https or over-long icon rather than truncating it", () => {
    expect(parseSQF("§question\nQ?\n§icon\nhttp://e.com/x.png").icon).toBeUndefined();
    expect(
      parseSQF(`§question\nQ?\n§icon\nhttps://e.com/${"x".repeat(220)}.png`).icon,
    ).toBeUndefined();
  });
});
