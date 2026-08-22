// Registry-less market discovery — the one list every surface starts from.
//
// There is no on-chain market index and no server, so "which markets exist"
// is assembled client-side from three sources that each cover a different
// gap:
//
//   1. `season-snapshot.json` — markets seen by the snapshot script at build
//      time. This is what makes a market created in one browser visible in
//      every other browser at the next build.
//   2. `demoConfig.marketRef` + `extraMarketRefs` — the env-configured seed
//      and any extras an operator pinned.
//   3. `__soothCreatedMarketPdas` — PDAs this browser created itself, held
//      on a global plus a localStorage/sessionStorage mirror so they survive
//      a navigation that wipes window state.
//
// Importing this module registers (1) into (3)'s stores as a side effect, so
// a cold browser landing directly on `/locker` sees the same market set the
// deck does without having to mount the leaderboard first.

import seasonSnapshot from "./season-snapshot.json";
import { demoConfig } from "../../lib/config";

const CREATED_PDAS_KEY = "__soothCreatedMarketPdas";

function readStore(store: Storage): string[] {
  try {
    const parsed = JSON.parse(store.getItem(CREATED_PDAS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

(() => {
  try {
    const pdas = Object.keys(seasonSnapshot.markets).map((ref) =>
      ref.replace(/^sol:/, ""),
    );
    const g = globalThis as unknown as { __soothCreatedMarketPdas?: string[] };
    // Union, never replace. The stores already hold markets this browser
    // created that the snapshot has never seen; writing the snapshot over
    // them would silently un-discover a user's own market.
    const merged = [
      ...new Set([
        ...(g.__soothCreatedMarketPdas ?? []),
        ...readStore(localStorage),
        ...readStore(sessionStorage),
        ...pdas,
      ]),
    ];
    g.__soothCreatedMarketPdas = merged;
    localStorage.setItem(CREATED_PDAS_KEY, JSON.stringify(merged));
    sessionStorage.setItem(CREATED_PDAS_KEY, JSON.stringify(merged));
  } catch {
    // Storage may be unavailable; the in-memory global still serves this tab.
  }
})();

/** Every market the demo can see, as `sol:<base58>` refs. */
export function knownMarketRefs(): string[] {
  const refs = new Set<string>();
  if (demoConfig.marketRef) refs.add(demoConfig.marketRef);
  for (const ref of demoConfig.extraMarketRefs) refs.add(ref);
  const g = globalThis as unknown as { __soothCreatedMarketPdas?: string[] };
  for (const pda of g.__soothCreatedMarketPdas ?? []) {
    if (typeof pda === "string" && pda) refs.add(`sol:${pda}`);
  }
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(CREATED_PDAS_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const pda of parsed) {
          if (typeof pda === "string" && pda) refs.add(`sol:${pda}`);
        }
      }
    } catch {
      // Unreadable storage is not a reason to lose the env-configured refs.
    }
  }
  return [...refs];
}
