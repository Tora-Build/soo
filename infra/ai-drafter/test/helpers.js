// Stubs standing in for the two things this Worker does not own: the model and
// the network. Both are injected, so the validation path is fully exercised
// with no Gemini key and no live endpoint.

/** A `fetch` over a fixed routing table. Anything unrouted 404s, like a wrong URL would. */
export function stubFetch(routes) {
  return async (url) => {
    const route = routes[String(url)];
    if (!route) return new Response("not found", { status: 404 });
    if (typeof route === "function") return route();
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
}

/** A model that replays scripted turns and records the feedback it was given. */
export function stubModel(turns) {
  const calls = [];
  let i = 0;
  return {
    calls,
    propose(args) {
      calls.push(args);
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      if (turn instanceof Error) throw turn;
      return Promise.resolve(turn);
    },
  };
}

/** A well-formed proposal; each test breaks exactly one field of it. */
export const goodProposal = {
  url: "https://feed.example/v2/prices/BTC-USD/spot",
  parsePath: "$.data.amount",
  comparator: "gt",
  threshold: "90000",
  valueScale: 8,
  confidence: 0.9,
  rationale: "resolves YES if spot BTC/USD is above 90,000 at the deadline",
};
