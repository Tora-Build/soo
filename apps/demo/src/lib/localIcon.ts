/**
 * Local entity icons — a keyword fold, not a service.
 *
 * The remote icon resolver (`VITE_ICON_RESOLVER_URL`) was designed but its
 * worker never existed, so every tile rendered initials ("WS", "WB") —
 * technically a fallback, visually a bug report. This module is the
 * zero-infrastructure answer: find the entity a question is ABOUT, return its
 * logo (a keyless CDN where one exists) plus an emoji fallback and an accent.
 *
 * ── Why position beats list order ──
 * A first-match-wins scan over an ordered rule list picks whichever entity
 * happens to sit earliest in the SOURCE, which is a fact about this file, not
 * about the question. "Will Solana process more transactions than Ethereum?"
 * drew the Ethereum logo purely because that rule was written one line
 * higher. Questions name their subject first ("Will X …"), so the entity
 * mentioned EARLIEST in the text wins, and ties break toward the longer
 * (more specific) match — "bitcoin cash" over "bitcoin".
 */

export interface LocalIcon {
  emoji: string;
  accentColor: string;
  /** A real logo, where a stable keyless CDN carries one. The emoji stays as
   *  the load-error fallback, so a dead CDN degrades to meaning, never to
   *  initials. (Clearbit's free logo API is gone — do not add it back.) */
  imageUrl?: string;
}

/** CoinGecko's asset host is public, keyless and stable per coin id. */
const CG = (id: number, slug: string) =>
  `https://assets.coingecko.com/coins/images/${id}/small/${slug}.png`;

interface Rule {
  match: RegExp;
  emoji: string;
  accent: string;
  image?: string;
  /** Category rules describe a topic, not a named thing: they only apply
   *  when no specific entity was named anywhere in the question. */
  category?: boolean;
}

const RULES: Rule[] = [
  // ── Named crypto assets — each its own logo. A market about Solana must
  //    never wear Bitcoin's coin; "crypto" is not an entity. ──
  { match: /\b(bitcoin|btc)\b/i, emoji: "₿", accent: "#f7931a", image: CG(1, "bitcoin") },
  { match: /\b(ethereum|eth)\b/i, emoji: "Ξ", accent: "#627eea", image: CG(279, "ethereum") },
  { match: /\b(solana|sol)\b/i, emoji: "◎", accent: "#9945ff", image: CG(4128, "solana") },
  { match: /\b(dogecoin|doge)\b/i, emoji: "🐕", accent: "#c2a633", image: CG(5, "dogecoin") },
  { match: /\b(cardano|ada)\b/i, emoji: "₳", accent: "#0033ad", image: CG(975, "cardano") },
  { match: /\b(ripple|xrp)\b/i, emoji: "✕", accent: "#23292f", image: CG(44, "xrp-symbol-white-128") },
  { match: /\b(binance|bnb)\b/i, emoji: "⬡", accent: "#f3ba2f", image: CG(825, "bnb-icon2_2x") },
  { match: /\b(chainlink|link)\b/i, emoji: "⬢", accent: "#2a5ada", image: CG(877, "chainlink-new-logo") },
  { match: /\b(avalanche|avax)\b/i, emoji: "🔺", accent: "#e84142", image: CG(12559, "Avalanche_Circle_RedWhite_Trans") },
  { match: /\b(polygon|matic)\b/i, emoji: "⬣", accent: "#8247e5", image: CG(4713, "polygon") },
  { match: /\b(usdc|tether|usdt|stablecoin)\b/i, emoji: "💵", accent: "#2775ca", image: CG(6319, "usdc") },

  // ── Named companies / orgs ──
  { match: /\btesla\b|\btsla\b/i, emoji: "🚗", accent: "#cc0000" },
  { match: /\bapple\b|\baapl\b|\biphone\b/i, emoji: "🍎", accent: "#a2aaad" },
  { match: /\bnvidia\b|\bnvda\b/i, emoji: "🎮", accent: "#76b900" },
  { match: /\b(openai|chatgpt|gpt-?\d?)\b/i, emoji: "🤖", accent: "#10a37f" },
  { match: /\banthropic\b|\bclaude\b/i, emoji: "🧠", accent: "#d4a27f" },
  { match: /\bspacex\b|\bstarship\b/i, emoji: "🚀", accent: "#c94f3d" },
  { match: /\bnasa\b/i, emoji: "🛰️", accent: "#0b3d91" },

  // ── Named commodities / macro ──
  { match: /\b(gold|xau)\b/i, emoji: "🥇", accent: "#d4a04a" },
  { match: /\b(silver|xag)\b/i, emoji: "🥈", accent: "#aaa9ad" },
  { match: /\b(oil|crude|wti|brent)\b/i, emoji: "🛢️", accent: "#4a4a4a" },
  { match: /\b(fed|federal reserve|interest rate|inflation|cpi|gdp)\b/i, emoji: "🏦", accent: "#3d9970" },
  { match: /\b(eur|euro|yen|jpy|exchange rate|forex|fx)\b/i, emoji: "💱", accent: "#3d9970" },

  // ── Topic rules: only when nothing specific was named ──
  { category: true, match: /\b(rain|precipitation|storm)\b/i, emoji: "🌧️", accent: "#4a90d9" },
  { category: true, match: /\b(temperature|heat|celsius|fahrenheit|degrees)\b/i, emoji: "🌡️", accent: "#e25822" },
  { category: true, match: /\b(snow|blizzard)\b/i, emoji: "❄️", accent: "#9fd3e8" },
  { category: true, match: /\b(weather|forecast|sunny|cloud)\b/i, emoji: "⛅", accent: "#f5b942" },
  { category: true, match: /\b(football|soccer|premier league|world cup|uefa)\b/i, emoji: "⚽", accent: "#2e8b57" },
  { category: true, match: /\b(basketball|nba)\b/i, emoji: "🏀", accent: "#e8743b" },
  { category: true, match: /\b(tennis|wimbledon)\b/i, emoji: "🎾", accent: "#c7e84a" },
  { category: true, match: /\b(f1|formula one|grand prix)\b/i, emoji: "🏎️", accent: "#e10600" },
  { category: true, match: /\b(olympics?|medal)\b/i, emoji: "🏅", accent: "#d4a04a" },
  { category: true, match: /\b(championship|tournament|playoffs?)\b/i, emoji: "🏆", accent: "#d4a04a" },
  { category: true, match: /\b(election|vote|president|senate|congress|parliament)\b/i, emoji: "🗳️", accent: "#5b7bd5" },
  { category: true, match: /\b(war|ceasefire|treaty|peace)\b/i, emoji: "🕊️", accent: "#8ba7bd" },
  { category: true, match: /\b(ai|llm|model|agent)\b/i, emoji: "🤖", accent: "#7d5bd5" },
  { category: true, match: /\b(rocket|launch|orbit|mars|moon landing)\b/i, emoji: "🚀", accent: "#c94f3d" },
  { category: true, match: /\b(iss|space station|satellite|altitude)\b/i, emoji: "🛰️", accent: "#6b7f99" },
  { category: true, match: /\b(github|stars|repo|npm|downloads)\b/i, emoji: "⭐", accent: "#d4a04a" },
  { category: true, match: /\b(block height|hash ?rate|halving)\b/i, emoji: "⛓️", accent: "#8891a5" },
  { category: true, match: /\b(crypto|token|coin|defi|blockchain)\b/i, emoji: "🪙", accent: "#8891a5" },
  { category: true, match: /\b(movie|film|oscars?|box office)\b/i, emoji: "🎬", accent: "#c94f7d" },
  { category: true, match: /\b(album|song|billboard|concert|grammy)\b/i, emoji: "🎵", accent: "#a05bd5" },
  { category: true, match: /\b(stock|shares|nasdaq|s&p|earnings)\b/i, emoji: "📊", accent: "#3d9970" },
  { category: true, match: /\b(price|above|below|reach|close at)\b/i, emoji: "📈", accent: "#3d9970" },
];

export function localIconFor(question: string): LocalIcon | null {
  if (!question?.trim()) return null;
  let best: { rule: Rule; index: number; length: number } | null = null;

  for (const rule of RULES) {
    const hit = rule.match.exec(question);
    if (!hit) continue;
    // A named entity always outranks a topic, however early the topic appears:
    // "the price of Solana" is a Solana market, not a price market.
    if (best && !best.rule.category && rule.category) continue;
    const promotesOverTopic = best?.rule.category && !rule.category;
    const earlier = !best || hit.index < best.index;
    const sameSpotButLonger =
      best && hit.index === best.index && hit[0].length > best.length;
    if (promotesOverTopic || earlier || sameSpotButLonger) {
      best = { rule, index: hit.index, length: hit[0].length };
    }
  }

  if (!best) return null;
  return {
    emoji: best.rule.emoji,
    accentColor: best.rule.accent,
    imageUrl: best.rule.image,
  };
}
