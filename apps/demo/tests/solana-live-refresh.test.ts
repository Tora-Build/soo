// Push-based freshness.
//
// Upstream's live updates all hang off EVM events, and the chain-shim's
// `useWatchContractEvent` is a no-op, so nothing invalidates on an event.
// Without this hook the app runs on polling alone: a trade lands on-chain and
// the page stays stale until the next interval.
//
// What is tested here is the part with teeth. Subscriptions leak if the effect
// re-runs on array identity, and a debounce that resets wrongly either storms
// or never fires.

import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";

import { normalizeAccounts } from "../src/lib/useSolanaLiveRefresh";

const A = Keypair.generate().publicKey;
const B = Keypair.generate().publicKey;

describe("normalizeAccounts", () => {
  it("accepts PublicKey and string alike", () => {
    expect(normalizeAccounts([A, B.toBase58()])).toEqual(
      [A.toBase58(), B.toBase58()].sort(),
    );
  });

  it("strips the sol: ref prefix", () => {
    // Market refs are carried as `sol:<pubkey>` throughout the demo, so the
    // raw form would be subscribed as a malformed key and silently dropped.
    expect(normalizeAccounts([`sol:${A.toBase58()}`])).toEqual([A.toBase58()]);
  });

  it("drops nulls rather than subscribing to them", () => {
    expect(normalizeAccounts([null, undefined, "", A])).toEqual([A.toBase58()]);
  });

  it("de-duplicates, so one account is watched once", () => {
    // The same market can arrive as both the default and an extra ref. Two
    // subscriptions on one account means two invalidations per change.
    expect(
      normalizeAccounts([A, A.toBase58(), `sol:${A.toBase58()}`]),
    ).toEqual([A.toBase58()]);
  });

  it("is order-independent", () => {
    // The effect keys on the joined string. Without sorting, a caller
    // rebuilding the list in a different order would tear down and rebuild
    // every subscription on a render that changed nothing.
    expect(normalizeAccounts([A, B])).toEqual(normalizeAccounts([B, A]));
  });

  it("is stable across repeated calls with equal input", () => {
    expect(normalizeAccounts([A, B]).join(",")).toBe(
      normalizeAccounts([B.toBase58(), `sol:${A.toBase58()}`]).join(","),
    );
  });
});
