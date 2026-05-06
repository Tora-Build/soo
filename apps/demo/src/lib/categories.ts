/**
 * Shared category definitions for market classification.
 * Single source of truth for ordering, labels, and keyword inference.
 */

/** Canonical category order used across all pages (7 + "all" pseudo-id). */
export const CATEGORY_IDS = [
  "all",
  "sports",
  "tech",
  "cultures",
  "crypto",
  "politics",
  "weather",
  "others",
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export const CATEGORY_LABELS: Record<string, string> = {
  all: "All",
  sports: "Sports",
  tech: "Tech",
  cultures: "Culture",
  crypto: "Crypto",
  politics: "Politics",
  weather: "Weather",
  others: "Other",
};

/**
 * Canonical accent color per category. These hex values are authoritative
 * for the demo (EntityIcon fallback tile, any future per-category tints)
 * and mirrored by `workers/icon-resolver/src/index.ts`'s CATEGORY_COLORS
 * so the icon resolver returns matching accents via the `accentColor`
 * field. Keep the two in sync when adding/removing categories.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  crypto: "#F7931A",
  politics: "#2563EB",
  sports: "#16A34A",
  tech: "#8B5CF6",
  cultures: "#EC4899",
  weather: "#06B6D4",
  others: "#64748B",
};

export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  sports: [
    "nba",
    "nfl",
    "fifa",
    "world cup",
    "champion",
    "league",
    "game",
    "match",
    "playoff",
    "super bowl",
    "olympics",
    "f1",
    "formula",
    "tennis",
    "goal",
    "score",
  ],
  weather: [
    "weather",
    "rain",
    "snow",
    "temperature",
    "celsius",
    "fahrenheit",
    "hurricane",
    "tornado",
    "flood",
    "drought",
    "storm",
    "forecast",
    "heatwave",
    "wildfire",
    "climate",
  ],
  tech: [
    "ai ",
    "artificial intelligence",
    "openai",
    "anthropic",
    "gpt",
    "llm",
    "robot",
    "quantum",
    "apple",
    "google",
    "microsoft",
    "nvidia",
    "tesla",
    "spacex",
    "launch",
    "space",
    "mars",
    "starship",
    "satellite",
    "research",
    "nobel",
    "science",
  ],
  cultures: [
    "oscar",
    "grammy",
    "emmy",
    "movie",
    "film",
    "album",
    "music",
    "song",
    "tiktok",
    "youtube",
    "twitter",
    "instagram",
    "celebrity",
    "marvel",
    "netflix",
    "disney",
    "game of the year",
  ],
  crypto: [
    "bitcoin",
    "btc",
    "eth",
    "ethereum",
    "crypto",
    "token",
    "defi",
    "nft",
    "solana",
    "sol",
    "chain",
    "blockchain",
    "halving",
    "staking",
    "usdc",
    "usdt",
    "stablecoin",
    "dao",
    "web3",
  ],
  politics: [
    "president",
    "election",
    "vote",
    "congress",
    "senate",
    "governor",
    "democrat",
    "republican",
    "trump",
    "biden",
    "government",
    "policy",
    "legislation",
    "supreme court",
    "un ",
    "nato",
  ],
};

export function inferCategory(question: string): string {
  const lower = question.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return cat;
  }
  return "others";
}

/**
 * Aliases for category labels that don't map to the canonical 7. The seed
 * scripts (e.g. seed-sepolia.ts) historically wrote categories like "defi"
 * / "security" / "governance" into on-chain §category SQF tags. The filter
 * UI in Markets.tsx only buckets CATEGORY_IDS, so anything outside that set
 * stays in "All" but disappears from per-category counts — counts then no
 * longer sum to All. Normalize at parse time instead of changing the chain
 * data (which would require redeploying every market).
 */
const CATEGORY_ALIASES: Record<string, string> = {
  defi: "crypto",
  security: "crypto",
  governance: "crypto",
  stablecoin: "crypto",
  nft: "crypto",
  dao: "crypto",
  // Plural / singular drift seen in the wild.
  culture: "cultures",
  other: "others",
};

/**
 * Returns a canonical category id (one of CATEGORY_IDS minus "all") for any
 * raw value. Unknown labels fall through to "others" so they're at least
 * visible in the Other filter rather than silently vanishing from counts.
 */
export function normalizeCategory(raw: string | undefined | null): string {
  if (!raw) return "others";
  const lower = raw.toLowerCase().trim();
  if (CATEGORY_ALIASES[lower]) return CATEGORY_ALIASES[lower];
  if (CATEGORY_IDS.includes(lower as CategoryId) && lower !== "all") {
    return lower;
  }
  return "others";
}
