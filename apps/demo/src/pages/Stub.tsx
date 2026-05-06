// `Stub` — placeholder for routes/flows the Solana fork doesn't yet
// implement. Renders a single explanatory card so the user lands somewhere
// honest rather than seeing a blank screen / runtime crash.

export interface StubProps {
  feature: string;
  reason?: string;
}

export function Stub({ feature, reason }: StubProps) {
  return (
    <div className="p-6 max-w-2xl mx-auto" data-testid="stub-page">
      <div className="border border-slate-700 bg-slate-900 p-4 rounded space-y-2">
        <h1 className="text-lg text-slate-100">{feature}</h1>
        <p className="text-sm text-slate-400">
          Not yet implemented in the Solana fork.
        </p>
        {reason ? (
          <p className="text-xs font-mono text-slate-500">{reason}</p>
        ) : null}
      </div>
    </div>
  );
}
