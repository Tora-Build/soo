// Registry-less discovery for wizard-created markets.
//
// The SDK derives a market id from the question text (sha256, first 16
// bytes), so every template's market PDA is computable from the words alone.
// One getMultipleAccountsInfo probe per poll tells us which cells exist on
// chain — including markets activated in OTHER browsers, which localStorage
// alone can never see. Hits are registered into the same created-market
// store and question cache the rest of the demo already trusts, so the
// existing pipeline (useOnChainMarkets → grid, markets page, portfolio)
// picks them up without a second data path.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveMarketPda, marketIdForQuestion } from "@sooth/sdk-solana";

import { useDemo } from "../../lib/DemoContext";
import { rememberMarketQuestion } from "../../lib/market-questions";
import type { OptionTemplate } from "../core";

function registeredPdas(): Set<string> {
  try {
    const raw = localStorage.getItem("__soothCreatedMarketPdas");
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function useDerivedOptionMarkets(templates: OptionTemplate[]) {
  const demo = useDemo();
  const queryClient = useQueryClient();
  const questionsKey = templates.map((t) => t.id).join(",");

  useQuery({
    queryKey: ["derivedOptionMarkets", questionsKey],
    enabled: !!demo?.adapter && templates.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      try {
      const adapter = demo!.adapter as unknown as {
        connection: {
          getMultipleAccountsInfo: (
            keys: unknown[],
          ) => Promise<(unknown | null)[]>;
        };
        programIds: never;
      };
      const pdas = await Promise.all(
        templates.map(async (t) => {
          const id = await marketIdForQuestion(t.question);
          return deriveMarketPda(id as never, adapter.programIds)[0];
        }),
      );
      const infos = await adapter.connection.getMultipleAccountsInfo(pdas);
      const known = registeredPdas();
      let found = 0;
      infos.forEach((info, i) => {
        if (!info) return;
        const pda = String(pdas[i]);
        if (known.has(pda)) return;
        known.add(pda);
        found += 1;
        rememberMarketQuestion(pda, templates[i].question);
      });
      if (found > 0) {
        const merged = [...known];
        const g = globalThis as unknown as {
          __soothCreatedMarketPdas?: string[];
        };
        g.__soothCreatedMarketPdas = merged;
        try {
          localStorage.setItem(
            "__soothCreatedMarketPdas",
            JSON.stringify(merged),
          );
          sessionStorage.setItem(
            "__soothCreatedMarketPdas",
            JSON.stringify(merged),
          );
        } catch {
          // storage may be unavailable; the global still feeds this session
        }
        await queryClient.invalidateQueries({
          queryKey: ["v10", "onChainMarkets"],
        });
      }
      return found;
      } catch (e) {
        console.warn("[derived-markets] probe failed:", e);
        throw e;
      }
    },
  });
}
