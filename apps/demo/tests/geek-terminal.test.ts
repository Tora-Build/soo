// The Geek terminal, without a chain.
//
// Everything here must hold before a single RPC is made: parsing, the seeded
// PRNG, market selection, and the honest failures a disconnected SDK returns.
// The commands that DO touch the chain go through the same dispatchers the
// rest of the app already tests.

import { describe, expect, it } from "vitest";
import { SoothSDK } from "../src/lib/sdk";

const bare = () => new SoothSDK(0, null, null, null);

describe("Geek terminal command parsing", () => {
  it("help lists the working set, including simulate and graduate", async () => {
    const { output } = await bare().executeCommand("help");
    const text = output.map((l) => l.text).join("\n");
    for (const cmd of ["simulate", "graduate", "createmarket", "setmarket", "sell", "place", "cancelorder", "settle", "resolution", "lock", "attest", "register", "actors"]) {
      expect(text).toContain(cmd);
    }
  });

  it("unknown commands fail loudly, not silently", async () => {
    const r = await bare().executeCommand("frobnicate");
    expect(r.result.success).toBe(false);
    expect(r.output[0]!.text).toContain("frobnicate");
  });

  it("every chain command without a wallet fails with a reason, never throws", async () => {
    for (const cmd of [
      "balance", "marketstatus", "markets", "buyyes 5", "sell 5",
      "book", "orders", "place bid 450 25", "cancelorder 3",
      "settle", "redeem", "claimrefund", "dismiss", "redeemlp", "lpbalance",
      "simulate 5", "graduate", "resolution", "lock", "attest yes", "register",
      "actors fund 0.05 100",
    ]) {
      const r = await bare().executeCommand(cmd);
      expect(r.result.success, cmd).toBe(false);
      expect(r.output.length, cmd).toBeGreaterThan(0);
    }
  });

  it("setmarket accepts a base58 pubkey and rejects junk", async () => {
    const sdk = bare();
    const ok = await sdk.executeCommand(
      "setmarket 2LSY2xGyd8ibsxyJioyVmBFgiF5FtJHqKnDNswvqSsZF",
    );
    expect(ok.result.success).toBe(true);
    expect(sdk.getMarketInfo().marketKey).toBe(
      "2LSY2xGyd8ibsxyJioyVmBFgiF5FtJHqKnDNswvqSsZF",
    );
    const bad = await sdk.executeCommand("setmarket not-a-pubkey");
    expect(bad.result.success).toBe(false);
    // A failed setmarket must not clobber the working selection.
    expect(sdk.getMarketInfo().marketKey).toBe(
      "2LSY2xGyd8ibsxyJioyVmBFgiF5FtJHqKnDNswvqSsZF",
    );
  });

  it("place validates side and the 1-999 tick range before any dispatch", async () => {
    const sdk = bare();
    await sdk.executeCommand("setmarket 2LSY2xGyd8ibsxyJioyVmBFgiF5FtJHqKnDNswvqSsZF");
    for (const cmd of ["place sideways 450 25", "place bid 0 25", "place bid 1000 25", "place bid 450 xyz"]) {
      const r = await sdk.executeCommand(cmd);
      expect(r.output[0]!.text, cmd).toContain("Usage");
    }
  });

  it("createmarket refuses a question shorter than the form would accept", async () => {
    const r = await bare().executeCommand("createmarket too short");
    expect(r.result.success).toBe(false);
    expect(r.output[0]!.text).toContain("Usage");
  });

  it("attest validates the outcome word before any dispatch", async () => {
    const sdk = bare();
    await sdk.executeCommand("setmarket 2LSY2xGyd8ibsxyJioyVmBFgiF5FtJHqKnDNswvqSsZF");
    const r = await sdk.executeCommand("attest maybe");
    expect(r.output[0]!.text).toContain("Usage");
  });

  it("approve explains Solana instead of pretending to approve", async () => {
    const r = await bare().executeCommand("approve");
    expect(r.output[0]!.text).toContain("allowance");
  });
});

describe("history", () => {
  it("with no wallet points at the two ways to name one", async () => {
    const r = await bare().executeCommand("history");
    expect(r.result.success).toBe(false);
    expect(r.output[0]!.text).toContain("history a3");
  });

  it("refuses an actor index outside the fleet", async () => {
    const r = await bare().executeCommand("history a7");
    expect(r.result.success).toBe(false);
    expect(r.output[0]!.text).toContain("fleet has");
  });
});

describe("plan parsing", () => {
  it("refuses rows before a fleet exists, naming the fix", async () => {
    const r = await bare().executeCommand("plan a0 buy yes 10");
    expect(r.result.success).toBe(false);
    expect(r.output[0]!.text).toContain("actors create");
  });

  it("bare plan explains itself instead of erroring", async () => {
    const r = await bare().executeCommand("plan");
    expect(r.result.success).toBe(true);
    expect(r.output[0]!.text).toContain("plan a0 buy yes 10");
  });

  it("clear is safe on an empty plan", async () => {
    const r = await bare().executeCommand("plan clear");
    expect(r.result.success).toBe(true);
  });
});
