// JSON-RPC pass-through so the browser bundle never carries the RPC key.
//
// The site calls this Worker; the Worker calls the real endpoint with the
// key held server-side as a secret. Only JSON-RPC POSTs and the CORS
// preflight are served — anything else is refused, so the proxy cannot be
// used to reach arbitrary paths on the upstream host.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, solana-client",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "POST") {
      return new Response("POST JSON-RPC only", { status: 405, headers: CORS });
    }
    const upstream = await fetch(env.UPSTREAM_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", ...CORS },
    });
  },
};
