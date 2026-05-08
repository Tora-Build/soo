// Surfpool cheatcode helpers for e2e specs.
//
// Surfpool exposes a `surfnet_*` JSON-RPC namespace that lets specs warp
// the cluster clock, pause slot advancement, and reset every account to
// initial state — capabilities solana-test-validator does NOT expose. We
// use that to drive specs gated on the 24h sell-lock and the
// post-deadline trading window.
//
// Detection is via `surfnet_getSurfnetInfo`: if it returns a `result`,
// the cluster is Surfpool; if it errors with -32601 (method not found),
// it's stock test-validator. Spec files use `isSurfpool()` to gate
// describe blocks via `test.skip()`.
//
// All helpers throw on RPC failure rather than swallowing — silent
// failures here would cause specs to assert against the wrong clock,
// which is a worse failure mode than a crash.

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";

interface JsonRpcOk<T> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}
interface JsonRpcErr {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string };
}
type JsonRpcResp<T> = JsonRpcOk<T> | JsonRpcErr;

async function rpc<T = unknown>(
  method: string,
  params: unknown[],
): Promise<JsonRpcResp<T>> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC ${method}: HTTP ${res.status}`);
  }
  return (await res.json()) as JsonRpcResp<T>;
}

let cachedDetection: boolean | undefined;

/**
 * True when the active RPC is Surfpool — cached after the first probe so
 * suite-wide describe gates don't pay the round-trip per spec.
 */
export async function isSurfpool(): Promise<boolean> {
  if (cachedDetection !== undefined) return cachedDetection;
  const resp = await rpc("surfnet_getSurfnetInfo", []);
  cachedDetection = "result" in resp;
  return cachedDetection;
}

/**
 * Fast-forward the cluster's Clock sysvar by `seconds`. Bridges the
 * `LOCK_DURATION_SECS = 86_400` gate on `claim_unlocked` and the
 * `Market.deadline` cutoff on `trade_positions`.
 *
 * Reads the current on-chain Clock.unix_timestamp and jumps to
 * (current + seconds), so it works even when prior calls (within the
 * same or earlier runs) already advanced the clock past wall-clock.
 * Without this, a second `timeTravel(60)` after the chain is already
 * 7 days in the future would compute target = wall + 60s, which is
 * < current_on_chain → "Cannot travel to past timestamp" Internal error.
 *
 * NOTE: surfnet_timeTravel's `absoluteTimestamp` is in MILLISECONDS;
 * the on-chain Clock.unix_timestamp is seconds. Surfpool converts
 * internally.
 */
export async function timeTravel(seconds: number): Promise<void> {
  const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";
  const acc = await rpc<{
    value: { data: [string, string] } | null;
  }>("getAccountInfo", [SYSVAR_CLOCK, { encoding: "base64" }]);
  if ("error" in acc || !acc.result?.value) {
    throw new Error("timeTravel: failed to read Clock sysvar");
  }
  const data = Buffer.from(acc.result.value.data[0], "base64");
  // Clock layout: slot u64 @ 0, epoch_start_ts i64 @ 8, epoch u64 @ 16,
  //               leader_schedule_epoch u64 @ 24, unix_timestamp i64 @ 32
  const onChainSecs = Number(data.readBigInt64LE(32));
  const targetSecs = onChainSecs + seconds;
  const targetMs = targetSecs * 1000;
  const resp = await rpc("surfnet_timeTravel", [
    { absoluteTimestamp: targetMs },
  ]);
  if ("error" in resp) {
    throw new Error(`surfnet_timeTravel failed: ${resp.error.message}`);
  }
}

/**
 * Jump the cluster clock to an absolute UNIX timestamp (seconds). Throws
 * if the target is before the current on-chain time — surfnet_timeTravel
 * doesn't support reverse travel.
 */
export async function timeTravelToTimestamp(
  secondsSinceEpoch: number,
): Promise<void> {
  const targetMs = Math.floor(secondsSinceEpoch) * 1000;
  const resp = await rpc("surfnet_timeTravel", [
    { absoluteTimestamp: targetMs },
  ]);
  if ("error" in resp) {
    throw new Error(`surfnet_timeTravel failed: ${resp.error.message}`);
  }
}

/** Jump the cluster clock to an absolute slot. */
export async function timeTravelToSlot(slot: number): Promise<void> {
  const resp = await rpc("surfnet_timeTravel", [{ absoluteSlot: slot }]);
  if ("error" in resp) {
    throw new Error(`surfnet_timeTravel(slot) failed: ${resp.error.message}`);
  }
}

/** Freeze slot advancement. */
export async function pauseClock(): Promise<void> {
  const resp = await rpc("surfnet_pauseClock", []);
  if ("error" in resp) {
    throw new Error(`surfnet_pauseClock failed: ${resp.error.message}`);
  }
}

/** Resume slot advancement. */
export async function resumeClock(): Promise<void> {
  const resp = await rpc("surfnet_resumeClock", []);
  if ("error" in resp) {
    throw new Error(`surfnet_resumeClock failed: ${resp.error.message}`);
  }
}

/**
 * Reset every account to its initial state. Use sparingly — drops the
 * seeded market, USDC mint, and any positions. Most specs prefer
 * `timeTravel` over `resetNetwork` since reset invalidates the global
 * fixture (`globalSetup` only runs once per `playwright test` invocation).
 */
export async function resetNetwork(): Promise<void> {
  const resp = await rpc("surfnet_resetNetwork", []);
  if ("error" in resp) {
    throw new Error(`surfnet_resetNetwork failed: ${resp.error.message}`);
  }
  cachedDetection = undefined;
}
