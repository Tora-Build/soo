// Positions with ONE contextual action each. The program's lifecycle decides
// what that action is; the UI never offers a menu of maybes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AMM_SYMBOL } from "../config";
import { tokens } from "../lib/fmt";
import { useAdapter } from "../hooks/useAdapter";
import { useMarkets } from "../hooks/useMarkets";
import { ConnectButton } from "../components/ConnectButton";

export function Portfolio() {
  const { adapter, userRef, signer } = useAdapter();
  const { markets } = useMarkets();
  const qc = useQueryClient();

  const positions = useQuery({
    queryKey: ["pulse-positions", userRef, markets.map((m) => m.ref).join(",")],
    enabled: !!userRef && markets.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const rows = await Promise.all(
        markets.map(async (m) => {
          try {
            const pos = await adapter.readPosition(m.ref, userRef!);
            const yes = pos.yesShares ?? 0n;
            const no = pos.noShares ?? 0n;
            if (yes === 0n && no === 0n) return null;
            return { market: m, yes, no };
          } catch {
            return null;
          }
        }),
      );
      return rows.filter((r): r is NonNullable<typeof r> => r !== null);
    },
  });

  const claim = useMutation({
    mutationFn: async (ref: string) => {
      const req = await adapter.buildRedeemAmmPosition(ref, { user: userRef! });
      return adapter.submit(req, signer!);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["pulse-positions"] }),
  });

  if (!userRef) {
    return (
      <div className="py-20 text-center">
        <ConnectButton />
      </div>
    );
  }

  const rows = positions.data ?? [];
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-7">
      <h1 className="east-label mb-4 text-[11px]">
        your positions
      </h1>
      <div className="space-y-2">
        {rows.map(({ market, yes, no }) => {
          const won =
            market.isSettled &&
            ((market.winningOutcome === 1 && yes > 0n) ||
              (market.winningOutcome === 0 && no > 0n) ||
              market.winningOutcome === 2);
          return (
            <div
              key={market.ref}
              className="flex items-center gap-3 border border-rule bg-raised p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{market.question}</p>
                <p className="font-mono text-[11px] text-faint">
                  {yes > 0n && (
                    <span className="text-pos">YES {tokens(yes, 1)} </span>
                  )}
                  {no > 0n && <span className="text-neg">NO {tokens(no, 1)}</span>}
                </p>
              </div>
              {market.isSettled ? (
                won ? (
                  <button
                    onClick={() => void claim.mutateAsync(market.ref)}
                    disabled={claim.isPending}
                    className="bg-pos px-4 py-2 font-mono text-xs font-semibold text-canvas disabled:opacity-50"
                  >
                    {claim.isPending ? "…" : `Claim ${AMM_SYMBOL}`}
                  </button>
                ) : (
                  <span className="font-mono text-[11px] text-faint">expired</span>
                )
              ) : (
                <span className="font-mono text-[11px] text-faint">open</span>
              )}
            </div>
          );
        })}
        {rows.length === 0 && !positions.isLoading && (
          <p className="py-12 text-center font-mono text-xs text-faint">
            no positions yet
          </p>
        )}
      </div>
    </div>
  );
}
