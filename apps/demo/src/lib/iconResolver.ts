/**
 * Icon resolver client — talks to workers/icon-resolver.
 *
 * Per-market / per-event icon lookup. Uses the KV-backed worker for shared
 * cross-user caching; we also keep a cheap localStorage layer to avoid a
 * network roundtrip on reload for questions we've already seen.
 */

export interface ResolvedIcon {
  url: string | null;
  accentColor: string;
  source:
    | "coingecko"
    | "clearbit"
    | "wikipedia"
    | "flagcdn"
    | "category_fallback";
  entityName?: string;
}

/**
 * Resolver URL is opt-in via `VITE_ICON_RESOLVER_URL` (dev: point at
 * `http://localhost:8787` while running `wrangler dev`, prod: the deployed
 * worker domain, e.g. `https://icons.sooth.market`). When unset, the feature
 * stays fully dormant — no fetches, no console noise, layout renders without
 * entity icons.
 */
function getResolverUrl(): string | null {
  const fromVite = import.meta.env.VITE_ICON_RESOLVER_URL;
  if (!fromVite) return null;
  return String(fromVite).replace(/\/$/, "");
}

const LS_PREFIX = "sooth_icon_v7:";
const LS_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days client-side

interface LsEntry {
  icon: ResolvedIcon;
  t: number;
}

function normalize(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

function lsKey(question: string): string {
  return LS_PREFIX + normalize(question);
}

function readLs(question: string): ResolvedIcon | null {
  try {
    const raw = localStorage.getItem(lsKey(question));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LsEntry;
    if (Date.now() - parsed.t > LS_MAX_AGE_MS) return null;
    return parsed.icon;
  } catch {
    return null;
  }
}

function writeLs(question: string, icon: ResolvedIcon): void {
  try {
    const entry: LsEntry = { icon, t: Date.now() };
    localStorage.setItem(lsKey(question), JSON.stringify(entry));
  } catch {
    /* quota / private mode — ignore */
  }
}

export async function fetchMarketIcon(
  question: string,
): Promise<ResolvedIcon | null> {
  if (!question) return null;
  const cached = readLs(question);
  if (cached) return cached;

  const base = getResolverUrl();
  if (!base) return null; // feature disabled until VITE_ICON_RESOLVER_URL is set

  try {
    const url = `${base}/resolve?q=${encodeURIComponent(question)}`;
    // `no-store` keeps the browser's HTTP cache out of the loop — the
    // worker's own KV is our shared cache and is already fast (<5ms on
    // hit). Without this, stale responses from a previous worker
    // version (with different cache-control headers) can stick around
    // in the client even after LS wipes and page reloads.
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const icon = (await res.json()) as ResolvedIcon;
    // Cache any resolution that has at least an entityName (so the
    // initial-letter fallback tile renders stably) or an image URL.
    // If the worker couldn't even extract an entity, don't cache — next
    // load retries in case Gemini was flaky.
    if (hasRenderableIcon(icon)) writeLs(question, icon);
    return icon;
  } catch {
    return null;
  }
}

/** True if the resolver returned an actual image URL (entity-level match). */
export function hasImageIcon(icon: ResolvedIcon | null): boolean {
  return !!(icon && icon.url && icon.source !== "category_fallback");
}

/**
 * True if we have enough to render *something* — either an image URL or
 * an entityName we can turn into an initial-letter tile. Callers use this
 * to decide whether to reserve space for the icon at all.
 */
export function hasRenderableIcon(icon: ResolvedIcon | null): boolean {
  if (!icon) return false;
  return hasImageIcon(icon) || !!icon.entityName;
}
