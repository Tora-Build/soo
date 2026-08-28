// Lifecycle + adjudication state for every market the demo can see.
//
// Two surfaces need the same three facts and would otherwise each fetch them:
// the veto countdown (attested outcome, `attested_at`, and the config's
// `veto_period_secs`) and the Locker's created-markets panel (`Market.creator`
// plus the same adjudication state). One store, one poll, one fan-out.
//
// The market list comes from `marketRegistry` — the registry-less discovery
// the deck uses. There is no creator index on chain, so "markets I created"
// is this candidate list filtered by `Market.creator`; anything the registry
// cannot see is invisible here too.

import { useContext, useEffect } from "react";
import { create } from "zustand";
import type {
  MarketResolutionState,
  SolanaChainAdapter,
} from "@sooth/sdk-solana";
import { DemoContextObj } from "../../lib/DemoContext";
import { knownMarketRefs } from "./marketRegistry";

const POLL_MS = 20_000;

interface ResolutionState {
  /** Keyed by market PDA in base58 (no `sol:` / `0x` prefix). */
  byMarket: Record<string, MarketResolutionState>;
  /** Bonded optimistic proposals, same keying. */
  proposalsByMarket: Record<
    string,
    NonNullable<Awaited<ReturnType<SolanaChainAdapter["readOptimisticProposal"]>>>
  >;
  /** Null until the protocol config has been read — "unknown", not zero. */
  vetoPeriodSecs: number | null;
  /** `ProtocolConfig.permissionless_adjudicators` — gates whether a market's
   *  creator may register themselves. */
  permissionlessAdjudicators: boolean;
  hasLoaded: boolean;
  isFetching: boolean;
}

const useStore = create<ResolutionState>(() => ({
  byMarket: {},
  proposalsByMarket: {},
  vetoPeriodSecs: null,
  permissionlessAdjudicators: false,
  hasLoaded: false,
  isFetching: false,
}));

/** Accepts `0x<base58>`, `sol:<base58>` or bare base58. */
export function normalizeMarketKey(
  address: string | null | undefined,
): string | null {
  if (!address) return null;
  if (address.startsWith("sol:")) return address.slice(4);
  if (address.startsWith("0x")) return address.slice(2);
  return address;
}

let activeAdapter: SolanaChainAdapter | null = null;
/**
 * Refs discovered outside the registry — today, the connected wallet's own
 * markets found by creator on chain. Kept off the global registry so
 * untradeable old-mint markets stay out of the deck while the founder's
 * console still sees every market the program says they created.
 */
let extraRefs: string[] = [];

export function addResolutionExtraRefs(refs: string[]): void {
  const merged = new Set([...extraRefs, ...refs]);
  if (merged.size === extraRefs.length) return;
  extraRefs = [...merged];
  void refreshResolutionStates();
}
let inFlight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let mountCount = 0;

async function fetchResolutionStates(): Promise<void> {
  const adapter = activeAdapter;
  if (!adapter) return;
  useStore.setState({ isFetching: true });
  try {
    const refs = [...new Set([...knownMarketRefs(), ...extraRefs])];
    const [vetoPeriodSecs, policy, states, proposals] = await Promise.all([
      adapter.readVetoPeriodSecs().catch(() => null),
      adapter.readAdjudicatorPolicy().catch(() => null),
      refs.length ? adapter.readResolutionStates(refs) : Promise.resolve([]),
      // Bonded proposals ride the same poll: reputation needs them, and a
      // separate cadence would let score and state drift apart on screen.
      refs.length
        ? adapter.readOptimisticProposals(refs).catch(() => [])
        : Promise.resolve([]),
    ]);
    const byMarket: Record<string, MarketResolutionState> = {};
    for (const state of states) {
      if (state) byMarket[state.market] = state;
    }
    const proposalsByMarket: Record<
      string,
      NonNullable<Awaited<ReturnType<SolanaChainAdapter["readOptimisticProposal"]>>>
    > = {};
    for (const prop of proposals) {
      if (prop) proposalsByMarket[prop.market] = prop;
    }
    useStore.setState({
      byMarket,
      proposalsByMarket,
      // A failed config read keeps the last known period rather than
      // claiming the window length is unknown mid-countdown.
      vetoPeriodSecs: vetoPeriodSecs ?? useStore.getState().vetoPeriodSecs,
      permissionlessAdjudicators:
        policy?.permissionless ??
        useStore.getState().permissionlessAdjudicators,
      hasLoaded: true,
    });
  } catch (e) {
    // A dead RPC leaves the last known states on screen. The countdown is
    // derived from `attested_at`, which does not move, so a stale read is
    // still an accurate deadline.
    // eslint-disable-next-line no-console
    console.warn("[useResolutionStates] fetch failed", e);
  } finally {
    useStore.setState({ isFetching: false });
  }
}

/** Force a refetch — call after a write that changes lifecycle state. */
export function refreshResolutionStates(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetchResolutionStates().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Subscribe to the shared store, starting the poll loop while mounted. */
export function useResolutionStates(): ResolutionState {
  const demo = useContext(DemoContextObj);
  const adapter = (demo?.adapter as SolanaChainAdapter | undefined) ?? null;

  useEffect(() => {
    if (!adapter) return;
    activeAdapter = adapter;
    mountCount += 1;
    void refreshResolutionStates();
    if (!pollTimer) {
      pollTimer = setInterval(() => void refreshResolutionStates(), POLL_MS);
    }
    return () => {
      mountCount -= 1;
      if (mountCount <= 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, [adapter]);

  return useStore();
}

/** One market's state, or undefined while it is still unknown. */
export function useMarketResolution(
  address: string | null | undefined,
): MarketResolutionState | undefined {
  const { byMarket } = useResolutionStates();
  const key = normalizeMarketKey(address);
  return key ? byMarket[key] : undefined;
}

export const __testing = { useStore };
