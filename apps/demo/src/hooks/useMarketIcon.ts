import { useQuery } from "@tanstack/react-query";
import {
  fetchMarketIcon,
  hasRenderableIcon,
  type ResolvedIcon,
} from "../lib/iconResolver";

/**
 * Fetches an entity icon for a market/event question.
 *
 * Returns the raw `ResolvedIcon` (including `category_fallback` results
 * that still carry an `entityName`) so the renderer can fall back to an
 * initial-letter tile when there is no image URL. Callers should treat
 * `icon.url` as optional and render the initials otherwise.
 */
export function useMarketIcon(question: string | undefined) {
  const query = useQuery<ResolvedIcon | null>({
    queryKey: ["market-icon", question?.trim().toLowerCase() ?? ""],
    queryFn: () => fetchMarketIcon(question ?? ""),
    enabled: !!question,
    // KV worker + localStorage already cache aggressively; keep this
    // mounted-session only.
    staleTime: 1000 * 60 * 60, // 1h
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const icon = hasRenderableIcon(query.data ?? null) ? query.data! : null;
  return {
    icon,
    isLoading: query.isLoading,
  };
}
