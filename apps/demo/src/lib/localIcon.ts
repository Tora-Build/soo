/**
 * Local entity icons — a keyword fold, not a service.
 *
 * The remote icon resolver (`VITE_ICON_RESOLVER_URL`) was designed but its
 * worker never existed, so every tile in the product rendered as initials
 * ("WS", "WB") — technically a fallback, visually a bug report. This module
 * is the zero-infrastructure answer: match the question against the entities
 * this product actually hosts markets about, return an emoji and an accent.
 * An emoji tile is not a brand logo, but it is instant, offline, and carries
 * meaning; initials carry none.
 *
 * First match wins, so specific entities (bitcoin) outrank their categories
 * (crypto). Extend by appending — order is the priority system.
 */

export interface LocalIcon {
  emoji: string;
  accentColor: string;
  /** A real logo, where a stable keyless CDN carries one (CoinGecko asset
   *  paths, Clearbit logos, flagcdn). The emoji stays as the load-error
   *  fallback, so a dead CDN degrades to meaning, never to initials. */
  imageUrl?: string;
}

const RULES: Array<{
  match: RegExp;
  emoji: string;
  accent: string;
  image?: string;
}> = [
  // ── Named assets ──
  { match: /\b(btc|bitcoin)\b/i, emoji: "₿", accent: "#f7931a", image: "https://assets.coingecko.com/coins/images/1/small/bitcoin.png" },
  { match: /\b(eth|ethereum)\b/i, emoji: "◆", accent: "#8a92b2", image: "https://assets.coingecko.com/coins/images/279/small/ethereum.png" },
  { match: /\b(sol|solana)\b/i, emoji: "◎", accent: "#9945ff", image: "https://assets.coingecko.com/coins/images/4128/small/solana.png" },
  { match: /\b(doge|dogecoin)\b/i, emoji: "🐕", accent: "#c2a633", image: "https://assets.coingecko.com/coins/images/5/small/dogecoin.png" },
  { match: /\b(gold|xau)\b/i, emoji: "🥇", accent: "#d4a04a" },
  { match: /\b(oil|crude|wti|brent)\b/i, emoji: "🛢️", accent: "#4a4a4a" },
  { match: /\b(usd|dollar|eur|euro|yen|jpy|exchange rate|fx)\b/i, emoji: "💱", accent: "#3d9970" },
  { match: /\b(tesla|tsla)\b/i, emoji: "🚗", accent: "#cc0000", image: "https://logo.clearbit.com/tesla.com" },
  { match: /\b(apple|aapl|iphone)\b/i, emoji: "🍎", accent: "#a2aaad", image: "https://logo.clearbit.com/apple.com" },
  { match: /\b(nvidia|nvda)\b/i, emoji: "🎮", accent: "#76b900", image: "https://logo.clearbit.com/nvidia.com" },
  // ── Weather ──
  { match: /\b(rain|precipitation|storm)\b/i, emoji: "🌧️", accent: "#4a90d9" },
  { match: /\b(temperature|heat|hot|cold|degrees|celsius)\b/i, emoji: "🌡️", accent: "#e25822" },
  { match: /\b(snow|blizzard)\b/i, emoji: "❄️", accent: "#9fd3e8" },
  { match: /\b(weather|forecast|sunny|cloud)\b/i, emoji: "⛅", accent: "#f5b942" },
  // ── Sports ──
  { match: /\b(football|soccer|premier league|world cup|uefa)\b/i, emoji: "⚽", accent: "#2e8b57" },
  { match: /\b(basketball|nba)\b/i, emoji: "🏀", accent: "#e8743b" },
  { match: /\b(tennis|wimbledon)\b/i, emoji: "🎾", accent: "#c7e84a" },
  { match: /\b(f1|formula|grand prix)\b/i, emoji: "🏎️", accent: "#e10600" },
  { match: /\b(olympic|medal)\b/i, emoji: "🏅", accent: "#d4a04a" },
  { match: /\b(match|game|team|win.*league|championship)\b/i, emoji: "🏆", accent: "#d4a04a" },
  // ── Politics / world ──
  { match: /\b(election|vote|president|senate|congress|parliament)\b/i, emoji: "🗳️", accent: "#5b7bd5" },
  { match: /\b(war|ceasefire|treaty)\b/i, emoji: "🕊️", accent: "#8ba7bd" },
  { match: /\b(fed|interest rate|inflation|cpi|gdp)\b/i, emoji: "🏦", accent: "#3d9970" },
  // ── Tech / space ──
  { match: /\b(openai|gpt|chatgpt)\b/i, emoji: "🤖", accent: "#10a37f", image: "https://logo.clearbit.com/openai.com" },
  { match: /\b(ai|model|llm|anthropic)\b/i, emoji: "🤖", accent: "#7d5bd5" },
  { match: /\b(spacex)\b/i, emoji: "🚀", accent: "#c94f3d", image: "https://logo.clearbit.com/spacex.com" },
  { match: /\b(rocket|launch|nasa|orbit|mars|moon landing)\b/i, emoji: "🚀", accent: "#c94f3d" },
  { match: /\b(iss|space station|satellite|altitude)\b/i, emoji: "🛰️", accent: "#6b7f99" },
  { match: /\b(github|stars|repo|npm|downloads)\b/i, emoji: "⭐", accent: "#d4a04a" },
  { match: /\b(block height|hash rate|halving)\b/i, emoji: "⛓️", accent: "#8891a5" },
  // ── Culture ──
  { match: /\b(movie|film|oscar|box office)\b/i, emoji: "🎬", accent: "#c94f7d" },
  { match: /\b(album|song|billboard|concert|grammy)\b/i, emoji: "🎵", accent: "#a05bd5" },
  // ── Category-level backstops ──
  { match: /\b(price|above|below|reach|close at)\b/i, emoji: "📈", accent: "#3d9970" },
  { match: /\?/, emoji: "🔮", accent: "#8a7bd5" },
];

export function localIconFor(question: string): LocalIcon | null {
  for (const rule of RULES) {
    if (rule.match.test(question)) {
      return { emoji: rule.emoji, accentColor: rule.accent, imageUrl: rule.image };
    }
  }
  return null;
}
