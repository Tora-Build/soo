// zk-resolver pass-through so the browser bundle never carries the token.
//
// Every preview spends a unit of real Primus quota, so the resolver requires
// a shared bearer token. That token cannot live in the Forge: the app reads
// its config through Vite, and a `VITE_` variable is compiled into the public
// JS — publishing the credential to anyone who opens devtools. The site calls
// this Worker instead; the Worker attaches the token server-side.
//
// Only the two routes the Forge actually uses are proxied. An open path
// forwarder would let anyone reach arbitrary paths on the upstream host with
// our credentials attached, which is a worse hole than the one being closed.

const ALLOWED_PATHS = new Set(["/attest-preview", "/register"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const { pathname } = new URL(request.url);
    if (!ALLOWED_PATHS.has(pathname)) {
      return json(404, { ok: false, reason: "not_found", detail: `no route ${pathname}` });
    }
    if (request.method !== "POST") {
      return json(405, { ok: false, reason: "method_not_allowed", detail: `POST ${pathname}` });
    }
    if (!env.RESOLVER_API_TOKEN || !env.UPSTREAM_RESOLVER) {
      // Say so rather than forwarding an unauthenticated request that the
      // upstream would reject with a confusing 401.
      return json(503, {
        ok: false,
        reason: "misconfigured",
        detail: "worker is missing RESOLVER_API_TOKEN or UPSTREAM_RESOLVER",
      });
    }

    const upstream = await fetch(`${env.UPSTREAM_RESOLVER}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RESOLVER_API_TOKEN}`,
      },
      body: request.body,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", ...CORS },
    });
  },
};
