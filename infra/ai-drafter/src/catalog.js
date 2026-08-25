// Endpoints this repo has actually fetched, offered to the model as a starting
// point rather than left to recall.
//
// The measured failure mode of drafting is not bad judgement about WHICH number
// answers a question — the model is good at that — it is naming a host that no
// longer exists or a field that never did. Those proposals die in the validator
// and cost a whole extra round trip to the model, which matters because the
// free tier is counted in requests per day, not tokens.
//
// So this list trades a few hundred prompt tokens, which are cheap and
// uncapped, against retries, which are neither. Every entry below was fetched
// and parsed by scripts against the live endpoint before being added; none is
// here on recall.
//
// It is a PREFERENCE, never a whitelist. A question these do not answer must
// still get the model's own proposal, and every candidate — catalogued or not —
// is fetched and validated before it reaches a creator. Nothing here is
// trusted; it is only suggested.

export const CATALOG = [
  { category: "crypto", url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", parsePath: "$.data.amount", what: "Coinbase spot BTC/USD" },
  { category: "crypto", url: "https://api.coinbase.com/v2/prices/ETH-USD/spot", parsePath: "$.data.amount", what: "Coinbase spot ETH/USD (any -USD pair works)" },
  { category: "crypto", url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", parsePath: "$.price", what: "Binance ticker (any symbol)" },
  { category: "crypto", url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", parsePath: "$.result.XXBTZUSD.c[0]", what: "Kraken last trade" },
  { category: "crypto", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", parsePath: "$.bitcoin.usd", what: "CoinGecko price by coin id" },
  { category: "crypto", url: "https://mempool.space/api/blocks/tip/height", parsePath: "$", what: "Bitcoin block height" },
  { category: "weather", url: "https://api.open-meteo.com/v1/forecast?latitude=13.75&longitude=100.5&current=temperature_2m", parsePath: "$.current.temperature_2m", what: "Open-Meteo current temperature at any lat/long" },
  { category: "weather", url: "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&daily=precipitation_sum&forecast_days=1&timezone=UTC", parsePath: "$.daily.precipitation_sum[0]", what: "Open-Meteo daily rainfall at any lat/long" },
  { category: "tech", url: "https://api.github.com/repos/solana-labs/solana", parsePath: "$.stargazers_count", what: "GitHub stars for any owner/repo" },
  { category: "tech", url: "https://api.npmjs.org/downloads/point/last-week/react", parsePath: "$.downloads", what: "npm downloads for any package" },
  { category: "others", url: "https://open.er-api.com/v6/latest/USD", parsePath: "$.rates.JPY", what: "Exchange rate, any base and quote" },
  { category: "others", url: "https://api.frankfurter.app/latest?from=USD&to=EUR", parsePath: "$.rates.EUR", what: "ECB reference rate" },
  { category: "others", url: "https://api.wheretheiss.at/v1/satellites/25544", parsePath: "$.altitude", what: "ISS altitude in km" },
];

/**
 * The catalog as prompt lines.
 *
 * Whole, not filtered by category: the category is inferred in a call that runs
 * in PARALLEL with this one, so filtering would mean serialising the two and
 * paying the latency to save a few hundred tokens that cost nothing.
 */
export function catalogLines() {
  return CATALOG.map((e) => `  ${e.url}  ->  ${e.parsePath}   (${e.what})`);
}


/**
 * Keyword routing for the model-less fallback.
 *
 * When the model is unreachable — observed live: Gemini accepting TLS and
 * never answering, from Cloudflare's egress specifically — drafting must not
 * die with it. Every entry here has been fetched and parsed by this repo, so
 * matching a question's tokens against a small keyword map and validating
 * the winners exactly like model proposals gives real, verified candidates
 * with zero model involvement. Cruder than the model (no exotic endpoints,
 * no threshold nuance) and honest about it: the caller labels the result as
 * catalog-drafted.
 */
const KEYWORDS = [
  { match: /\b(btc|bitcoin)\b/i, urls: ["api.coinbase.com/v2/prices/BTC-USD", "api.binance.com", "api.kraken.com"], category: "crypto" },
  { match: /\b(eth|ethereum)\b/i, urls: ["ETH-USD"], category: "crypto" },
  { match: /\b(iss|space station)\b/i, urls: ["wheretheiss"], category: "tech" },
  { match: /\b(rain|temperature|weather|hot|cold)\b/i, urls: ["open-meteo"], category: "weather" },
  { match: /\b(jpy|yen|eur|euro|exchange rate)\b/i, urls: ["er-api", "frankfurter"], category: "others" },
  { match: /\bblock height\b/i, urls: ["mempool.space"], category: "crypto" },
  { match: /\bnpm|downloads\b/i, urls: ["npmjs"], category: "tech" },
  { match: /\bgithub|stars\b/i, urls: ["api.github.com"], category: "tech" },
];

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const MONTH_END = { 1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 };

/**
 * A deadline out of the question text, as YYYY-MM-DD, or null.
 *
 * Three shapes, most-specific first: an ISO date verbatim; a month name with
 * an optional year ("by March 2026" -> that month's last day); a bare year
 * ("by 2026" -> its December 31). "By <when>" means "any time up to the end
 * of <when>", so an under-specified date always rounds to the period's END —
 * rounding down would close the market before the question's own window.
 */
export function deadlineFromQuestion(question, nowMs = 0) {
  const iso = /\b(20\d\d)-(\d{2})-(\d{2})\b/.exec(question);
  if (iso) return iso[0];
  const monthRe = new RegExp(`\\b(${MONTHS})\\.?\\s*,?\\s*(20\\d\\d)?\\b`, "i");
  const m = monthRe.exec(question);
  const yearMatch = /\b(20\d\d)\b/.exec(question);
  if (m) {
    const month = MONTHS.split("|").indexOf(m[1].toLowerCase()) + 1;
    const now = new Date(nowMs || 0);
    const year = m[2]
      ? Number(m[2])
      : nowMs
        ? now.getUTCFullYear() + (month < now.getUTCMonth() + 1 ? 1 : 0)
        : null;
    if (year) return `${year}-${String(month).padStart(2, "0")}-${MONTH_END[month]}`;
  }
  if (yearMatch) return `${yearMatch[1]}-12-31`;
  return null;
}

/**
 * The polish block the model would have produced, minus the one thing only a
 * model can do (rewording). Rides with catalog-fallback candidates so a
 * Gemini outage costs the creator the rephrase, not ALSO the category and
 * the deadline their own sentence already states.
 */
export function heuristicPolish(question, nowMs = 0) {
  const rule = KEYWORDS.find((k) => k.match.test(question));
  const deadline = deadlineFromQuestion(question, nowMs);
  return {
    polished: question,
    changed: false,
    notes: null,
    category: rule?.category ?? null,
    deadline,
    resolvable: true,
  };
}

/** A plain number out of the question — "$70,000", "70k", "0.85". */
export function thresholdFromQuestion(question) {
  const m = /\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?\b/i.exec(question.replace(/\b20\d\d\b/g, ""));
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2]?.toLowerCase() === "k") n *= 1_000;
  if (m[2]?.toLowerCase() === "m") n *= 1_000_000;
  return String(n);
}

/** Catalog entries whose subject plausibly matches the question. */
export function catalogFallbackProposals(question) {
  const rule = KEYWORDS.find((k) => k.match.test(question));
  if (!rule) return [];
  const threshold = thresholdFromQuestion(question);
  if (!threshold) return [];
  const below = /\b(below|under|less than|fall|drop)\b/i.test(question);
  return CATALOG.filter((e) => rule.urls.some((frag) => e.url.includes(frag)))
    .slice(0, 3)
    .map((e) => ({
      url: e.url,
      parsePath: e.parsePath,
      comparator: below ? "lte" : "gte",
      threshold,
      valueScale: 8,
      confidence: 0.5,
      rationale: `Catalog fallback: resolves ${below ? "YES if at or below" : "YES if at or above"} ${threshold} on ${new URL(e.url).host} (drafting model was unreachable).`,
    }));
}
