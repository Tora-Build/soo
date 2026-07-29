import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/index.js";

describe("health/status endpoints", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns api health", async () => {
    const app = createApp({
      connection: { getSlot: async () => 123 },
    });

    const resp = await app.request("/api-health");

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  it("returns localnet chain status keyed by demo chain name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-05-18T00:00:00.000Z"));
    const app = createApp({
      connection: { getSlot: async () => 1234 },
    });

    const resp = await app.request("/status");

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      solanaLocalnet: {
        id: 902,
        block: { number: 1234, timestamp: 1_715_990_400 },
      },
    });
  });

  it("binds the runtime connection getSlot method", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-05-18T00:00:00.000Z"));
    const connection = {
      slot: 5678,
      async getSlot(this: { slot: number }) {
        return this.slot;
      },
    };
    const app = createApp({
      connection,
    });

    const resp = await app.request("/status");

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      solanaLocalnet: {
        id: 902,
        block: { number: 5678, timestamp: 1_715_990_400 },
      },
    });
  });

  it("falls back to a ready localnet slot when RPC slot lookup fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-05-18T00:00:00.000Z"));
    const app = createApp({
      connection: { getSlot: async () => Promise.reject(new Error("rpc down")) },
    });

    const resp = await app.request("/status");

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      solanaLocalnet: {
        id: 902,
        block: { number: 1001, timestamp: 1_715_990_400 },
      },
    });
  });
});
