/**
 * Automatic market icons — real images, from keyless CDNs.
 *
 * When a creator supplies no icon of their own, a market still deserves a
 * face. This module finds the entity a question is ABOUT and returns an
 * actual image for it: a coin logo, a brand mark, or a rendered emoji glyph.
 * The emoji character survives only as the text fallback for a failed image
 * request, never as the intended output — a system-font emoji renders
 * differently on every OS, which is why the picture comes from a CDN.
 *
 * Three sources, all public and keyless, all verified reachable:
 *   · CoinGecko asset store — per-coin logos, stable by coin id
 *   · cdn.simpleicons.org  — brand marks, rendered in a colour we choose
 *   · Twemoji via jsDelivr — every other concept, as a real PNG
 * (Clearbit's free logo API is discontinued — every request fails. Do not
 * add it back.)
 *
 * ── Why position beats list order ──
 * A first-match-wins scan over an ordered rule list picks whichever entity
 * sits earliest in the SOURCE, which is a fact about this file, not about the
 * question. "Will Solana process more transactions than Ethereum?" drew the
 * Ethereum logo purely because that rule was written one line higher.
 * Questions name their subject first ("Will X …"), so the entity mentioned
 * EARLIEST in the text wins, and a named entity always outranks a topic word.
 */

export interface LocalIcon {
  /** Text fallback if the image fails — never the primary output. */
  emoji: string;
  accentColor: string;
  /** A real image. Present for every rule in this file. */
  imageUrl?: string;
}

/** CoinGecko's asset host: public, keyless, stable per coin id. */
const coin = (id: number, slug: string) =>
  `https://assets.coingecko.com/coins/images/${id}/small/${slug}.png`;

/** simpleicons renders a brand mark in whatever colour we ask for. */
const brand = (slug: string, hex: string) =>
  `https://cdn.simpleicons.org/${slug}/${hex.replace("#", "")}`;

/**
 * Twemoji's PNG for an emoji — a real, uniform image instead of whatever
 * the viewer's OS font happens to draw. Codepoints joined by "-", dropping
 * the FE0F variation selector, which is how Twemoji names its files.
 */
export function twemoji(emoji: string): string {
  const code = [...emoji]
    .map((c) => c.codePointAt(0)!.toString(16))
    .filter((c) => c !== "fe0f")
    .join("-");
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${code}.png`;
}

interface Rule {
  match: RegExp;
  emoji: string;
  accent: string;
  /** Explicit image; when absent the emoji's Twemoji PNG is used. */
  image?: string;
  /** Topic rules describe a subject area, not a named thing: they apply only
   *  when no specific entity is named anywhere in the question. */
  topic?: boolean;
}

const RULES: Rule[] = [
  // ── Named crypto assets — each its own coin logo. A market about Solana
  //    must never wear Bitcoin's coin; "crypto" is not an entity. ──
  { match: /\b(bitcoin|btc)\b/i, emoji: "₿", accent: "#f7931a", image: coin(1, "bitcoin") },
  { match: /\b(ethereum|eth)\b/i, emoji: "Ξ", accent: "#627eea", image: coin(279, "ethereum") },
  { match: /\b(solana|sol)\b/i, emoji: "◎", accent: "#9945ff", image: coin(4128, "solana") },
  { match: /\b(dogecoin|doge)\b/i, emoji: "🐕", accent: "#c2a633", image: coin(5, "dogecoin") },
  { match: /\b(cardano|ada)\b/i, emoji: "₳", accent: "#0033ad", image: coin(975, "cardano") },
  { match: /\b(ripple|xrp)\b/i, emoji: "✕", accent: "#23292f", image: coin(44, "xrp-symbol-white-128") },
  { match: /\b(chainlink|link)\b/i, emoji: "⬢", accent: "#2a5ada", image: coin(877, "chainlink-new-logo") },
  { match: /\b(avalanche|avax)\b/i, emoji: "🔺", accent: "#e84142", image: coin(12559, "Avalanche_Circle_RedWhite_Trans") },
  { match: /\b(polygon|matic)\b/i, emoji: "⬣", accent: "#8247e5", image: coin(4713, "polygon") },
  { match: /\b(usdc|tether|usdt|stablecoin)\b/i, emoji: "💵", accent: "#2775ca", image: coin(6319, "usdc") },

  // ── Named companies and orgs — brand marks in their own colours ──
  { match: /\b(binance|bnb)\b/i, emoji: "⬡", accent: "#f3ba2f", image: brand("binance", "F3BA2F") },
  { match: /\btesla\b|\btsla\b/i, emoji: "🚗", accent: "#e82127", image: brand("tesla", "E82127") },
  { match: /\bapple\b|\baapl\b|\biphone\b/i, emoji: "🍎", accent: "#a2aaad", image: brand("apple", "A2AAAD") },
  { match: /\bnvidia\b|\bnvda\b/i, emoji: "🎮", accent: "#76b900", image: brand("nvidia", "76B900") },
  { match: /\bspacex\b|\bstarship\b/i, emoji: "🚀", accent: "#c94f3d", image: brand("spacex", "E0E0E0") },
  { match: /\bnasa\b/i, emoji: "🛰️", accent: "#0b3d91", image: brand("nasa", "4A7FD4") },
  { match: /\banthropic\b|\bclaude\b/i, emoji: "🧠", accent: "#d4a27f", image: brand("anthropic", "D4A27F") },
  { match: /\b(github|repo|stars)\b/i, emoji: "⭐", accent: "#d4a04a", image: brand("github", "E0E0E0") },
  { match: /\bnpm\b|\bdownloads\b/i, emoji: "⭐", accent: "#cb3837", image: brand("npm", "CB3837") },
  { match: /\b(youtube)\b/i, emoji: "🎬", accent: "#ff0000", image: brand("youtube", "FF0000") },
  { match: /\b(netflix)\b/i, emoji: "🎬", accent: "#e50914", image: brand("netflix", "E50914") },
  { match: /\b(google|alphabet)\b/i, emoji: "🔍", accent: "#4285f4", image: brand("google", "4285F4") },
  { match: /\b(meta|facebook|instagram)\b/i, emoji: "📘", accent: "#0081fb", image: brand("meta", "0081FB") },
  { match: /\b(twitter|x\.com)\b/i, emoji: "🐦", accent: "#e0e0e0", image: brand("x", "E0E0E0") },
  // OpenAI has no simpleicons slug — Twemoji's robot carries it instead.
  { match: /\b(openai|chatgpt|gpt-?\d?)\b/i, emoji: "🤖", accent: "#10a37f" },

  // ── Named commodities and macro ──
  { match: /\b(gold|xau)\b/i, emoji: "🥇", accent: "#d4a04a" },
  { match: /\b(silver|xag)\b/i, emoji: "🥈", accent: "#aaa9ad" },
  { match: /\b(oil|crude|wti|brent)\b/i, emoji: "🛢️", accent: "#4a4a4a" },
  { match: /\b(fed|federal reserve|interest rate|inflation|cpi|gdp)\b/i, emoji: "🏦", accent: "#3d9970" },
  { match: /\b(eur|euro|yen|jpy|exchange rate|forex|fx)\b/i, emoji: "💱", accent: "#3d9970" },

  // ── Topics: only when nothing specific is named ──
  { topic: true, match: /\b(rain|precipitation|storm)\b/i, emoji: "🌧️", accent: "#4a90d9" },
  { topic: true, match: /\b(temperature|heat|celsius|fahrenheit|degrees)\b/i, emoji: "🌡️", accent: "#e25822" },
  { topic: true, match: /\b(snow|blizzard)\b/i, emoji: "❄️", accent: "#9fd3e8" },
  { topic: true, match: /\b(weather|forecast|sunny|cloud)\b/i, emoji: "⛅", accent: "#f5b942" },
  { topic: true, match: /\b(football|soccer|premier league|world cup|uefa)\b/i, emoji: "⚽", accent: "#2e8b57" },
  { topic: true, match: /\b(basketball|nba)\b/i, emoji: "🏀", accent: "#e8743b" },
  { topic: true, match: /\b(tennis|wimbledon)\b/i, emoji: "🎾", accent: "#c7e84a" },
  { topic: true, match: /\b(f1|formula one|grand prix)\b/i, emoji: "🏎️", accent: "#e10600" },
  { topic: true, match: /\b(olympics?|medal)\b/i, emoji: "🏅", accent: "#d4a04a" },
  { topic: true, match: /\b(championship|tournament|playoffs?)\b/i, emoji: "🏆", accent: "#d4a04a" },
  { topic: true, match: /\b(election|vote|president|senate|congress|parliament)\b/i, emoji: "🗳️", accent: "#5b7bd5" },
  { topic: true, match: /\b(war|ceasefire|treaty|peace)\b/i, emoji: "🕊️", accent: "#8ba7bd" },
  { topic: true, match: /\b(ai|llm|model|agent)\b/i, emoji: "🤖", accent: "#7d5bd5" },
  { topic: true, match: /\b(rocket|launch|orbit|mars|moon landing)\b/i, emoji: "🚀", accent: "#c94f3d" },
  { topic: true, match: /\b(iss|space station|satellite|altitude)\b/i, emoji: "🛰️", accent: "#6b7f99" },
  { topic: true, match: /\b(block height|hash ?rate|halving)\b/i, emoji: "⛓️", accent: "#8891a5" },
  { topic: true, match: /\b(crypto|token|coin|defi|blockchain)\b/i, emoji: "🪙", accent: "#8891a5" },
  { topic: true, match: /\b(movie|film|oscars?|box office)\b/i, emoji: "🎬", accent: "#c94f7d" },
  { topic: true, match: /\b(album|song|billboard|concert|grammy)\b/i, emoji: "🎵", accent: "#a05bd5" },
  { topic: true, match: /\b(stock|shares|nasdaq|s&p|earnings)\b/i, emoji: "📊", accent: "#3d9970" },
  { topic: true, match: /\b(price|above|below|reach|close at)\b/i, emoji: "📈", accent: "#3d9970" },
];

export function localIconFor(question: string): LocalIcon | null {
  if (!question?.trim()) return null;
  let best: { rule: Rule; index: number; length: number } | null = null;

  for (const rule of RULES) {
    const hit = rule.match.exec(question);
    if (!hit) continue;
    // A named entity always outranks a topic, however early the topic
    // appears: "the price of Solana" is a Solana market, not a price market.
    if (best && !best.rule.topic && rule.topic) continue;
    const promotesOverTopic = best?.rule.topic && !rule.topic;
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
    // Every rule resolves to a picture: an explicit logo, or the emoji's
    // Twemoji rendering. The bare character is only ever a load-error state.
    imageUrl: best.rule.image ?? twemoji(best.rule.emoji),
  };
}
