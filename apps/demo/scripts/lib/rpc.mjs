// One place to build a Connection, so the HTTP and WebSocket endpoints can
// differ.
//
// They have to on devnet. `confirmTransaction` subscribes via `signatureSubscribe`
// over the WebSocket, and web3.js derives that URL from the HTTP one by
// swapping the scheme — which is right for a validator and wrong for a
// provider that serves RPC but not subscriptions. Alchemy's devnet endpoint
// answers `getSlot` fine and returns
//
//     Method 'slotSubscribe' not found   (-32601)
//
// for anything subscription-based on this key. The failure does not surface as
// "no websocket": every confirm retries the subscribe, so a seed run degrades
// into a wall of JSON-RPC errors that still looks like it is making progress.
//
// So: HTTP through the provider (rate limits are the reason for using one at
// all — seeding a graduated market drives thousands of USDC of volume), and
// the subscription channel pointed at a plain validator, which is cheap
// because confirms are all it carries.
//
//   SOLANA_RPC_URL=https://solana-devnet.g.alchemy.com/v2/KEY \
//   SOLANA_WS_URL=wss://api.devnet.solana.com/ \
//     node scripts/seed-localnet.mjs init
//
// Unset `SOLANA_WS_URL` and this behaves exactly as `new Connection(url)` did.

import { Connection } from "@solana/web3.js";

export const DEFAULT_RPC = "http://127.0.0.1:8899";

/**
 * The RPC URL these scripts should use, honouring `SOLANA_RPC_URL`.
 */
export function rpcUrl(fallback = DEFAULT_RPC) {
  return process.env.SOLANA_RPC_URL ?? fallback;
}

/**
 * A Connection whose subscription channel can be pointed elsewhere.
 *
 * Passing `wsEndpoint: undefined` is not the same as omitting it in some
 * web3.js versions, so the key is only added when there is a value for it.
 */
export function connect(url = rpcUrl(), commitment = "confirmed") {
  const ws = process.env.SOLANA_WS_URL;
  return new Connection(url, ws ? { commitment, wsEndpoint: ws } : commitment);
}
