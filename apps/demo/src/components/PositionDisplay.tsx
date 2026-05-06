// Renders a Position from `adapter.readPosition`. WAD-scaled shares are
// formatted to 4-decimal display.

import type { Position } from "@sooth/sdk-solana";
import { formatWad } from "../lib/utils";

export interface PositionDisplayProps {
  position: Position | null | undefined;
  loading?: boolean;
}

export function PositionDisplay({ position, loading }: PositionDisplayProps) {
  return (
    <div
      className="border border-slate-700 bg-slate-900 p-4 rounded"
      data-testid="position-display"
    >
      <h3 className="text-xs uppercase tracking-widest text-slate-400 mb-2">
        Your position
      </h3>
      {loading && !position ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
          <dt className="text-slate-400">YES shares</dt>
          <dd className="text-emerald-400" data-testid="yes-shares">
            {formatWad(position?.yesShares ?? 0n)}
          </dd>
          <dt className="text-slate-400">NO shares</dt>
          <dd className="text-rose-400" data-testid="no-shares">
            {formatWad(position?.noShares ?? 0n)}
          </dd>
        </dl>
      )}
    </div>
  );
}
