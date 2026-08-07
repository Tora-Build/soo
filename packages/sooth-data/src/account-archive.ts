// Alchemy's Solana Account Archive — `getAccountInfo` at a historical slot.
//
// ## What this gives us that we could not get before
//
// The state of any account at any past slot, and the ability to walk an
// account's writes forward or backward. That removes a whole class of work:
//
//   - **price history**. `AmmState.q_yes / q_no / b` at a series of slots IS
//     the LMSR price over time. Previously that meant either indexing every
//     trade or having no chart at all.
//   - **point-in-time answers**. "What did the book look like when this
//     happened" stops being a question only an index can answer.
//   - **cheap backfill of STATE**, without replaying transactions.
//
// It also fixes the retention problem for accounts specifically: a public
// validator prunes, and this does not.
//
// ## Why it does NOT replace the event indexer
//
// The archive is captured **per slot, not per transaction**. If two
// transactions write the book in the same slot, only the final state is
// stored; the intermediate one is gone.
//
// Our fills are per transaction, and several fills can live inside one:
//
//     FILL 25@530  maker=X taker=Y
//     FILL  5@545  maker=Z taker=Y     <- one transaction, one account write
//
// A state diff across that write shows an order gone, another reduced, and
// three seats changed. It cannot say which maker traded with whom at which
// price, and on a busy market — two transactions in one slot — it cannot even
// see that the first fill happened. Fees are not in the account at all; they
// move to the fee pool. Timestamps are in the event.
//
// So: state diffs answer "what is it now / what was it then". Events answer
// "what happened, to whom, at what price". A trade history needs the second,
// and no amount of account archival produces it.
//
// The right split is to use both — archive for state and charts, the event
// index for history — which is what this module exists to enable.

/** JSON-RPC transport, narrowed so tests need no network. */
export type RpcCall = (
  method: string,
  params: unknown[],
) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;

export function httpRpc(url: string): RpcCall {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) {
      throw new Error(`rpc ${method}: HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  };
}

/** Exactly one of these selects the historical read; omitting all reads live. */
export type ArchiveAt =
  | { slot: number }
  | { lastUpdateBeforeSlot: number }
  | { firstUpdateAfterSlot: number }
  | Record<string, never>;

export interface ArchiveAccount {
  /** Raw account data. */
  data: Buffer;
  owner: string;
  lamports: number;
  /** The slot the returned write actually happened at, when the RPC says. */
  slot: number | null;
}

/**
 * `getAccountInfo`, optionally at a past slot.
 *
 * Historical reads require `finalized`, which the archive documents and which
 * this sends explicitly rather than relying on a default that a caller might
 * have overridden.
 *
 * Returns null for an account that did not exist at that slot — which is a
 * real answer, not an error, and is how a caller learns when a market was
 * created.
 */
export async function getAccountAt(
  rpc: RpcCall,
  address: string,
  at: ArchiveAt = {},
): Promise<ArchiveAccount | null> {
  const historical = Object.keys(at).length > 0;
  const config: Record<string, unknown> = { encoding: "base64" };
  if (historical) {
    Object.assign(config, at);
    // The archive rejects `processed`/`confirmed` alongside a historical
    // parameter. Sending it explicitly turns a silent default change into a
    // request that either works or fails loudly.
    config.commitment = "finalized";
  }

  const { result, error } = await rpc("getAccountInfo", [address, config]);
  if (error) {
    // A node without the archive answers this way. Worth distinguishing,
    // because the fix is "point at a provider that has it", not "retry".
    if (historical && /unsupported|unknown field|invalid param/i.test(error.message)) {
      throw new ArchiveUnsupportedError(error.message);
    }
    throw new Error(`getAccountInfo: ${error.message}`);
  }

  const r = result as
    | { value?: { data?: [string, string]; owner?: string; lamports?: number }; context?: { slot?: number } }
    | null;
  if (!r?.value) return null;
  const [b64] = r.value.data ?? [""];
  return {
    data: Buffer.from(b64, "base64"),
    owner: r.value.owner ?? "",
    lamports: r.value.lamports ?? 0,
    slot: r.context?.slot ?? null,
  };
}

export class ArchiveUnsupportedError extends Error {
  constructor(message: string) {
    super(`account archive not available on this RPC: ${message}`);
    this.name = "ArchiveUnsupportedError";
  }
}

/**
 * Walk an account's writes forward from `fromSlot`.
 *
 * `firstUpdateAfterSlot` returns the next write strictly after a slot, so
 * chaining it visits every state the account passed through — one request per
 * CHANGE rather than one per slot, which is what makes this affordable for a
 * chart over a long window.
 *
 * Stops at `maxSteps` and returns what it has, so a caller controls the cost
 * rather than discovering it. A market that has traded thousands of times has
 * thousands of writes, and nobody wants all of them for a sparkline.
 */
export async function walkWrites(
  rpc: RpcCall,
  address: string,
  fromSlot: number,
  maxSteps = 100,
): Promise<ArchiveAccount[]> {
  const out: ArchiveAccount[] = [];
  let cursor = fromSlot;
  for (let i = 0; i < maxSteps; i += 1) {
    const next = await getAccountAt(rpc, address, { firstUpdateAfterSlot: cursor });
    if (!next) break;
    // Without a slot there is nothing to advance past, and continuing would
    // request the same write forever.
    if (next.slot === null || next.slot <= cursor) break;
    out.push(next);
    cursor = next.slot;
  }
  return out;
}
