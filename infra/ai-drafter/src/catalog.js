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
// Two endpoints that look catalogable are deliberately absent, and both
// failures are invisible from a laptop:
//
//   api.github.com     — 403 without a User-Agent. curl sends one, Workers do
//                        not. It validated by hand and died in production,
//                        burning all three model attempts on every repo
//                        question. A header would fix the fetch and not the
//                        market: headers are not part of `rule_hash`, so the
//                        committed rule is the bare GET, and the bare GET is
//                        what Primus later replays.
//   api.frankfurter.app — 301 to .dev. The validator follows redirects, so it
//                        passes here; Primus attests the session it opened,
//                        whose body is the redirect, not the rate. The .dev
//                        URL is committed instead.
//
// Where this list came from: the EVM repo's zk-oracle book (188 URL builders
// behind a Worker, 77 of them auth-free). Its adapters are not rules — each one
// is a JS parser that can search an array for a team or a date, and a rule has
// to be one committable path. So every adapter was rebuilt as (url, path),
// fetched with no User-Agent, no redirect following and a 32 KB ceiling, and
// only what survived is here.
//
// What did NOT survive, so nobody re-tries it: every ESPN scoreboard and
// standings payload (157 KB to 6 MB), so SPORTS has no entry at all — a
// scoreboard cannot be attested until Primus can take a response that size.
// Also gone: balldontlie and cryptocompare (401 without a key), Yahoo Finance
// (429 to a bare GET), dawum-polls and federal-register (over 1 MB), and
// coingecko (403).
//
// The rule both cases teach: an entry earns its place by answering a bare,
// header-less, redirect-less GET, because that is the only request the chain
// can be made to trust.

// It is a PREFERENCE, never a whitelist. A question these do not answer must
// still get the model's own proposal, and every candidate — catalogued or not —
// is fetched and validated before it reaches a creator. Nothing here is
// trusted; it is only suggested.

export const CATALOG = [
  // ── crypto ──────────────────────────────────────────────────────────────
  { category: "crypto", url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", parsePath: "$.data.amount", what: "Coinbase spot BTC/USD" },
  { category: "crypto", url: "https://api.coinbase.com/v2/prices/ETH-USD/spot", parsePath: "$.data.amount", what: "Coinbase spot ETH/USD (any -USD pair works)" },
  { category: "crypto", url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", parsePath: "$.result.XXBTZUSD.c[0]", what: "Kraken last trade" },
  { category: "crypto", url: "https://api.gemini.com/v1/pubticker/btcusd", parsePath: "$.last", what: "Gemini last trade (any pair, lowercase)" },
  { category: "crypto", url: "https://api.alternative.me/fng/?limit=1&format=json", parsePath: "$.data[0].value", what: "Crypto Fear & Greed index, 0-100" },
  { category: "crypto", url: "https://mempool.space/api/blocks/tip/height", parsePath: "$", what: "Bitcoin block height" },
  { category: "crypto", url: "https://mempool.space/api/v1/fees/recommended", parsePath: "$.fastestFee", what: "Bitcoin recommended fee, sat/vB (halfHourFee, hourFee, economyFee)" },
  { category: "crypto", url: "https://api.blockchain.info/stats", parsePath: "$.hash_rate", what: "Bitcoin network stats (hash_rate, n_tx, minutes_between_blocks)" },
  { category: "crypto", url: "https://api.llama.fi/tvl/jupiter-perpetual-exchange", parsePath: "$", what: "DefiLlama TVL for any protocol slug — bare number" },

  // ── weather ─────────────────────────────────────────────────────────────
  { category: "weather", url: "https://api.open-meteo.com/v1/forecast?latitude=13.75&longitude=100.5&current=temperature_2m", parsePath: "$.current.temperature_2m", what: "Open-Meteo current temperature at any lat/long" },
  { category: "weather", url: "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&daily=precipitation_sum&forecast_days=1&timezone=UTC", parsePath: "$.daily.precipitation_sum[0]", what: "Open-Meteo daily rainfall at any lat/long" },
  { category: "weather", url: "https://api.open-meteo.com/v1/forecast?latitude=40.71&longitude=-74.01&daily=temperature_2m_max&forecast_days=1&timezone=UTC", parsePath: "$.daily.temperature_2m_max[0]", what: "Open-Meteo daily high at any lat/long" },
  { category: "weather", url: "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=40.71&longitude=-74.01&current=us_aqi", parsePath: "$.current.us_aqi", what: "Open-Meteo US air-quality index at any lat/long" },
  { category: "weather", url: "https://flood-api.open-meteo.com/v1/flood?latitude=40.71&longitude=-74.01&daily=river_discharge&forecast_days=1", parsePath: "$.daily.river_discharge[0]", what: "Open-Meteo river discharge, m3/s, at any lat/long" },
  { category: "weather", url: "https://currentuvindex.com/api/v1/uvi?latitude=40.71&longitude=-74.01", parsePath: "$.now.uvi", what: "Current UV index at any lat/long" },
  { category: "weather", url: "https://aviationweather.gov/api/data/metar?ids=KJFK&format=json", parsePath: "$[0].temp", what: "METAR at any ICAO airport (temp, dewp, wspd, altim)" },

  // ── tech ────────────────────────────────────────────────────────────────
  { category: "tech", url: "https://api.npmjs.org/downloads/point/last-week/react", parsePath: "$.downloads", what: "npm downloads for any package" },
  { category: "tech", url: "https://api.crossref.org/works?rows=0&filter=from-pub-date:2026-01-01", parsePath: "$.message.total-results", what: "Crossref count of published works matching a filter — keep rows=0" },
  { category: "tech", url: "https://tle.ivanstanojevic.me/api/tle/?search=starlink&page_size=1", parsePath: "$.totalItems", what: "Count of catalogued satellites matching a search" },

  // ── others: money, earth, space, health ─────────────────────────────────
  { category: "others", url: "https://open.er-api.com/v6/latest/USD", parsePath: "$.rates.JPY", what: "Exchange rate, any base and quote" },
  { category: "others", url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR", parsePath: "$.rates.EUR", what: "ECB reference rate" },
  { category: "others", url: "https://dolarapi.com/v1/dolares/blue", parsePath: "$.venta", what: "Argentine blue-dollar rate (oficial, mep, tarjeta)" },
  { category: "others", url: "https://api.worldbank.org/v2/country/US/indicator/NY.GDP.MKTP.CD?format=json&date=2023", parsePath: "$[1][0].value", what: "World Bank indicator, any country/year — GDP NY.GDP.MKTP.CD, CPI FP.CPI.TOTL, population SP.POP.TOTL" },
  { category: "others", url: "https://earthquake.usgs.gov/fdsnws/event/1/count?format=geojson&minmagnitude=6&starttime=2026-01-01", parsePath: "$.count", what: "USGS earthquake count over any magnitude and window" },
  { category: "others", url: "https://api.carbonintensity.org.uk/intensity", parsePath: "$.data[0].intensity.forecast", what: "UK grid carbon intensity, gCO2/kWh" },
  { category: "others", url: "https://api.sunrise-sunset.org/json?lat=40.71&lng=-74.01&formatted=0", parsePath: "$.results.day_length", what: "Day length in seconds at any lat/long" },
  { category: "others", url: "https://api.wheretheiss.at/v1/satellites/25544", parsePath: "$.altitude", what: "ISS altitude in km" },
  { category: "others", url: "https://ssd-api.jpl.nasa.gov/cad.api?date-min=2026-09-03&date-max=2026-10-03&dist-max=0.05", parsePath: "$.count", what: "NASA count of asteroid close approaches in a window" },
  { category: "others", url: "https://disease.sh/v3/covid-19/all", parsePath: "$.cases", what: "Global case/death counts (cases, deaths, recovered)" },
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
  { match: /\b(btc|bitcoin)\b/i, urls: ["api.coinbase.com/v2/prices/BTC-USD", "api.binance.com/api/v3/ticker/price", "api.kraken.com"], category: "crypto" },
  { match: /\b(eth|ethereum)\b/i, urls: ["ETH-USD"], category: "crypto" },
  { match: /\b(sol|solana)\b/i, urls: ["api.coinbase.com/v2/prices"], category: "crypto" },
  { match: /\b(tvl|defi)\b/i, urls: ["llama.fi"], category: "crypto" },
  { match: /\b(fear|greed|sentiment)\b/i, urls: ["alternative.me"], category: "crypto" },
  { match: /\b(hash ?rate|difficulty)\b/i, urls: ["blockchain.info"], category: "crypto" },
  { match: /\bblock height\b/i, urls: ["blocks/tip/height"], category: "crypto" },
  { match: /\b(gas|fee|sat\/vb)\b/i, urls: ["fees/recommended"], category: "crypto" },
  { match: /\b(rain|precipitation|flood)\b/i, urls: ["precipitation_sum", "flood-api"], category: "weather" },
  { match: /\b(temperature|hot|cold|degrees)\b/i, urls: ["temperature_2m"], category: "weather" },
  { match: /\b(air quality|aqi|smog|pollution)\b/i, urls: ["air-quality"], category: "weather" },
  { match: /\b(uv|sunburn)\b/i, urls: ["currentuvindex"], category: "weather" },
  { match: /\bnpm|downloads\b/i, urls: ["npmjs"], category: "tech" },
  { match: /\b(paper|papers|research|citation|published)\b/i, urls: ["crossref"], category: "tech" },
    { match: /\b(satellite|starlink)\b/i, urls: ["tle.ivanstanojevic"], category: "tech" },
  { match: /\b(jpy|yen|eur|euro|exchange rate|usd)\b/i, urls: ["er-api", "frankfurter"], category: "others" },
  { match: /\b(peso|dolar blue|argentina)\b/i, urls: ["dolarapi"], category: "others" },
  { match: /\b(cpi|inflation)\b/i, urls: ["worldbank"], category: "others" },
    { match: /\b(gdp|world bank)\b/i, urls: ["worldbank"], category: "others" },
  { match: /\b(earthquake|quake|magnitude)\b/i, urls: ["usgs.gov"], category: "others" },
  { match: /\b(carbon|emissions|grid)\b/i, urls: ["carbonintensity"], category: "others" },
  { match: /\b(sunrise|sunset|daylight|day length)\b/i, urls: ["sunrise-sunset"], category: "others" },
  { match: /\b(iss|space station)\b/i, urls: ["wheretheiss"], category: "others" },
  { match: /\b(asteroid|near-earth|neo)\b/i, urls: ["ssd-api.jpl"], category: "others" },
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
