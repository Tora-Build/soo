// The subject of a question decides its icon — not the order of this
// module's rule list, which is how "Solana … than Ethereum" once drew
// Ethereum's logo.
import { describe, expect, it } from "vitest";

import { localIconFor } from "../src/lib/localIcon";

describe("localIconFor picks the question's SUBJECT", () => {
  it("names the first-mentioned entity when two compete", () => {
    expect(
      localIconFor("Will Solana process more daily transactions than Ethereum in 2027?")?.emoji,
    ).toBe("◎");
    expect(
      localIconFor("Will Ethereum flip Solana by 2027?")?.emoji,
    ).toBe("Ξ");
  });

  it("gives each named coin its own logo — never Bitcoin by default", () => {
    expect(localIconFor("Will SOL reach $500?")?.imageUrl).toContain("solana");
    expect(localIconFor("Will ETH close above 10000?")?.imageUrl).toContain("ethereum");
    expect(localIconFor("Will BTC be above 100k?")?.imageUrl).toContain("bitcoin");
    expect(localIconFor("Will DOGE moon?")?.imageUrl).toContain("dogecoin");
  });

  it("prefers a named entity over a topic word that appears earlier", () => {
    // "price" is a topic and comes first; the market is about Solana.
    expect(localIconFor("Will the price of Solana double?")?.emoji).toBe("◎");
  });

  it("falls back to a topic icon only when nothing is named", () => {
    expect(localIconFor("Will it rain in Berlin on Saturday?")?.emoji).toBe("🌧️");
    expect(localIconFor("Will any crypto token 10x this year?")?.emoji).toBe("🪙");
  });

  it("returns null for a question it cannot place", () => {
    expect(localIconFor("Will Zorblax the Unknowable appear?")).toBeNull();
    expect(localIconFor("")).toBeNull();
  });
});

describe("every automatic icon is a real image", () => {
  it("resolves a picture for every rule it matches — emoji is only a fallback", () => {
    const questions = [
      "Will BTC pass 100k?",
      "Will Solana flip Ethereum?",
      "Will Tesla deliver 2m cars?",
      "Will it rain in Berlin?",
      "Who wins the championship?",
      "Will the election be close?",
      "Will SpaceX launch Starship?",
      "Will inflation fall below 2%?",
    ];
    for (const q of questions) {
      const icon = localIconFor(q);
      expect(icon, q).not.toBeNull();
      expect(icon!.imageUrl, q).toMatch(/^https:\/\//);
    }
  });

  it("uses coin logos for coins and brand marks for brands", () => {
    expect(localIconFor("Will SOL reach $500?")!.imageUrl).toContain("coingecko");
    expect(localIconFor("Will Tesla deliver 2m cars?")!.imageUrl).toContain("simpleicons");
  });

  it("renders concepts through Twemoji rather than the OS font", () => {
    // ⚽ is U+26BD — the filename Twemoji publishes.
    expect(localIconFor("Who wins the soccer final?")!.imageUrl).toContain("26bd");
  });
});
