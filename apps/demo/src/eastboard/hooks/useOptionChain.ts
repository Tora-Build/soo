// The option chain, assembled from Solana markets.
//
// Upstream (sooth-alpha `east` branch) matched grid cells to markets through
// the indexer plus an EVM canonical-template registry. This port matches by
// QUESTION TEXT: the Solana program stores sha256(question) on the market and
// emits the verified text in `MarketCreated`, and `parseOptionQuestion` is the
// exact inverse of the template builder — so a cell and a market agree if and
// only if their questions are byte-identical. No registry, no indexer.
//
// Everything EVM-shaped is gone; the data comes from the same two sources the
// rest of the demo already trusts: `useOnChainMarkets` for the list and the
// adapter's snapshot for per-cell pricing. Only matched cells are priced —
// the grid is templates × strikes, but real markets are sparse.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  OPTION_UNDERLYINGS,
  buildOptionTemplates,
  parseOptionQuestion,
  tradingDatesAround,
  type IsoDate,
  type OptionTemplate,
} from "../core";
import { deriveCellStatus, type OptionCellStatus } from "../lib/cellStatus";
import { isEastboardFixtureMode } from "../lib/fixtureMode";
import { useOnChainMarkets } from "../../hooks/useOnChainMarkets";
import { useDerivedOptionMarkets } from "./useDerivedOptionMarkets";
import { useDemo } from "../../lib/DemoContext";

export type { OptionCellStatus } from "../lib/cellStatus";

export interface OptionChainCell {
  template: OptionTemplate;
  status: OptionCellStatus;
  marketAddress?: `0x${string}`;
  fixture: boolean;
  yesPriceWad?: bigint;
  winningOutcome?: 0 | 1 | 2;
}

const WAD = 10n ** 18n;

export function exchangeIsoDate(
  session: "cn" | "hk",
  nowMs = Date.now(),
): IsoDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: session === "cn" ? "Asia/Shanghai" : "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get(
    "day",
  )}` as IsoDate;
}

/** LMSR probability from the AMM cursor, in WAD. Display-grade math. */
function yesProbabilityWad(qYes: bigint, qNo: bigint, b: bigint): bigint {
  if (b <= 0n) return WAD / 2n;
  const diff = Number(qNo - qYes) / Number(b);
  const p = 1 / (1 + Math.exp(diff));
  if (!Number.isFinite(p)) return WAD / 2n;
  return BigInt(Math.round(p * 1e18));
}

export function useOptionChain(underlyingId: string) {
  const fixtureMode = isEastboardFixtureMode();
  const demo = useDemo();

  const underlying =
    OPTION_UNDERLYINGS.find((item) => item.id === underlyingId) ??
    OPTION_UNDERLYINGS[0];

  const expiries = useMemo(
    () =>
      tradingDatesAround(
        underlying.session,
        exchangeIsoDate(underlying.session),
        1,
        5,
      ),
    [underlying.session, underlying.id],
  );

  const templates = useMemo(
    () => buildOptionTemplates(underlying, expiries),
    [underlying, expiries],
  );

  // Probe chain for markets whose PDA derives from a template question —
  // finds cells activated in other browsers, no registry needed.
  useDerivedOptionMarkets(templates);

  // Every market the demo can see, matched to templates by parsed question.
  const onChain = useOnChainMarkets();
  const matched = useMemo(() => {
    const byTemplateId = new Map<
      string,
      { address: `0x${string}`; isGraduated: boolean; isSettled: boolean; winningOutcome: number | null }
    >();
    for (const market of onChain.markets ?? []) {
      const parsed = parseOptionQuestion(market.name ?? "");
      if (!parsed) continue;
      const id = `${parsed.underlyingId}-${parsed.expiry.replaceAll("-", "")}-${parsed.strikeRaw}`;
      byTemplateId.set(id, {
        address: market.address as `0x${string}`,
        isGraduated: market.isGraduated,
        isSettled: market.isSettled,
        winningOutcome: market.winningOutcome ?? null,
      });
    }
    return byTemplateId;
  }, [onChain.markets]);

  // Per-cell price for MATCHED cells only, straight from the AMM cursor.
  const matchedKey = useMemo(
    () =>
      [...matched.values()]
        .map((m) => m.address)
        .sort()
        .join(","),
    [matched],
  );
  const prices = useQuery({
    queryKey: ["eastboard-cell-prices", matchedKey],
    enabled: !!demo?.adapter && matched.size > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const out = new Map<string, bigint>();
      for (const [templateId, m] of matched) {
        try {
          const snap = await demo!.adapter.readSnapshot(
            `sol:${m.address.replace(/^0x/, "")}`,
          );
          out.set(
            templateId,
            yesProbabilityWad(
              snap.market.qYes,
              snap.market.qNo,
              snap.market.b,
            ),
          );
        } catch {
          // A market that fails to read keeps its cell unpriced — the grid
          // renders "—" rather than a confident wrong number.
        }
      }
      return out;
    },
  });

  const cells = useMemo(() => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    return templates
      .map((template): OptionChainCell | null => {
        const market = matched.get(template.id);
        if (!market && template.closeTs <= nowSeconds) return null;
        const status = deriveCellStatus({
          hasMarket: !!market,
          isGraduated: market?.isGraduated ?? false,
          isSettled: market?.isSettled ?? false,
          closeTsSeconds: template.closeTs,
          nowSeconds,
        });
        return {
          template,
          status,
          marketAddress: market?.address,
          fixture: fixtureMode,
          yesPriceWad: prices.data?.get(template.id),
          winningOutcome:
            market?.isSettled && market.winningOutcome !== null
              ? (market.winningOutcome as 0 | 1 | 2)
              : undefined,
        };
      })
      .filter((cell): cell is OptionChainCell => cell !== null);
  }, [templates, matched, prices.data, fixtureMode]);

  const visibleExpiries = useMemo(() => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const withCells = new Set(cells.map((cell) => cell.template.expiry));
    return expiries.filter((expiry) => {
      const template = templates.find((item) => item.expiry === expiry);
      if (!template) return false;
      if (template.closeTs > nowSeconds) return true;
      return withCells.has(expiry);
    });
  }, [cells, expiries, templates]);

  return {
    underlying,
    expiries: visibleExpiries,
    templates,
    cells,
    fixtureMode,
    metadataCandidates: 0,
    chainIsLoading: onChain.isLoading,
    chainError: onChain.error ?? prices.error ?? null,
    chainErrorSource: onChain.error
      ? ("indexer" as const)
      : prices.error
        ? ("quote" as const)
        : null,
    refetch: async () => {
      await onChain.refetch?.();
      await prices.refetch();
    },
  };
}
