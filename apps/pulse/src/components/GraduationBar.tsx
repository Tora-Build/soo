// The pump.fun bar: how far the bonding curve is from opening the book.
import { AMM_SYMBOL, BOOK_SYMBOL } from "../config";

export function GraduationBar({ progress, graduated }: { progress: number; graduated: boolean }) {
  if (graduated) {
    return (
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="rounded bg-yes-soft px-2 py-0.5 font-semibold text-yes">LIVE</span>
        <span className="text-faint">graduated — trading on the {BOOK_SYMBOL} order book</span>
      </div>
    );
  }
  const pctv = Math.round(progress * 100);
  return (
    <div>
      <div className="flex justify-between font-mono text-[10px] text-faint">
        <span>bonding · {AMM_SYMBOL}</span>
        <span>{pctv}% to graduation</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-inset">
        <div
          className="h-full rounded bg-accent transition-[width]"
          style={{ width: `${Math.max(2, pctv)}%` }}
        />
      </div>
    </div>
  );
}
