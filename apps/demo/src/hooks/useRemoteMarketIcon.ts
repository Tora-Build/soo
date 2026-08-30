import { useQuery } from "@tanstack/react-query";

/**
 * Creator-supplied market icons, from the arena backend.
 *
 * Off-chain by DESIGN, not as a compromise: an https URL committed into the
 * on-chain question hash pinned a mutable target — the image behind a link
 * changes at its owner's whim — so the previous "immutable icon" was theater
 * that also ate two thirds of the question's byte budget. A backend row is
 * honest about what it is, visible to every viewer, and editable by the
 * wallet that set it.
 *
 * Per-address queries dedupe through react-query's cache, so a grid of
 * cards costs one request per unknown market per session, not per render.
 */
const API_BASE = (import.meta.env.VITE_ARENA_API_BASE || "").replace(/\/$/, "");

export function useRemoteMarketIcon(marketAddress: string | undefined): string | null {
  const address = marketAddress?.replace(/^0x/, "").replace(/^sol:/, "");
  const query = useQuery<string | null>({
    queryKey: ["market-icon-remote", address ?? ""],
    enabled: !!address && !!API_BASE,
    staleTime: 5 * 60_000,
    gcTime: 60 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/api/arena/market-icons?markets=${address}`,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { icons?: Record<string, string> };
      return body.icons?.[address!] ?? null;
    },
  });
  return query.data ?? null;
}

/** Save (or replace, same wallet only) a market's icon link. */
export async function setRemoteMarketIcon(
  marketAddress: string,
  wallet: string,
  url: string,
): Promise<void> {
  if (!API_BASE) throw new Error("Arena service not configured");
  const res = await fetch(`${API_BASE}/api/arena/market-icon`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      market: marketAddress.replace(/^0x/, "").replace(/^sol:/, ""),
      wallet: wallet.replace(/^0x/, ""),
      url,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Icon save failed (${res.status})`);
  }
}

/** Client-side mirror of the worker's validation, for inline feedback. */
export function iconLinkIssue(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (!/^https:\/\//i.test(url)) return "Must be an https:// image link";
  if (url.length > 512) return "Link is too long";
  try {
    void new URL(url);
  } catch {
    return "Not a valid link";
  }
  return null;
}
