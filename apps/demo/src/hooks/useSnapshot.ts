// `useSnapshot` — polls the adapter's `readSnapshot` for a market+user pair.
// No tanstack-query, no zustand — the demo's hook surface is intentionally
// thin so the test can assert on a few `act()` boundaries rather than
// reasoning about a query cache.
//
// Refreshes:
//   - on mount
//   - when `tick` is bumped (e.g. after a successful trade)
//
// The hook does NOT subscribe to chain events; the SDK's
// `subscribeMarketEvents` is `NotImplemented` for Solana. A future revision
// can swap to event-driven updates.

import { useCallback, useEffect, useState } from "react";
import type { SoothCoreSnapshot } from "@sooth/sdk-solana";
import { useAdapter } from "../lib/DemoContext";

export interface SnapshotState {
  data: SoothCoreSnapshot | null;
  error: Error | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useSnapshot(
  marketRef: string | null,
  userRef: string | null,
): SnapshotState {
  const adapter = useAdapter();
  const [data, setData] = useState<SoothCoreSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!marketRef) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const snap = await adapter.readSnapshot(marketRef, userRef ?? undefined);
      setData(snap);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [adapter, marketRef, userRef]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, error, loading, refetch };
}
