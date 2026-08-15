// Market discovery + live state, straight off the chain.
//
// A market row is: ref, question (from the verified MarketCreated event,
// cached), the YES price computed client-side from the AMM cursor, graduation
// progress, and lifecycle. No indexer; the question cache means the expensive
// signature walk happens once per market per browser.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { SEED_MARKET_REFS, WAD } from "../config";
import { useAdapter } from "./useAdapter";

export interface PulseMarket {
  ref: string;
  question: string;
  yesPriceWad: bigint;
  isGraduated: boolean;
  isLive: boolean;
  isSettled: boolean;
  winningOutcome?: number;
  deadline: number;
  /** 0..1 toward graduation, while bonding. */
  graduation: number;
  b: bigint;
}

const QUESTION_CACHE_KEY = "__pulseQuestions";
const CREATED_KEY = "__pulseCreatedMarkets";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function rememberCreatedMarket(ref: string, question: string) {
  try {
    const list = readJson<string[]>(CREATED_KEY, []);
    if (!list.includes(ref)) {
      localStorage.setItem(CREATED_KEY, JSON.stringify([...list, ref]));
    }
    const q = readJson<Record<string, string>>(QUESTION_CACHE_KEY, {});
    q[ref] = question;
    localStorage.setItem(QUESTION_CACHE_KEY, JSON.stringify(q));
  } catch {
    // Storage off — the market still exists; it is just not remembered.
  }
}

export function allMarketRefs(): string[] {
  return [...new Set([...SEED_MARKET_REFS, ...readJson<string[]>(CREATED_KEY, [])])];
}

/** LMSR yes-probability in WAD from the cursor. Display math. */
export function lmsrYesWad(qYes: bigint, qNo: bigint, b: bigint): bigint {
  if (b <= 0n) return WAD / 2n;
  const x = Number(qNo - qYes) / Number(b);
  const p = 1 / (1 + Math.exp(x));
  return Number.isFinite(p) ? BigInt(Math.round(p * 1e18)) : WAD / 2n;
}

async function loadMarket(
  adapter: ReturnType<typeof useAdapter>["adapter"],
  ref: string,
): Promise<PulseMarket | null> {
  try {
    const snap = await adapter.readSnapshot(ref);
    const m = snap.market;

    // The verified on-chain question — one signature walk, then cached.
    const cache = readJson<Record<string, string>>(QUESTION_CACHE_KEY, {});
    let question = cache[ref];
    if (!question) {
      question = (await adapter.readMarketQuestion(ref)) ?? "";
      if (question) {
        cache[ref] = question;
        try {
          localStorage.setItem(QUESTION_CACHE_KEY, JSON.stringify(cache));
        } catch {
          /* cosmetic */
        }
      }
    }

    let graduation = 0;
    if (!m.isGraduated) {
      try {
        const prog = await adapter.readGraduationProgress(ref);
        graduation = Math.min(
          1,
          Number(prog.progressBps ?? 0n) / 10_000,
        );
      } catch {
        graduation = 0;
      }
    }

    const now = Math.floor(Date.now() / 1000);
    return {
      ref,
      question: question || ref.replace(/^sol:/, ""),
      yesPriceWad: lmsrYesWad(m.qYes, m.qNo, m.b),
      isGraduated: m.isGraduated,
      isLive: m.isLive && Number(m.deadline) > now,
      isSettled: m.isSettled,
      winningOutcome: m.outcome,
      deadline: Number(m.deadline),
      graduation: m.isGraduated ? 1 : graduation,
      b: m.b,
    };
  } catch {
    // A ref that fails to read (closed market's tombstone, wrong cluster)
    // simply doesn't appear. The feed shows what exists.
    return null;
  }
}

export function useMarkets() {
  const { adapter } = useAdapter();
  const refs = useMemo(() => allMarketRefs(), []);
  const query = useQuery({
    queryKey: ["pulse-markets", refs.join(",")],
    refetchInterval: 12_000,
    queryFn: async () => {
      const rows = await Promise.all(refs.map((r) => loadMarket(adapter, r)));
      return rows.filter((r): r is PulseMarket => r !== null);
    },
  });
  const qc = useQueryClient();
  return {
    markets: query.data ?? [],
    isLoading: query.isLoading,
    refresh: () => qc.invalidateQueries({ queryKey: ["pulse-markets"] }),
  };
}

export function useMarket(ref: string | undefined) {
  const { adapter } = useAdapter();
  const query = useQuery({
    queryKey: ["pulse-market", ref],
    enabled: !!ref,
    refetchInterval: 8_000,
    queryFn: () => loadMarket(adapter, ref!),
  });
  return { market: query.data ?? null, isLoading: query.isLoading };
}
