// The form must not open holding a rule nobody chose.
//
// "Prove with Primus" attests whatever is in the fields. With the BTC preset
// preloaded, a creator who asked about anything else and pressed Prove got a
// real, correctly-signed attestation of the price of Bitcoin — which is why
// proving looked static: it was always attesting the same phantom rule.

import { describe, expect, it } from "vitest";
import {
  initialZkDraft,
  zkDraftError,
} from "../src/components/features/launchpad/zk-rule";

describe("the initial zk rule", () => {
  it("carries no source, so nothing can be proven by accident", () => {
    const d = initialZkDraft();
    expect(d.url).toBe("");
    expect(d.parsePath).toBe("");
    expect(d.threshold).toBe("");
  });

  it("is not launchable until a source is actually chosen", () => {
    expect(zkDraftError(initialZkDraft())).toBe("url");
  });

  it("becomes valid once a real rule is filled in", () => {
    expect(
      zkDraftError({
        ...initialZkDraft(),
        url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
        parsePath: "$.data.amount",
        threshold: "90000",
      }),
    ).toBeNull();
  });
});
