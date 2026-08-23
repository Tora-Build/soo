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
