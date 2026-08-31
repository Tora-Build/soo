/**
 * Learn — how Soo works, in the order someone actually needs it.
 *
 * Six steps, each answering one question: what this is, how a market is born,
 * what happens when you trade, where trading happens, how the answer is
 * decided, and what to do next. Resolution is a step of its own because it is
 * the part of Soo that differs most from every other venue — and the previous
 * version of this page did not mention it at all.
 *
 * Structure note: the step navigation is a sticky rail rather than a banner,
 * and every panel of supporting detail belongs to ONE step. The old layout
 * carried a sidebar that repeated the same glossary and the same "pro tip" on
 * all five steps — roughly fifty words shown five times, which trains the
 * reader to ignore that column.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowLeftRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Coins,
  Gavel,
  GraduationCap,
  Hand,
  Layers,
  Lock,
  Rocket,
  Scale,
  ShieldCheck,
  Sparkles,
  Timer,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { cn } from "../lib/utils";

/* ─────────────────────────── step definitions ─────────────────────────── */

/**
 * `hash` is the deep link. `/learn#liquidity` is linked from the market
 * page's liquidity drawer and must keep working, so the anchor names are
 * part of the contract, not decoration.
 */
const STEPS = [
  { hash: "basics", label: "Basics", blurb: "What a Soo market is" },
  { hash: "creating", label: "Creating", blurb: "Where a market comes from" },
  { hash: "trading", label: "Trading", blurb: "Prices, fees and LP" },
  { hash: "venues", label: "Venues", blurb: "The curve and the book" },
  { hash: "resolution", label: "Resolution", blurb: "How the answer is decided" },
  { hash: "start", label: "Start", blurb: "Where to go next" },
] as const;

/* ──────────────────────────── small building blocks ─────────────────────── */

const SectionTitle: React.FC<{
  icon: React.ElementType;
  children: React.ReactNode;
}> = ({ icon: Icon, children }) => (
  <h3 className="text-sm font-bold text-ink mb-3 flex items-center gap-2">
    <Icon className="w-4 h-4 text-accent shrink-0" />
    {children}
  </h3>
);

const Panel: React.FC<{ className?: string; children: React.ReactNode }> = ({
  className,
  children,
}) => (
  <div className={cn("bg-raised border border-rule p-5", className)}>
    {children}
  </div>
);

/** A labelled fact. Used wherever a number needs its unit spelled out. */
const Stat: React.FC<{ label: string; value: string; hint?: string }> = ({
  label,
  value,
  hint,
}) => (
  <div className="border border-rule bg-inset p-3">
    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
      {label}
    </p>
    <p className="mt-1 font-mono text-ink tabular-nums">{value}</p>
    {hint && <p className="mt-1 text-xs text-muted leading-snug">{hint}</p>}
  </div>
);

/**
 * Terms belong to the step that introduces them, not to a sidebar that shows
 * every term on every step.
 */
const Terms: React.FC<{ items: Array<[string, string]> }> = ({ items }) => (
  <div className="border-t border-rule pt-4">
    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint mb-3">
      Terms on this page
    </p>
    <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
      {items.map(([term, def]) => (
        <div key={term} className="flex gap-2 text-xs leading-relaxed">
          <dt className="font-mono text-accent shrink-0">{term}</dt>
          <dd className="text-muted">{def}</dd>
        </div>
      ))}
    </dl>
  </div>
);

/* ─────────────────────────── interactive: LMSR ──────────────────────────── */

/**
 * The pricing curve, dragged rather than described.
 *
 * The curve is DRAWN from the same function that prices the dot, so the shape
 * responds to `b` instead of being a fixed decorative path with a marker
 * sliding along it.
 */
const LMSRCurve: React.FC = () => {
  const [q, setQ] = useState(0);
  const [dragging, setDragging] = useState(false);

  const B = 1000;
  const priceAt = useCallback(
    (net: number) => 1 / (1 + Math.exp(-net / B)),
    [],
  );

  const path = useMemo(() => {
    const pts: string[] = [];
    for (let x = 0; x <= 400; x += 8) {
      const net = (x / 400 - 0.5) * 4000;
      const y = 150 - priceAt(net) * 140;
      pts.push(`${x},${y.toFixed(1)}`);
    }
    return `M ${pts.join(" L ")}`;
  }, [priceAt]);

  const price = priceAt(q);
  const cx = (q / 4000 + 0.5) * 400;
  const cy = 150 - price * 140;

  const onMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const r = e.currentTarget.getBoundingClientRect();
      const ratio = (e.clientX - r.left) / r.width;
      setQ(Math.max(-2000, Math.min(2000, (ratio - 0.5) * 4000)));
    },
    [dragging],
  );

  return (
    <Panel>
      <div className="flex items-baseline justify-between mb-3">
        <SectionTitle icon={TrendingUp}>Price is inventory</SectionTitle>
        <span className="font-mono text-2xl text-ink tabular-nums">
          {(price * 100).toFixed(1)}%
        </span>
      </div>
      <div
        className="relative h-40 cursor-ew-resize select-none"
        onMouseDown={() => setDragging(true)}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
        onMouseMove={onMove}
      >
        {/* Theme tokens via currentColor, not hardcoded hex: the old chart
            drew #2a2a28 gridlines and a white marker ring, which only
            happened to work on one palette. */}
        <svg viewBox="0 0 400 160" className="w-full h-full text-accent">
          <g className="text-rule">
            <line x1="0" y1="80" x2="400" y2="80" stroke="currentColor" strokeDasharray="4" />
            <line x1="200" y1="0" x2="200" y2="160" stroke="currentColor" strokeDasharray="4" />
          </g>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx={cx} cy={cy} r="6" fill="currentColor" />
          <g className="text-faint" fontSize="9">
            <text x="4" y="156" fill="currentColor">$0.00</text>
            <text x="4" y="14" fill="currentColor">$1.00</text>
            <text x="396" y="156" fill="currentColor" textAnchor="end">
              more YES held →
            </text>
          </g>
        </svg>
      </div>
      <p className="text-xs text-muted mt-2 flex items-center gap-1.5">
        <Hand className="w-3.5 h-3.5 shrink-0 text-faint" />
        Drag across the chart: buying YES pushes the price up, buying NO pushes
        it down. Nobody quotes it — the curve does.
      </p>
    </Panel>
  );
};

/* ───────────────────── interactive: practice trade ──────────────────────── */

interface PracticeFill {
  isYes: boolean;
  usdc: number;
  shares: number;
  price: number;
  lp: number;
}

/**
 * A dry run of a curve trade.
 *
 * It shows its RESULT. The previous version updated two pieces of state that
 * no element rendered, so the button span a fake spinner, reset the amount to
 * 100, and left the reader with no evidence anything had happened.
 */
const PracticeTrade: React.FC<{
  fills: PracticeFill[];
  onFill: (f: PracticeFill) => void;
  onReset: () => void;
}> = ({ fills, onFill, onReset }) => {
  const [amount, setAmount] = useState("100");
  const [isYes, setIsYes] = useState(true);

  const FEE_BPS = 500; // matches amm_fee_bps on the deployed config
  const usdc = Number.parseFloat(amount || "0") || 0;
  const price = isYes ? 0.62 : 0.38;
  const fee = (usdc * FEE_BPS) / 10000;
  const shares = usdc > 0 ? (usdc - fee) / price : 0;

  const totalLp = fills.reduce((a, f) => a + f.lp, 0);

  return (
    <Panel>
      <SectionTitle icon={Coins}>Try it — nothing is submitted</SectionTitle>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {([true, false] as const).map((yes) => (
          <button
            key={String(yes)}
            type="button"
            onClick={() => setIsYes(yes)}
            className={cn(
              "p-3 border transition-colors text-left",
              isYes === yes
                ? "border-accent bg-inset"
                : "border-rule bg-inset hover:border-muted",
            )}
          >
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              {yes ? (
                <TrendingUp className="w-3 h-3" />
              ) : (
                <TrendingDown className="w-3 h-3" />
              )}
              {yes ? "Yes" : "No"}
            </span>
            <span className="block mt-1 font-mono text-xl text-ink tabular-nums">
              {yes ? "62" : "38"}¢
            </span>
          </button>
        ))}
      </div>

      <label
        htmlFor="practice-amount"
        className="block font-mono text-[10px] uppercase tracking-[0.12em] text-faint mb-2"
      >
        Amount (USDC)
      </label>
      <div className="flex gap-2 mb-3">
        {["50", "100", "500"].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setAmount(p)}
            className={cn(
              "flex-1 py-1.5 border font-mono text-xs tabular-nums transition-colors",
              amount === p
                ? "border-accent text-accent"
                : "border-rule text-muted hover:text-ink",
            )}
          >
            ${p}
          </button>
        ))}
      </div>
      <input
        id="practice-amount"
        type="number"
        min="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-full bg-inset border border-rule px-3 py-2 font-mono text-sm text-ink tabular-nums focus:border-accent focus:outline-none"
      />

      <dl className="mt-4 space-y-1.5 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted">Shares</dt>
          <dd className="font-mono text-ink tabular-nums">
            ~{shares.toFixed(1)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Fee (5%)</dt>
          <dd className="font-mono text-ink tabular-nums">
            ${fee.toFixed(2)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">LP minted back to you</dt>
          <dd className="font-mono text-accent tabular-nums">
            ${fee.toFixed(2)}
          </dd>
        </div>
      </dl>

      <Button
        variant="primary"
        className="w-full mt-4"
        disabled={usdc <= 0}
        onClick={() => onFill({ isYes, usdc, shares, price, lp: fee })}
      >
        Buy {isYes ? "Yes" : "No"}
      </Button>

      {fills.length > 0 && (
        <div className="mt-4 border-t border-rule pt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
              Your practice position
            </p>
            <button
              type="button"
              onClick={onReset}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted hover:text-ink"
            >
              Reset
            </button>
          </div>
          <ul className="space-y-1">
            {fills.map((f, i) => (
              <li
                key={i}
                className="flex items-center justify-between text-xs font-mono tabular-nums"
              >
                <span className={f.isYes ? "text-pos" : "text-neg"}>
                  {f.shares.toFixed(1)} {f.isYes ? "YES" : "NO"}
                </span>
                <span className="text-muted">
                  @ {(f.price * 100).toFixed(0)}¢ · ${f.usdc.toFixed(0)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted leading-relaxed">
            You now hold{" "}
            <strong className="text-ink font-mono">
              ${totalLp.toFixed(2)}
            </strong>{" "}
            of LP you never deposited for — it was minted from the fees you
            paid. That is the whole mechanism.
          </p>
        </div>
      )}
    </Panel>
  );
};

/* ──────────────────────────────── the page ──────────────────────────────── */

export const Learn = () => {
  const [step, setStep] = useState(0);
  const [fills, setFills] = useState<PracticeFill[]>([]);

  // Deep links. `/learn#liquidity` comes from the market page's liquidity
  // drawer; the step hashes let any surface point at a chapter.
  //
  // Keyed on the router's hash rather than read once on mount: following a
  // `/learn#liquidity` link while already ON /learn is a same-document
  // navigation, so nothing remounts and a mount-only effect never fires —
  // the link would silently do nothing, which is the exact case the market
  // drawer produces for anyone reading the tutorial with it open.
  const { hash } = useLocation();
  useEffect(() => {
    const raw = hash.replace(/^#/, "");
    if (!raw) return;
    const direct = STEPS.findIndex((s) => s.hash === raw);
    if (direct >= 0) {
      setStep(direct);
      return;
    }
    if (raw === "liquidity") {
      setStep(0);
      // The anchor only exists once chapter 1 has painted.
      window.requestAnimationFrame(() =>
        document
          .getElementById("liquidity")
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
    }
  }, [hash]);

  const go = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(STEPS.length - 1, next));
    setStep(clamped);
    history.replaceState(null, "", `#${STEPS[clamped].hash}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Arrow keys move between chapters, as in any paginated reader.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight") go(step + 1);
      if (e.key === "ArrowLeft") go(step - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, step]);

  return (
    <div className="min-h-dvh pb-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid lg:grid-cols-12 gap-8 items-start">
          {/* ── step rail ── */}
          <nav
            aria-label="Tutorial chapters"
            className="lg:col-span-3 min-w-0 lg:sticky lg:top-24"
          >
            {/* Horizontal chips on small screens, a vertical rail on desktop:
                six real labels do not fit across a phone. */}
            <ol className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
              {STEPS.map((s, i) => {
                const active = i === step;
                const done = i < step;
                return (
                  <li key={s.hash} className="shrink-0 lg:shrink">
                    <button
                      type="button"
                      onClick={() => go(i)}
                      aria-current={active ? "step" : undefined}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 border text-left transition-colors",
                        active
                          ? "border-accent bg-raised"
                          : "border-rule bg-inset hover:border-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "grid place-items-center w-6 h-6 shrink-0 font-mono text-[11px] tabular-nums",
                          active
                            ? "bg-accent text-canvas"
                            : done
                              ? "text-accent"
                              : "text-faint",
                        )}
                      >
                        {done ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={cn(
                            "block text-sm font-semibold",
                            active ? "text-ink" : "text-muted",
                          )}
                        >
                          {s.label}
                        </span>
                        <span className="hidden lg:block text-xs text-faint leading-snug">
                          {s.blurb}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          {/* ── chapter body ── */}
          <div className="lg:col-span-9 min-w-0">
            <Card className="border border-rule p-6 sm:p-8 space-y-8">
              {step === 0 && <Basics />}
              {step === 1 && <Creating />}
              {step === 2 && (
                <Trading
                  fills={fills}
                  onFill={(f) => setFills((p) => [...p, f])}
                  onReset={() => setFills([])}
                />
              )}
              {step === 3 && <Venues />}
              {step === 4 && <Resolution />}
              {step === 5 && <Start />}

              {/* ── pager ── */}
              <div className="flex items-center justify-between border-t border-rule pt-5">
                <Button
                  variant="ghost"
                  onClick={() => go(step - 1)}
                  disabled={step === 0}
                  className="gap-1.5"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </Button>
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
                  {step + 1} / {STEPS.length}
                </span>
                {step < STEPS.length - 1 ? (
                  <Button onClick={() => go(step + 1)} className="gap-1.5">
                    {STEPS[step + 1].label}
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                ) : (
                  <Link to="/explore">
                    <Button className="gap-1.5">
                      Browse markets
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </Link>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ─────────────────────────────── chapter 1 ──────────────────────────────── */

const Basics = () => (
  <div className="space-y-8">
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent mb-2">
        Chapter 1
      </p>
      <h2 className="text-h2 font-semibold text-ink mb-3">
        A market is a question with a price on it
      </h2>
      <p className="text-muted leading-relaxed">
        Every Soo market asks something that will have a definite answer —{" "}
        <em className="text-ink not-italic">
          will this happen by this date?
        </em>{" "}
        You buy YES or NO shares. When the market resolves, the winning side
        pays <strong className="text-ink">$1 per share</strong> and the other
        side pays nothing. The price of YES is therefore the market's estimate
        of the odds: 62¢ means the crowd thinks it is 62% likely.
      </p>
    </div>

    <div className="grid sm:grid-cols-3 gap-4">
      {[
        {
          icon: Rocket,
          title: "Anyone can create",
          body: "No listing committee. You fund a market's curve and it exists.",
        },
        {
          icon: Layers,
          title: "Two venues",
          body: "New markets trade against a curve; mature ones also get an on-chain orderbook.",
        },
        {
          icon: Scale,
          title: "Three ways to resolve",
          body: "An automated proof, a named adjudicator, or a bonded stranger — the creator chooses.",
        },
      ].map(({ icon: Icon, title, body }) => (
        <div key={title} className="border border-rule bg-raised p-4">
          <Icon className="w-5 h-5 text-accent mb-3" />
          <h3 className="font-semibold text-ink text-sm mb-1">{title}</h3>
          <p className="text-xs text-muted leading-relaxed">{body}</p>
        </div>
      ))}
    </div>

    {/* The market page's liquidity drawer deep-links here. */}
    <div id="liquidity" className="scroll-mt-24">
      <Panel>
        <SectionTitle icon={CircleDollarSign}>
          Liquidity, and why nobody deposits it
        </SectionTitle>
        <div className="space-y-3 text-sm text-muted leading-relaxed">
          <p>
            Most venues ask liquidity providers to deposit capital up front. Soo
            never does — a market's liquidity comes from two places, and neither
            is a deposit form.
          </p>
          <p>
            <strong className="text-ink">The creator's seed.</strong> Launching a
            market funds its curve, and the creator receives LP tokens for it.
            That seed is what makes the first trade possible.
          </p>
          <p>
            <strong className="text-ink">Fee rebates.</strong> Every trade on the
            curve before graduation mints the trader new LP worth the fee they
            just paid. Trading makes you a liquidity provider as a side effect —
            the fee itself stays in the pool, and what you receive is a claim on
            it rather than cash back.
          </p>
          <p>
            <strong className="text-ink">What LP is worth.</strong> Redeeming LP
            pays your share of the market's LP yield vault — the slice of
            trading fees set aside for liquidity providers, and nothing else.
            Fees reach that vault when anyone runs the permissionless
            distribution step, so the market page shows both what is claimable
            now and what is still pending.
          </p>
          <p>
            <strong className="text-ink">When you can redeem.</strong> LP unlocks
            the moment a market graduates, settles, or is dismissed — whichever
            happens first.
          </p>
        </div>
      </Panel>
    </div>

    <Panel>
      <SectionTitle icon={Sparkles}>What is actually different here</SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead>
            <tr className="text-faint border-b border-rule">
              <th className="pb-2 font-mono uppercase tracking-[0.12em] font-normal">
                &nbsp;
              </th>
              <th className="pb-2 font-mono uppercase tracking-[0.12em] font-normal">
                Typical venue
              </th>
              <th className="pb-2 font-mono uppercase tracking-[0.12em] font-normal text-ink">
                Soo
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              ["Creation", "Approved by the platform", "Permissionless"],
              [
                "Liquidity",
                "Deposited by dedicated LPs",
                "Minted to traders as fee rebates",
              ],
              [
                "Resolution",
                "One oracle, take it or leave it",
                "Three routes, every step on-chain",
              ],
            ].map(([k, a, b]) => (
              <tr key={k} className="border-b border-rule/40">
                <td className="py-3 text-muted">{k}</td>
                <td className="py-3 text-muted">{a}</td>
                <td className="py-3 text-ink">{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>

    <Terms
      items={[
        ["YES / NO", "the two sides; the winner pays $1 per share"],
        ["LP", "a claim on a market's fee pool, minted rather than deposited"],
      ]}
    />
  </div>
);

/* ─────────────────────────────── chapter 2 ──────────────────────────────── */

const Creating = () => (
  <div className="space-y-8">
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent mb-2">
        Chapter 2
      </p>
      <h2 className="text-h2 font-semibold text-ink mb-3">
        Someone has to pay for the first trade
      </h2>
      <p className="text-muted leading-relaxed">
        A brand-new market has no other side. The creator supplies it: they lock
        a deposit that funds the pricing curve, and in exchange they hold all of
        the market's LP until traders start earning their own. The deposit is
        not a fee — it is collateral the curve spends to take the other side of
        early trades.
      </p>
    </div>

    <Panel>
      <SectionTitle icon={CircleDollarSign}>How big is the deposit</SectionTitle>
      <p className="text-sm text-muted leading-relaxed mb-4">
        It follows from one parameter, <span className="font-mono text-ink">b</span>
        , which sets how much trading it takes to move the price. Deeper
        liquidity costs more to underwrite:{" "}
        <span className="font-mono text-ink">
          deposit = b × −ln(min(p, 1−p))
        </span>
        , which at even odds is just{" "}
        <span className="font-mono text-ink">b × ln 2</span>. Opening a market at
        lopsided odds costs more, not less.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ["Micro", "b = 100", "69 USDC"],
          ["Small", "b = 1k", "693 USDC"],
          ["Medium", "b = 10k", "6.9k USDC"],
          ["Large", "b = 100k", "69k USDC"],
        ].map(([tier, b, dep]) => (
          <Stat key={tier} label={tier} value={dep} hint={b} />
        ))}
      </div>
    </Panel>

    <Panel>
      <SectionTitle icon={Coins}>What the creator actually earns</SectionTitle>
      <ol className="space-y-3 text-sm">
        {[
          [
            "At launch",
            "The deposit is locked as the curve's collateral, and the creator holds 100% of the market's LP.",
          ],
          [
            "While trading",
            "Every trade pays a 5% fee. Part of it is minted to the trader as LP — so the creator's share of the pool falls as others earn theirs — and part accumulates for the fee split.",
          ],
          [
            "At graduation",
            "LP becomes redeemable. Redeeming pays a share of the LP yield vault: the fees, not the collateral.",
          ],
          [
            "After settlement",
            "Whatever collateral the curve did not spend paying out winners can be reclaimed by the creator.",
          ],
        ].map(([when, what], i) => (
          <li key={when} className="flex gap-3">
            <span className="font-mono text-[10px] text-accent tabular-nums pt-1 shrink-0">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="leading-relaxed">
              <strong className="text-ink">{when}.</strong>{" "}
              <span className="text-muted">{what}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 pt-4 border-t border-rule text-xs text-muted leading-relaxed">
        So a creator's upside is their share of the fees their market generates,
        and their risk is the collateral the curve spends on trades that go
        against it. A market nobody trades earns nothing — the deposit simply
        comes back.
      </p>
    </Panel>

    <Terms
      items={[
        ["b", "liquidity depth — how much volume it takes to move the price"],
        ["Deposit", "creator collateral that funds the curve, not a fee"],
        ["Graduation", "the moment fees equal the deposit and the book opens"],
      ]}
    />
  </div>
);

/* ─────────────────────────────── chapter 3 ──────────────────────────────── */

const Trading: React.FC<{
  fills: PracticeFill[];
  onFill: (f: PracticeFill) => void;
  onReset: () => void;
}> = ({ fills, onFill, onReset }) => (
  <div className="space-y-8">
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent mb-2">
        Chapter 3
      </p>
      <h2 className="text-h2 font-semibold text-ink mb-3">
        Trading the curve makes you an owner
      </h2>
      <p className="text-muted leading-relaxed">
        On a new market there is no order book and no counterparty — you trade
        against a formula. It always quotes a price, and that price moves with
        how much of each side it is holding.
      </p>
    </div>

    <div className="grid lg:grid-cols-2 gap-5 items-start">
      <LMSRCurve />
      <PracticeTrade fills={fills} onFill={onFill} onReset={onReset} />
    </div>

    <Panel>
      <SectionTitle icon={ArrowLeftRight}>Where your fee goes</SectionTitle>
      <div className="grid sm:grid-cols-3 gap-3">
        {[
          ["You pay 5%", "The whole fee goes into the market's fee pool."],
          [
            "The pool is split four ways",
            "Deepening the curve, the LP yield vault, the adjudicator, and the protocol treasury.",
          ],
          [
            "You are minted LP",
            "Separately, and only before graduation: new LP worth the fee you just paid. Not a refund — a claim on the pool it went into.",
          ],
        ].map(([h, b], i) => (
          <div key={h} className="border border-rule bg-inset p-3">
            <p className="font-mono text-[10px] text-accent tabular-nums mb-1">
              {String(i + 1).padStart(2, "0")}
            </p>
            <p className="text-sm font-semibold text-ink mb-1">{h}</p>
            <p className="text-xs text-muted leading-relaxed">{b}</p>
          </div>
        ))}
      </div>
    </Panel>

    <Panel>
      <SectionTitle icon={Lock}>Selling has a 24-hour lock</SectionTitle>
      <p className="text-sm text-muted leading-relaxed">
        Selling on the curve does not put USDC back in your wallet. The proceeds
        leave the pool and sit in a lock account of their own for 24 hours;
        after that you claim them in one more transaction. They are not
        spendable in the meantime — not on new trades, not on anything — which
        is the point: it stops a trader pumping a price, selling into the curve
        and leaving inside the same minute.
      </p>
      <p className="text-sm text-muted leading-relaxed mt-3">
        Selling on the orderbook has no lock, because there you are selling to
        another trader rather than to the pool.
      </p>
    </Panel>

    <Terms
      items={[
        ["LMSR", "the pricing formula; always quotes, never runs out"],
        ["Fee rebate", "the LP minted back to you from the fee you paid"],
        ["Sell lock", "24h before curve sale proceeds can be withdrawn"],
      ]}
    />
  </div>
);

/* ─────────────────────────────── chapter 4 ──────────────────────────────── */

const Venues = () => (
  <div className="space-y-8">
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent mb-2">
        Chapter 4
      </p>
      <h2 className="text-h2 font-semibold text-ink mb-3">
        Markets graduate from a curve to a book
      </h2>
      <p className="text-muted leading-relaxed">
        A market starts on the curve because that is the only way to trade with
        nobody else present. Once it has proven demand — cumulative fees equal
        to the creator's deposit — the on-chain orderbook opens. The curve stays
        open too, so there is always a quote.
      </p>
    </div>

    <div className="grid sm:grid-cols-3 gap-3">
      {[
        ["Bonding", "Curve only", "New market finding its price"],
        ["Graduation", "Fees = deposit", "The threshold, measured on-chain"],
        ["Orderbook", "Curve + book", "Both venues live at once"],
      ].map(([stage, state, note]) => (
        <div key={stage} className="border border-rule bg-raised p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
            {stage}
          </p>
          <p className="mt-1 text-sm font-semibold text-ink">{state}</p>
          <p className="mt-1 text-xs text-muted leading-relaxed">{note}</p>
        </div>
      ))}
    </div>

    <div className="grid sm:grid-cols-2 gap-5">
      <Panel>
        <SectionTitle icon={TrendingUp}>The curve</SectionTitle>
        <dl className="space-y-2 text-xs">
          {[
            ["Pricing", "LMSR formula"],
            ["Counterparty", "The pool itself"],
            ["Liquidity", "Always available"],
            ["Selling", "24h withdrawal lock"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-muted">{k}</dt>
              <dd className="text-ink text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel>
        <SectionTitle icon={Layers}>The orderbook</SectionTitle>
        <dl className="space-y-2 text-xs">
          {[
            ["Pricing", "Limit orders, 999 price levels"],
            ["Counterparty", "Another trader"],
            ["Position", "A signed balance in your seat"],
            ["Selling", "No lock"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-muted">{k}</dt>
              <dd className="text-ink text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>

    <Panel>
      <SectionTitle icon={Lock}>
        Both sides of a book trade post cash
      </SectionTitle>
      <div className="space-y-3 text-sm text-muted leading-relaxed">
        <p>
          There is no borrowing here and nothing to short on margin. Selling
          YES <em className="text-ink not-italic">is</em> buying NO: if YES
          trades at 62¢, the buyer puts up 62¢ and the seller puts up 38¢, and
          together they fund the whole dollar that the winner will be paid.
        </p>
        <p>
          So the market's vault holds exactly{" "}
          <strong className="text-ink">$1 for every open share</strong>, always.
          Settlement can never run short, because the money was there before the
          trade existed.
        </p>
        <p>
          Post a resting order and your side of that dollar is escrowed the
          moment you post it — held until someone fills you, or returned the
          moment you cancel. Closing a position you already hold releases the
          collateral behind it instead of asking for more.
        </p>
      </div>
    </Panel>

    <Panel>
      <SectionTitle icon={ArrowLeftRight}>Why two venues stay honest</SectionTitle>
      <p className="text-sm text-muted leading-relaxed">
        When the curve and the book disagree, anyone can buy on the cheaper one
        and sell on the dearer one until they agree. That is not a special role
        — it is available to every trader, and it is what keeps the two prices
        from drifting apart.
      </p>
    </Panel>

    <Terms
      items={[
        ["Seat", "your position in a market's book: one signed number"],
        ["Tick", "a price level, 1¢ to 99.9¢ on a single YES axis"],
        ["Escrow", "the cash held behind a resting order until it fills"],
        ["Graduation", "fees reaching 100% of the creator's deposit"],
      ]}
    />
  </div>
);

/* ─────────────────────────────── chapter 5 ──────────────────────────────── */

const Resolution = () => (
  <div className="space-y-8">
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent mb-2">
        Chapter 5
      </p>
      <h2 className="text-h2 font-semibold text-ink mb-3">
        Deciding what actually happened
      </h2>
      <p className="text-muted leading-relaxed">
        This is the part every prediction market gets judged on. A market is
        only as good as the answer it settles to, so Soo does not have one
        oracle. The creator picks one of three routes when they make the
        market — and an adjudicated market can later hand the decision to a
        committee rather than one key.
      </p>
    </div>

    <div className="grid sm:grid-cols-3 gap-4">
      {[
        {
          icon: ShieldCheck,
          name: "Automatic",
          gist: "A machine-checkable rule is committed at creation. A resolver watches the source and submits a cryptographic proof of what it served. No human is asked.",
        },
        {
          icon: Gavel,
          name: "Adjudicated",
          gist: "A named person rules — the creator, or an authority chosen at creation. Every ruling they have ever made is public and scored.",
        },
        {
          icon: Coins,
          name: "Optimistic",
          gist: "Nobody is appointed. After the deadline anyone can assert the outcome by posting a bond. Unchallenged, it stands. Challenged, an arbiter decides and the loser's bond pays the winner.",
        },
      ].map(({ icon: Icon, name, gist }) => (
        <div key={name} className="border border-rule bg-raised p-4">
          <div className="flex items-center gap-2 mb-2">
            <Icon className="w-4 h-4 text-accent shrink-0" />
            <h3 className="font-semibold text-ink text-sm">{name}</h3>
          </div>
          <p className="text-xs text-muted leading-relaxed">{gist}</p>
        </div>
      ))}
    </div>

    <Panel>
      <SectionTitle icon={Users}>
        An adjudicator can hand the decision to a committee
      </SectionTitle>
      <p className="text-sm text-muted leading-relaxed">
        This is not a fourth choice at creation — it is something the
        adjudicator of an existing market can do at any point before it
        settles. They convene up to five attestors and set a threshold; members
        then cast public, changeable votes, and the vote that brings agreement
        up to the threshold writes the outcome. Downstream nothing can tell the
        difference between that and a single key ruling.
      </p>
      <p className="text-sm text-muted leading-relaxed mt-3">
        It is additive: the convening authority keeps their own ability to
        attest alone. A committee that does not trust its convener should be
        the authority itself, through a multisig.
      </p>
    </Panel>

    <Panel>
      <SectionTitle icon={Timer}>Every route ends the same way</SectionTitle>
      <ol className="space-y-3 text-sm">
        {[
          [
            "The deadline passes",
            "Trading closes. The market is waiting for an answer, not for more bets.",
          ],
          [
            "Someone attests",
            "Whichever route applies produces one outcome, written on-chain.",
          ],
          [
            "A veto window opens",
            "The dispute authority, or any guardian they deputised, can reject a ruling during this window — forcing a fresh one that gets its own full window.",
          ],
          [
            "Anyone settles it",
            "Once the window closes, settlement is permissionless. Winners redeem.",
          ],
        ].map(([h, b], i) => (
          <li key={h} className="flex gap-3">
            <span className="font-mono text-[10px] text-accent tabular-nums pt-1 shrink-0">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="leading-relaxed">
              <strong className="text-ink">{h}.</strong>{" "}
              <span className="text-muted">{b}</span>
            </span>
          </li>
        ))}
      </ol>
    </Panel>

    <div className="grid sm:grid-cols-2 gap-5">
      <Panel>
        <SectionTitle icon={Scale}>A veto rejects, it never decides</SectionTitle>
        <p className="text-sm text-muted leading-relaxed">
          A guardian can throw out a ruling they believe is wrong, but they
          cannot put their own answer in its place — the adjudicator must rule
          again. And they can only do it three times per market, so a guardian
          cannot stall a market forever by vetoing every attempt.
        </p>
      </Panel>
      <Panel>
        <SectionTitle icon={Timer}>Trades made after the fact are refunded</SectionTitle>
        <p className="text-sm text-muted leading-relaxed">
          An event usually happens before anyone records it. Soo marks the
          moment it actually happened, and anything bought after that point is
          refunded at cost rather than paid out — so being fast to the news is
          not the same as being right.
        </p>
      </Panel>
    </div>

    <Link
      to="/adjudicators"
      className="flex items-center gap-3 border border-accent bg-raised hover:bg-inset transition-colors p-4 group"
    >
      <Gavel className="w-5 h-5 text-accent shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">
          Every adjudicator's record is public
        </span>
        <span className="block text-xs text-muted">
          Rulings, vetoes, response times and bonded outcomes, scored from
          on-chain history.
        </span>
      </span>
      <ChevronRight className="w-4 h-4 text-accent shrink-0 transition-transform group-hover:translate-x-0.5" />
    </Link>

    <Terms
      items={[
        ["Attest", "writing the outcome on-chain"],
        ["Veto", "rejecting a ruling; capped at three per market"],
        ["Bond", "money staked behind an asserted outcome"],
        ["Settle", "paying out winners — permissionless once final"],
      ]}
    />
  </div>
);

/* ─────────────────────────────── chapter 6 ──────────────────────────────── */

const Start = () => (
  <div className="space-y-8">
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent mb-2">
        Chapter 6
      </p>
      <h2 className="text-h2 font-semibold text-ink mb-3">
        Pick somewhere to start
      </h2>
      <p className="text-muted leading-relaxed">
        Nothing here needs permission. Every link below is a live surface on
        devnet.
      </p>
    </div>

    <div className="grid sm:grid-cols-2 gap-4">
      {[
        {
          to: "/explore",
          icon: TrendingUp,
          title: "Browse markets",
          body: "See what is open, and buy a side.",
        },
        {
          to: "/forge",
          icon: Rocket,
          title: "Create a market",
          body: "Ask a question, fund the curve, choose how it resolves.",
        },
        {
          to: "/locker",
          icon: GraduationCap,
          title: "Your positions",
          body: "Holdings, LP, and any markets you are responsible for ruling.",
        },
        {
          to: "/adjudicators",
          icon: Gavel,
          title: "Adjudicator records",
          body: "Who rules well, scored from public history.",
        },
      ].map(({ to, icon: Icon, title, body }) => (
        <Link
          key={to}
          to={to}
          className="border border-rule bg-raised hover:border-accent transition-colors p-4 group"
        >
          <Icon className="w-5 h-5 text-accent mb-3" />
          <h3 className="font-semibold text-ink text-sm group-hover:text-accent transition-colors">
            {title}
          </h3>
          <p className="text-xs text-muted mt-1 leading-relaxed">{body}</p>
        </Link>
      ))}
    </div>

    <Panel>
      <p className="text-sm text-muted leading-relaxed">
        This deployment runs on Solana devnet with a test USDC you can mint for
        free — nothing here is real money. Trade it like it is anyway; the
        prices only mean something if people do.
      </p>
    </Panel>
  </div>
);

export default Learn;
