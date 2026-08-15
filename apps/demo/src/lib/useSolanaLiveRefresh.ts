// Push-based freshness for the Solana fork.
//
// ## Why this exists
//
// The EVM-shaped live-update path — `ActivityListener` watching
// PositionTraded, MarketGraduated, LPRedeemed and four others — is inert on
// Solana: the chain-shim's `useWatchContractEvent` is a no-op stub, so those
// handlers never fire and nothing invalidates. Without this hook the app runs
// on polling alone, and a trade can land on-chain while the page keeps
// showing stale numbers until the next interval elapses.
//
// ## Why account subscriptions rather than synthetic logs
//
// The tempting fix is to make `useWatchContractEvent` fabricate EVM-shaped
// logs so the existing handlers fire. That means reproducing seven event
// payloads faithfully enough that every `log.args.*` read is correct — a large
// surface where one wrong field is a silently wrong toast or a bad refetch.
//
// Solana offers something strictly better. `onAccountChange` delivers the
// account's new STATE, not a delta describing it, so nothing has to be
// reconstructed: when the book or the AMM changes, re-read it. That is also
// the idiom Solana apps use, and it is the same property that lets the
// orderbook be correct without an indexer.
//
// So this subscribes to the accounts backing the UI and invalidates the cached
// reads. Coarse on purpose: refetching a cached account read is cheap, and a
// missed invalidation is a stale balance shown as fact.

import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PublicKey, type Connection } from "@solana/web3.js";

/** Coalescing window for a burst of account changes. */
export const LIVE_REFRESH_DEBOUNCE_MS = 250;

export interface LiveRefreshOptions {
  connection: Connection | null | undefined;
  /** Accounts whose changes should refresh the UI. */
  accounts?: Array<PublicKey | string | null | undefined>;
  /**
   * Programs whose owned accounts should refresh the UI.
   *
   * Preferred over listing accounts individually: a book PDA is derived from
   * the `market_id` stored INSIDE the market account, so naming it needs an
   * async fetch that a render pass cannot do. One program subscription covers
   * every book, AMM state and position without deriving anything.
   */
  programs?: Array<PublicKey | string | null | undefined>;
  /** Disable without unmounting — e.g. before a market has resolved. */
  enabled?: boolean;
}

/**
 * Normalise a mixed list of pubkeys to a sorted, de-duplicated base58 list.
 *
 * Exported for tests: the subscription effect keys on this, so getting it
 * wrong means either a resubscribe storm (unstable) or a missed account.
 */
export function normalizeAccounts(
  accounts: Array<PublicKey | string | null | undefined>,
): string[] {
  const out = new Set<string>();
  for (const a of accounts) {
    if (!a) continue;
    const s = typeof a === "string" ? a.replace(/^sol:/, "") : a.toBase58();
    if (s) out.add(s);
  }
  return [...out].sort();
}

/**
 * Subscribe to a set of accounts; invalidate cached reads when any changes.
 *
 * Unsubscribes on unmount and whenever the account set changes, so switching
 * markets does not leak a listener per visit.
 */
export function useSolanaLiveRefresh({
  connection,
  accounts = [],
  programs = [],
  enabled = true,
}: LiveRefreshOptions): void {
  const queryClient = useQueryClient();

  // The effect must not re-run merely because the caller rebuilt the array
  // literal, or every render would tear down and rebuild the subscriptions.
  const keys = useMemo(() => normalizeAccounts(accounts), [accounts]);
  const programKeys = useMemo(() => normalizeAccounts(programs), [programs]);
  const keyId = keys.join(",");
  const programId = programKeys.join(",");

  useEffect(() => {
    if (!enabled || !connection) return;
    if (keys.length === 0 && programKeys.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const invalidate = () => {
      if (cancelled) return;
      // One transaction can touch several watched accounts — a fill writes the
      // book and the vault — so debounce, or a single trade triggers a refetch
      // per account.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!cancelled) void queryClient.invalidateQueries();
      }, LIVE_REFRESH_DEBOUNCE_MS);
    };

    const subscriptions: number[] = [];
    for (const key of keys) {
      try {
        subscriptions.push(
          connection.onAccountChange(new PublicKey(key), invalidate, "confirmed"),
        );
      } catch {
        // A malformed key must not take down the others, and must not leave
        // the page without any subscription at all.
      }
    }

    const programSubscriptions: number[] = [];
    for (const key of programKeys) {
      try {
        programSubscriptions.push(
          connection.onProgramAccountChange(
            new PublicKey(key),
            invalidate,
            "confirmed",
          ),
        );
      } catch {
        // Same reasoning as above — one bad id must not disable the rest.
      }
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      for (const id of subscriptions) {
        void connection.removeAccountChangeListener(id).catch(() => {
          // The socket may already be gone on unmount; nothing to recover.
        });
      }
      for (const id of programSubscriptions) {
        void connection.removeProgramAccountChangeListener(id).catch(() => {});
      }
    };
    // `keys` is derived from `keyId`; depending on the string keeps the effect
    // stable across array identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, keyId, programId, enabled, queryClient]);
}
