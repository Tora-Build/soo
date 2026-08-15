// The Polymarket chart: probability on a 0–100% axis, stepped YES line with
// the NO complement available, timeframe pills, hover crosshair. Hand-rolled
// SVG — the house pattern; the whole thing is smaller than a chart lib's
// type definitions.
import { useMemo, useRef, useState } from "react";

import type { PricePoint } from "../hooks/usePriceSeries";
import { centsOf } from "../lib/fmt";

const RANGES = [
  { label: "1H", secs: 3600 },
  { label: "6H", secs: 6 * 3600 },
  { label: "1D", secs: 86400 },
  { label: "1W", secs: 7 * 86400 },
  { label: "ALL", secs: Infinity },
] as const;

const W = 720;
const H = 260;
const PAD = { l: 40, r: 12, t: 10, b: 22 };

export function PriceChart({
  points,
  liveYesWad,
}: {
  points: PricePoint[];
  /** Current price, appended as the series' last point so the chart is never
   *  behind the number above it. */
  liveYesWad: bigint;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[4]);
  const [hover, setHover] = useState<{ x: number; ts: number; yes: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const series = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const cut = range.secs === Infinity ? 0 : now - range.secs;
    const inRange = points.filter((p) => p.ts >= cut);
    const all = [...inRange, { ts: now, yesPriceWad: liveYesWad, venue: "amm" as const }];
    // A one-point series still draws: synthesize a left edge.
    if (all.length === 1) all.unshift({ ...all[0], ts: all[0].ts - 60 });
    return all;
  }, [points, liveYesWad, range]);

  const { yesPath, noPath, areaPath, tsFor, yesAt } = useMemo(() => {
    const t0 = series[0].ts;
    const t1 = series[series.length - 1].ts;
    const span = Math.max(1, t1 - t0);
    const xFor = (ts: number) =>
      PAD.l + ((ts - t0) / span) * (W - PAD.l - PAD.r);
    const tsFor = (x: number) =>
      t0 + ((x - PAD.l) / (W - PAD.l - PAD.r)) * span;
    const yFor = (frac: number) =>
      PAD.t + (1 - frac) * (H - PAD.t - PAD.b);

    // Stepped line: hold each price until the next trade — a probability is a
    // state, not an interpolation.
    let yes = "";
    let no = "";
    let prevY: number | null = null;
    let prevYN: number | null = null;
    for (const p of series) {
      const x = xFor(p.ts);
      const fy = Number(p.yesPriceWad) / 1e18;
      const y = yFor(fy);
      const yN = yFor(1 - fy);
      if (prevY === null) {
        yes = `M${x},${y}`;
        no = `M${x},${yN}`;
      } else {
        yes += ` H${x} V${y}`;
        no += ` H${x} V${yN}`;
      }
      prevY = y;
      prevYN = yN;
    }
    void prevYN;
    const lastX = xFor(series[series.length - 1].ts);
    const area = `${yes} V${yFor(0)} H${PAD.l} Z`;
    void lastX;

    const yesAt = (ts: number) => {
      let v = series[0].yesPriceWad;
      for (const p of series) {
        if (p.ts <= ts) v = p.yesPriceWad;
        else break;
      }
      return v;
    };
    return { yesPath: yes, noPath: no, areaPath: area, tsFor, yesAt };
  }, [series]);

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    if (x < PAD.l || x > W - PAD.r) return setHover(null);
    const ts = tsFor(x);
    setHover({ x, ts, yes: centsOf(yesAt(ts)) });
  };

  return (
    <div className="border border-rule bg-raised">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* gridlines at 25/50/75 */}
        {[0.25, 0.5, 0.75].map((f) => {
          const y = PAD.t + (1 - f) * (H - PAD.t - PAD.b);
          return (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} stroke="#232a32" strokeDasharray="2 4" />
              <text x={4} y={y + 3} fontSize={10} fill="#566270" fontFamily="monospace">
                {f * 100}%
              </text>
            </g>
          );
        })}
        {/* The prediction-market signature: two solid complement lines that
            mirror around 50% and cross when the crowd flips. */}
        <path d={areaPath} fill="rgba(47,191,113,0.08)" />
        <path d={yesPath} fill="none" stroke="#2fbf71" strokeWidth={2} />
        <path d={noPath} fill="none" stroke="#e5484d" strokeWidth={2} />
        {hover && (
          <g>
            <line x1={hover.x} x2={hover.x} y1={PAD.t} y2={H - PAD.b} stroke="#566270" />
            <rect
              x={Math.min(hover.x + 6, W - 150)}
              y={PAD.t + 4}
              width={140}
              height={34}
              rx={4}
              fill="#0e1216"
              stroke="#232a32"
            />
            <text x={Math.min(hover.x + 14, W - 142)} y={PAD.t + 18} fontSize={11} fill="#2fbf71" fontFamily="monospace">
              YES {hover.yes.toFixed(1)}¢ · NO {(100 - hover.yes).toFixed(1)}¢
            </text>
            <text x={Math.min(hover.x + 14, W - 142)} y={PAD.t + 32} fontSize={9} fill="#8b98a5" fontFamily="monospace">
              {new Date(hover.ts * 1000).toLocaleString()}
            </text>
          </g>
        )}
      </svg>
      <div className="flex items-center gap-1 border-t border-rule px-3 py-2">
        {RANGES.map((r) => (
          <button
            key={r.label}
            onClick={() => setRange(r)}
            className={`px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
              range.label === r.label ? "bg-inset text-ink" : "text-faint hover:text-muted"
            }`}
          >
            {r.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-3 font-mono text-[10px] text-faint">
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-pos" /> YES
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-neg" /> NO
          </span>
          <span>{points.length} trades on-chain</span>
        </span>
      </div>
    </div>
  );
}
