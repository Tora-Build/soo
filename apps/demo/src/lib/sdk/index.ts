// Solana fork of the Geek-page SDK class.
//
// Upstream's Geek terminal mounts a class instance with EVM-shaped methods
// (`balance`, `buyyes`, `createmarket`, `simulate`, `executeCommand`, etc.)
// and feeds user input through `executeCommand`. The Solana fork keeps the
// class shape so Geek.tsx compiles unchanged, but every method routes through
// the @sooth/sdk-solana adapter + chain-shim dispatchers instead of wagmi.
//
// The command surface is the working set of the EVM terminal: discovery
// (`markets`, `setmarket`), lifecycle (`createmarket`, `graduate`, `settle`,
// `dismiss`), trading on both venues (`buyyes`/`buyno`/`sell`, `place`/
// `cancelorder`), the claims (`redeem`, `claim`, `claimrefund`, `redeemlp`),
// and the seeded order-flow generator (`simulate`). Upstream's recording
// harness (`scenario` / `record` / `playback` / `invariants`) is NOT ported —
// it replays EVM traces and has no Solana equivalent yet; those commands say
// so instead of pretending.

export type {
  OutputLine,
  OutputLineType,
  OutputCallback,
  CommandResult,
} from "@/lib/chain-shim";

import type {
  CommandResult,
  OutputLine,
  OutputLineType,
} from "@/lib/chain-shim";

// Tiny helper so inline `{ type: "info", text: "..." }` literals don't
// widen `type` to `string` when wrapped in array literals returned from
// methods (TS only narrows when the contextual type is OutputLine[]).
const line = (type: OutputLineType, text: string): OutputLine => ({
  type,
  text,
});
import { dispatchAmmWrite, NOT_HANDLED } from "@/lib/chain-shim/amm-bridge";
import type { SolanaChainAdapter, SignerRef } from "@sooth/sdk-solana";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  AccountLayout as TokenAccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { knownMarketRefs } from "../../features/arena/marketRegistry";
import {
  clearActors,
  createActors,
  loadActors,
  toBase58,
} from "./actors";

interface DemoLike {
  adapter: SolanaChainAdapter;
  userRef: string | null;
  signer: SignerRef | null;
  marketRef: string | null;
  connected: boolean;
}

function isDemoLike(v: unknown): v is DemoLike {
  return (
    !!v &&
    typeof v === "object" &&
    "adapter" in v &&
    "userRef" in v &&
    "marketRef" in v
  );
}

function extractDemo(args: unknown[]): DemoLike | null {
  // The 5th constructor arg from Geek.tsx is the demo context. EVM
  // upstream passes only the first 4 (chainId, publicClient,
  // walletClient, address) so we look at the tail and accept the first
  // arg shaped like a DemoCtx.
  for (const a of args) {
    if (isDemoLike(a)) return a;
  }
  return null;
}

function userBase58FromDemo(demo: DemoLike | null): string | null {
  if (!demo?.userRef) return null;
  return demo.userRef.replace(/^sol:/, "");
}

const WAD = 1_000_000_000_000_000_000n;

function fmtUsdc(baseUnits: bigint): string {
  // USDC is 6 decimals.
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
}

function fmtWadShares(wad: bigint, places = 4): string {
  const whole = wad / WAD;
  const frac = wad % WAD;
  return `${whole}.${frac
    .toString()
    .padStart(18, "0")
    .slice(0, Math.max(0, places))}`;
}

function toUsdcBaseUnits(s: string | undefined): bigint | null {
  if (!s) return null;
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded || "0");
}

function toWadShares(s: string | undefined): bigint | null {
  if (!s) return null;
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  const fracPadded = (frac + "000000000000000000").slice(0, 18);
  return BigInt(whole) * WAD + BigInt(fracPadded || "0");
}

/** LMSR YES price from the market snapshot, as a float in (0, 1). */
function yesPrice(qYes: bigint, qNo: bigint, b: bigint): number {
  if (b === 0n) return 0.5;
  // exp((qN - qY) / b) in float space; snapshot magnitudes are far below
  // the ~1e308 double ceiling for any market this UI can create.
  const x = Number(qNo - qYes) / Number(b);
  return 1 / (1 + Math.exp(x));
}

/**
 * Deterministic PRNG for `simulate`.
 *
 * A seeded LCG rather than Math.random because a failing simulation must be
 * REPRODUCIBLE: "simulate 20 5 42 broke the book" is a bug report, "it broke
 * once" is an anecdote. Same constants as glibc.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x1_0000_0000;
  };
}

type Out = { result: CommandResult; output: OutputLine[] };

/** A SignerRef over a local Keypair — signs in-page, no wallet popup. */
function keypairSigner(kp: Keypair): SignerRef {
  return {
    publicKey: kp.publicKey.toBase58(),
    signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => {
      const tx = Transaction.from(raw);
      tx.partialSign(kp);
      return tx.serialize({
        verifySignatures: false,
        requireAllSignatures: false,
      });
    },
  };
}
type Stream = (l: OutputLine) => void;

function fail(message: string, text?: string): Out {
  return {
    result: { success: false, message },
    output: [line("error", text ?? message)],
  };
}

// ─── SDK class ──────────────────────────────────────────────────────────────

export class SoothSDK {
  private demo: DemoLike | null;
  private connectedAddress: string | null = null;
  /**
   * `setmarket`'s choice, overriding the env-configured default.
   *
   * Held here rather than in the demo context: the terminal switching
   * markets must not re-point every other page mid-session.
   */
  private activeMarket: string | null = null;
  /** Last `markets` listing, so `setmarket <n>` can resolve an index. */
  private lastListing: string[] = [];
  /**
   * Faucet mint-authority override, JSON byte array.
   *
   * The deployed build reads the key Vite baked into the bundle; tests
   * inject the fixture's key here because Vite's env is loaded before any
   * test runs and cannot be stubbed after the fact.
   */
  faucetAuthorityBytes: string | null = null;

  constructor(...args: unknown[]) {
    this.demo = extractDemo(args);
    // Geek's 4th arg is the connected address (0x-shaped in the EVM-shim
    // sense — base58 with `0x` prefix on Solana). Stash it for echo
    // commands like `whoami`.
    const fourth = args[3];
    this.connectedAddress = typeof fourth === "string" ? fourth : null;
  }

  setAddress(addr: string): void {
    this.connectedAddress = addr;
  }
  setWalletClient(_wc: unknown): void {}

  /** The market every command acts on: `setmarket`'s pick, else the env default. */
  private marketRef(): string | null {
    return this.activeMarket ?? this.demo?.marketRef ?? null;
  }

  getMarketInfo(): { marketKey?: string; marketAddress?: string } {
    const ref = this.marketRef();
    if (!ref) return {};
    const pda = ref.replace(/^sol:/, "");
    return { marketKey: pda, marketAddress: pda };
  }
  getChainId(): number {
    return 0;
  }
  getContracts(): Record<string, unknown> {
    return {};
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async balance(): Promise<Out> {
    const demo = this.demo;
    const userBase58 = userBase58FromDemo(demo);
    if (!demo || !userBase58) {
      return fail(
        "No connected wallet",
        "No connected wallet — connect Phantom/Solflare from the navbar (network: Devnet).",
      );
    }
    const userPk = new PublicKey(userBase58);
    const conn = demo.adapter.connection;
    // Each read degrades independently: a connection that cannot answer one
    // of them (test harnesses, flaky RPC) must not take down the whole
    // balance line.
    let solText = "?";
    try {
      solText = ((await conn.getBalance(userPk)) / 1e9).toFixed(4);
    } catch {
      // leave "?"
    }
    const usdcMint = demo.adapter.bookMint;
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, userPk);
    let usdcBaseUnits = 0n;
    try {
      const r = await conn.getTokenAccountBalance(usdcAta);
      usdcBaseUnits = BigInt(r.value.amount);
    } catch {
      // ATA may not exist yet — show 0.
    }
    const output: OutputLine[] = [
      line("plain", `Wallet:  ${userBase58}`),
      line("plain", `SOL:     ${solText}`),
      line("plain", `USDC:    ${fmtUsdc(usdcBaseUnits)}`),
    ];
    const ref = this.marketRef();
    if (ref) {
      try {
        const pos = await demo.adapter.readPosition(ref, demo.userRef!);
        output.push(
          line(
            "plain",
            `YES:     ${fmtWadShares(pos.yesShares)} (market ${ref.replace(/^sol:/, "").slice(0, 8)}…)`,
          ),
          line("plain", `NO:      ${fmtWadShares(pos.noShares)}`),
        );
      } catch {
        // Position PDA may not exist yet for this user/market.
      }
    }
    return { result: { success: true, message: "" }, output };
  }

  async marketstatus(): Promise<Out> {
    const demo = this.demo;
    const ref = this.marketRef();
    if (!demo || !ref) {
      return fail(
        "No active market",
        "No active market — `markets` then `setmarket <n>`.",
      );
    }
    try {
      const snap = await demo.adapter.readSnapshot(ref);
      const m = snap.market;
      const lifecycle = m.isSettled
        ? `Settled (winning=${m.outcome ?? "?"})`
        : m.isLive
          ? "Live"
          : "Initializing";
      const p = yesPrice(m.qYes, m.qNo, m.b);
      const lines: OutputLine[] = [
        line("plain", `Market:    ${ref.replace(/^sol:/, "")}`),
        line("plain", `Lifecycle: ${lifecycle}`),
        line("plain", `YES price: ${p.toFixed(4)}`),
        line("plain", `qYes:      ${fmtWadShares(m.qYes)}`),
        line("plain", `qNo:       ${fmtWadShares(m.qNo)}`),
        line("plain", `b:         ${fmtWadShares(m.b)}`),
        line("plain", `Graduated: ${m.isGraduated}`),
      ];
      if (!m.isGraduated) {
        try {
          const g = await demo.adapter.readGraduationProgress(ref);
          lines.push(
            line(
              "plain",
              `Fees:      ${fmtWadShares(g.feesAccumulatedWad)} / ${fmtWadShares(g.thresholdWad)} (${(g.progressBps / 100).toFixed(1)}%)`,
            ),
          );
        } catch {
          // AmmState may not exist on a foreign market; the core lines stand.
        }
      }
      if (m.deadline !== undefined && m.deadline > 0n) {
        const d = new Date(Number(m.deadline) * 1000);
        lines.push(line("plain", `Deadline:  ${d.toISOString()}`));
      }
      return { result: { success: true, message: "" }, output: lines };
    } catch (e) {
      return fail(
        (e as Error).message,
        `marketstatus failed: ${(e as Error).message}`,
      );
    }
  }

  /** `markets` — every market this browser can see, numbered for `setmarket`. */
  async markets(): Promise<Out> {
    const demo = this.demo;
    if (!demo) return fail("No demo context");
    const refs = knownMarketRefs();
    if (refs.length === 0) {
      return fail("No markets", "No markets discovered yet.");
    }
    const active = this.marketRef();
    const output: OutputLine[] = [
      line("bold", `Markets (${refs.length})`),
    ];
    const listing: string[] = [];
    // One snapshot batch, not N round trips.
    let snaps: Awaited<ReturnType<SolanaChainAdapter["readSnapshots"]>>;
    try {
      snaps = await demo.adapter.readSnapshots(refs);
    } catch {
      snaps = [];
    }
    refs.forEach((ref, i) => {
      listing.push(ref);
      const snap = Array.isArray(snaps) ? snaps[i] : undefined;
      const pda = ref.replace(/^sol:/, "");
      const mark = ref === active ? "→" : " ";
      if (snap?.market) {
        const m = snap.market;
        const state = m.isSettled ? "settled" : m.isGraduated ? "book" : "amm";
        const p = yesPrice(m.qYes, m.qNo, m.b);
        output.push(
          line(
            "plain",
            `${mark} ${String(i).padStart(2)}  ${pda.slice(0, 8)}…  ${state.padEnd(7)} YES ${p.toFixed(2)}`,
          ),
        );
      } else {
        output.push(
          line("dim", `${mark} ${String(i).padStart(2)}  ${pda.slice(0, 8)}…  (unreadable)`),
        );
      }
    });
    this.lastListing = listing;
    output.push(line("dim", "setmarket <n|pubkey> to switch."));
    return { result: { success: true, message: "" }, output };
  }

  /** `setmarket <index|base58>` — point every subsequent command at one market. */
  async setMarket(keyOrIndex: string): Promise<Out> {
    const t = (keyOrIndex ?? "").trim();
    if (!t) return fail("Usage: setmarket <n|pubkey>");
    let pda: string | null = null;
    if (/^\d+$/.test(t)) {
      const idx = Number(t);
      const fromListing = this.lastListing[idx] ?? knownMarketRefs()[idx];
      if (!fromListing) return fail(`No market at index ${idx} — run \`markets\`.`);
      pda = fromListing.replace(/^sol:/, "");
    } else {
      try {
        pda = new PublicKey(t.replace(/^sol:/, "")).toBase58();
      } catch {
        return fail(`Not an index or a base58 pubkey: ${t}`);
      }
    }
    this.activeMarket = `sol:${pda}`;
    return {
      result: { success: true, message: pda },
      output: [line("success", `Active market: ${pda}`)],
    };
  }

  /** `book` — top of both sides of the on-chain orderbook. */
  async sbbook(): Promise<Out> {
    const demo = this.demo;
    const ref = this.marketRef();
    if (!demo || !ref) return fail("No active market");
    try {
      const book = await demo.adapter.readBook(ref);
      const output: OutputLine[] = [
        line("bold", `Book — ${book.orderCount} orders`),
        line("dim", "  side  tick   size(USDC)  seq"),
      ];
      const row = (o: { priceTick: number; amount: bigint; seq: bigint }, side: string) =>
        line(
          "plain",
          `  ${side}   ${String(o.priceTick).padStart(4)}   ${fmtUsdc(o.amount).padStart(10)}  ${o.seq}`,
        );
      for (const o of book.asks.slice(0, 5).reverse()) output.push(row(o, "ask"));
      output.push(line("dim", "  ────"));
      for (const o of book.bids.slice(0, 5)) output.push(row(o, "bid"));
      if (book.orderCount === 0) output.push(line("dim", "  (empty)"));
      return { result: { success: true, message: "" }, output };
    } catch (e) {
      return fail(
        (e as Error).message,
        `book failed (market may not be graduated): ${(e as Error).message}`,
      );
    }
  }

  /** `orders` — the connected wallet's resting orders, seq first so `cancelorder <seq>` works. */
  async sbstate(): Promise<Out> {
    const demo = this.demo;
    const ref = this.marketRef();
    const user = userBase58FromDemo(demo);
    if (!demo || !ref || !user) return fail("No active market / wallet");
    try {
      const book = await demo.adapter.readBook(ref);
      const mine = [...book.bids, ...book.asks].filter((o) => o.trader === user);
      if (mine.length === 0) {
        return {
          result: { success: true, message: "" },
          output: [line("dim", "No open orders.")],
        };
      }
      const output: OutputLine[] = [
        line("bold", `Open orders (${mine.length})`),
        line("dim", "  seq   side  tick   size(USDC)"),
        ...mine.map((o) =>
          line(
            "plain",
            `  ${String(o.seq).padEnd(5)} ${o.side === 0 ? "bid" : "ask"}   ${String(o.priceTick).padStart(4)}   ${fmtUsdc(o.amount)}`,
          ),
        ),
      ];
      return { result: { success: true, message: "" }, output };
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  async lpbalance(): Promise<Out> {
    const demo = this.demo;
    const ref = this.marketRef();
    if (!demo || !ref || !demo.userRef) return fail("No active market / wallet");
    try {
      const r = await demo.adapter.readLpRedemption(ref, demo.userRef);
      const info = r as unknown as Record<string, bigint | undefined>;
      const output: OutputLine[] = [line("bold", "LP position")];
      for (const [k, v] of Object.entries(info)) {
        if (typeof v === "bigint") {
          output.push(line("plain", `  ${k}: ${fmtWadShares(v)}`));
        }
      }
      return { result: { success: true, message: "" }, output };
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  // ─── Writes (route through chain-shim dispatchers) ───────────────────────

  private async writeViaShim(
    functionName: string,
    args: unknown[],
    as?: { userBase58: string; signer: SignerRef },
  ): Promise<Out> {
    const demo = this.demo;
    if (!demo) {
      return fail(
        "No demo context",
        "SDK not initialized — open the page from inside the app.",
      );
    }
    try {
      const out = await dispatchAmmWrite(
        { functionName, args },
        {
          adapter: demo.adapter,
          connection: demo.adapter.connection as never,
          userBase58: as?.userBase58 ?? userBase58FromDemo(demo) ?? undefined,
          signer: as?.signer ?? demo.signer,
        },
      );
      if (out === NOT_HANDLED) {
        return fail(
          "Not wired in Solana fork",
          "Solana fork: command not yet wired.",
        );
      }
      const sig = String(out).replace(/^0x/, "").slice(0, 16);
      return {
        result: { success: true, message: sig },
        output: [
          line("success", `${functionName} OK`),
          line("dim", `tx (synth hash): 0x${sig}…`),
        ],
      };
    } catch (e) {
      return fail(
        (e as Error).message,
        `${functionName} failed: ${(e as Error).message}`,
      );
    }
  }

  async mint(...args: unknown[]): Promise<Out> {
    // Faucet mint. Geek upstream calls `mint <amount>` (USDC, decimal).
    const arg0 = Array.isArray(args[0]) ? args[0][0] : args[0];
    const amount = toUsdcBaseUnits(typeof arg0 === "string" ? arg0 : "100");
    if (amount === null) {
      return fail("Bad amount", "Usage: mint <amount-usdc>  e.g. `mint 100`");
    }
    return this.writeViaShim("mint", [this.connectedAddress, amount]);
  }

  async buyyes(...args: unknown[]): Promise<Out> {
    return this.trade(1, false, args);
  }

  async buyno(...args: unknown[]): Promise<Out> {
    return this.trade(0, false, args);
  }

  /** `sell <shares> [yes|no]` — AMM sell; defaults to the YES leg. */
  async sell(...args: unknown[]): Promise<Out> {
    const flat = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const sideArg = typeof flat[1] === "string" ? flat[1].toLowerCase() : "yes";
    const outcome = sideArg === "no" ? 0 : 1;
    return this.trade(outcome as 0 | 1, true, [flat[0]]);
  }

  private async trade(
    outcome: 0 | 1,
    isSell: boolean,
    args: unknown[],
  ): Promise<Out> {
    const arg0 = Array.isArray(args[0]) ? args[0][0] : args[0];
    const arg1 = Array.isArray(args[0]) ? args[0][1] : args[1];
    const sharesWad = toWadShares(typeof arg0 === "string" ? arg0 : undefined);
    if (sharesWad === null) {
      const cmd = isSell ? "sell" : outcome === 1 ? "buyyes" : "buyno";
      return fail(
        "Bad amount",
        `Usage: ${cmd} <shares>${isSell ? " [yes|no]" : " [maxCostWad]"}  e.g. \`${cmd} 5\``,
      );
    }
    const market = this.marketRef();
    if (!market) return fail("No active market", "No active market.");
    const quoteLine = await this.quoteLine(market, outcome, isSell ? -sharesWad : sharesWad);
    let r: Out;
    if (isSell) {
      // Negative delta routes the bridge to `buildSell`; slippage floor 0
      // matches the EVM terminal's behaviour of "take what the curve gives".
      r = await this.writeViaShim("tradePositions", [market, outcome, -sharesWad, 0n]);
    } else {
      const maxCostWad =
        toWadShares(typeof arg1 === "string" ? arg1 : undefined) ??
        sharesWad * 2n; // sane default ceiling — 2x face value
      r = await this.writeViaShim("tradePositions", [
        market,
        outcome,
        sharesWad,
        maxCostWad,
      ]);
    }
    if (quoteLine && r.result.success) r.output.splice(1, 0, quoteLine);
    return r;
  }

  /**
   * "cost 2.53 USDC (fee 0.05)" for a prospective trade, or null.
   *
   * Advisory only: the chain re-prices inside the slippage bound, and a
   * market whose AmmState cannot be read still trades — it just trades
   * without a preview.
   */
  private async quoteLine(
    market: string,
    outcome: 0 | 1,
    deltaShares: bigint,
  ): Promise<OutputLine | null> {
    try {
      const q = await this.demo!.adapter.readQuote(market, outcome, deltaShares);
      const abs = q.netCost < 0n ? -q.netCost : q.netCost;
      const word = q.netCost < 0n ? "proceeds" : "cost";
      return line(
        "dim",
        `${word} ${fmtWadShares(abs, 2)} USDC (fee ${fmtWadShares(q.fee, 2)})`,
      );
    } catch {
      return null;
    }
  }

  /** `place <bid|ask> <tick 1-999> <usdc>` — resting order on the book. */
  async sbmint(...args: unknown[]): Promise<Out> {
    const flat = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const sideArg = typeof flat[0] === "string" ? flat[0].toLowerCase() : "";
    const side = sideArg === "bid" ? 0 : sideArg === "ask" ? 1 : -1;
    const tick = Number(flat[1] ?? NaN);
    const amount = toUsdcBaseUnits(typeof flat[2] === "string" ? flat[2] : undefined);
    if (side === -1 || !Number.isInteger(tick) || tick < 1 || tick > 999 || amount === null) {
      return fail(
        "Bad args",
        "Usage: place <bid|ask> <tick 1-999> <usdc>  e.g. `place bid 450 25`",
      );
    }
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.placeWithInit(market, side, tick, amount);
  }

  /**
   * Places an order, creating the book first when it does not exist yet.
   *
   * Graduation flips the venue but allocates nothing, so the first order on
   * a freshly graduated market always finds no book account. Initializing it
   * here — once, on that exact error — makes `graduate` then `place` (and
   * `simulate` straight after) work in one sitting, which is the whole point
   * of a terminal.
   */
  private async placeWithInit(
    market: string,
    side: number,
    tick: number,
    amount: bigint,
    as?: { userBase58: string; signer: SignerRef },
  ): Promise<Out> {
    // Existence is checked by READING, not by pattern-matching the failed
    // write: an absent book surfaces as a program discriminator error whose
    // wording belongs to the program, and a client keyed to error prose
    // breaks the day the message is edited.
    let hasBook = true;
    try {
      await this.demo!.adapter.readBook(market);
    } catch {
      hasBook = false;
    }
    if (!hasBook) {
      const init = await this.writeViaShim("bookInit", [market], as);
      if (!init.result.success) return init;
    }
    const placed = await this.writeViaShim("bookPlace", [market, side, tick, amount], as);
    if (!hasBook && placed.result.success) {
      return {
        result: placed.result,
        output: [
          line("info", "Book account created (first order on this market)."),
          ...placed.output,
        ],
      };
    }
    return placed;
  }

  /** `cancelorder <seq>` — seqs come from `orders`. */
  async sbcancel(...args: unknown[]): Promise<Out> {
    const flat = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const seqRaw = typeof flat[0] === "string" ? flat[0] : "";
    if (!/^\d+$/.test(seqRaw)) {
      return fail("Bad args", "Usage: cancelorder <seq>  (see `orders`)");
    }
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim("bookCancel", [market, BigInt(seqRaw)]);
  }

  async redeem(): Promise<Out> {
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim("redeemAmmPosition", [market]);
  }

  async claim(): Promise<Out> {
    return this.writeViaShim("claimUnlocked", [this.marketRef()]);
  }

  async claimrefund(): Promise<Out> {
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim("claimRefund", [market]);
  }

  async dismiss(): Promise<Out> {
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim("dismissMarket", [market]);
  }

  async settle(): Promise<Out> {
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim("settle", [market]);
  }

  async redeemlp(...args: unknown[]): Promise<Out> {
    const flat = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const market = this.marketRef();
    if (!market) return fail("No active market");
    const shares = toWadShares(typeof flat[0] === "string" ? flat[0] : undefined);
    return this.writeViaShim("redeemLp", [market, shares ?? 0n]);
  }

  async sbredeem(): Promise<Out> {
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim("redeemBookSeat", [market]);
  }

  // ─── Streamed lifecycle commands (Geek.tsx passes `out`) ─────────────────

  /**
   * `createmarket <question…> [b]` — question words, then an optional
   * numeric b (USDC-denominated LMSR depth, default 1000).
   */
  async createmarket(args: unknown[], out?: Stream): Promise<Out> {
    const words = (Array.isArray(args) ? args : [args]).map(String);
    let b = 1000n;
    if (words.length > 1 && /^\d+$/.test(words[words.length - 1]!)) {
      b = BigInt(words.pop()!);
    }
    const question = words.join(" ").trim();
    if (question.length < 10) {
      return fail(
        "Question too short",
        'Usage: createmarket <question…> [b]  e.g. `createmarket Will BTC be above $100k by 2027? 1000`',
      );
    }
    const output: OutputLine[] = [];
    const emit = (l: OutputLine) => {
      output.push(l);
      out?.(l);
    };
    emit(line("info", `Creating market: "${question}" (b=${b})`));
    // Dispatcher shape: [question, startTime, deadline, adjudicator, initialB].
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
    const r = await this.writeViaShim("createMarket", [
      question,
      0n,
      deadline,
      undefined,
      b * WAD,
    ]);
    for (const l of r.output) emit(l);
    if (r.result.success) {
      // The bridge stashes the new PDA on a global side channel before submit.
      const g = globalThis as unknown as { __soothCreatedMarketPdas?: string[] };
      const pda = g.__soothCreatedMarketPdas?.[g.__soothCreatedMarketPdas.length - 1];
      if (pda) {
        this.activeMarket = `sol:${pda}`;
        emit(line("success", `Active market → ${pda}`));
      }
      emit(line("dim", "Deadline defaulted to 7 days. `marketstatus` to inspect."));
    }
    return { result: r.result, output };
  }

  /**
   * `graduate [stepShares] [maxRounds]` — push the active market over the
   * fee threshold with balanced both-leg buys, exactly like
   * scripts/graduate-market.mjs: same size on YES and NO each round, so the
   * price stays near 0.50 while only the fee pool grows.
   */
  async graduate(args: unknown[], out?: Stream): Promise<Out> {
    const flat = (Array.isArray(args) ? args : [args]).map(String);
    const step = toWadShares(flat[0] || "50") ?? 50n * WAD;
    const maxRounds = /^\d+$/.test(flat[1] ?? "") ? Number(flat[1]) : 50;
    const demo = this.demo;
    const ref = this.marketRef();
    if (!demo || !ref) return fail("No active market");

    const output: OutputLine[] = [];
    const emit = (l: OutputLine) => {
      output.push(l);
      out?.(l);
    };

    let snap = await demo.adapter.readSnapshot(ref);
    if (snap.market.isGraduated) {
      emit(line("success", "Already graduated."));
      return { result: { success: true, message: "" }, output };
    }
    emit(line("info", `Graduating with ${fmtWadShares(step, 0)}-share rounds (max ${maxRounds})…`));

    let spentWad = 0n;
    for (let round = 0; round < maxRounds; round++) {
      for (const outcome of [1, 0] as const) {
        try {
          const q = await demo.adapter.readQuote(ref, outcome, step);
          spentWad += q.netCost;
        } catch {
          // No preview — the on-chain trade is still exact.
        }
        const r = await this.writeViaShim("tradePositions", [
          ref,
          outcome,
          step,
          step * 2n, // a share never costs >1 USDC under LMSR; 2x is headroom
        ]);
        if (!r.result.success) {
          emit(line("error", `round ${round} ${outcome === 1 ? "YES" : "NO"} leg failed: ${r.result.message}`));
          return { result: r.result, output };
        }
      }
      const g = await demo.adapter.readGraduationProgress(ref);
      emit(
        line(
          "plain",
          `round ${round}: spent ~${fmtWadShares(spentWad, 2)} USDC · fees ${fmtWadShares(g.feesAccumulatedWad, 2)} / ${fmtWadShares(g.thresholdWad, 2)} (${(g.progressBps / 100).toFixed(1)}%)`,
        ),
      );
      if (g.isGraduated) {
        snap = await demo.adapter.readSnapshot(ref);
        emit(line("success", `Graduated after ${round + 1} round(s), ~${fmtWadShares(spentWad, 2)} USDC through the curve. Book venue is live.`));
        return { result: { success: true, message: "" }, output };
      }
    }
    emit(line("warn", `Not graduated after ${maxRounds} rounds — raise stepShares or maxRounds.`));
    return { result: { success: false, message: "max rounds" }, output };
  }

  /**
   * `simulate [N] [avgSize] [seed]` — seeded pseudo-random order flow
   * against the active market. Pre-graduation it mixes AMM buys and sells;
   * post-graduation it rests book orders around the current price. Same
   * seed, same market state → same run, which is what makes a failing
   * simulation a reproducible bug report instead of an anecdote.
   */
  async simulate(args: unknown[], out?: Stream): Promise<Out> {
    const flat = (Array.isArray(args) ? args : [args]).map(String);
    const n = /^\d+$/.test(flat[0] ?? "") ? Number(flat[0]) : 10;
    const avg = /^\d+(\.\d+)?$/.test(flat[1] ?? "") ? Number(flat[1]) : 5;
    const seed = /^\d+$/.test(flat[2] ?? "") ? Number(flat[2]) : 42;
    const demo = this.demo;
    const ref = this.marketRef();
    if (!demo || !ref) return fail("No active market");

    const output: OutputLine[] = [];
    const emit = (l: OutputLine) => {
      output.push(l);
      out?.(l);
    };
    const rand = lcg(seed);
    const snap = await demo.adapter.readSnapshot(ref);
    const graduated = snap.market.isGraduated;

    // With a funded fleet every step signs in-page as a different actor —
    // zero popups, and the tape shows distinct traders instead of one wallet
    // talking to itself. Without one, every step is the connected wallet
    // (and on a real wallet extension, a confirmation each).
    const fleet = loadActors();
    const cast: Array<{ label: string; as?: { userBase58: string; signer: SignerRef } }> =
      fleet.length > 0
        ? fleet.map((kp, i) => ({
            label: `a${i}`,
            as: { userBase58: kp.publicKey.toBase58(), signer: keypairSigner(kp) },
          }))
        : [{ label: "you" }];

    emit(
      line(
        "bold",
        `Simulation — ${n} ${graduated ? "book orders" : "AMM trades"}, avg ${avg}, seed ${seed}, ${fleet.length > 0 ? `${fleet.length} actors` : "connected wallet"}`,
      ),
    );

    let ok = 0;
    let failures = 0;
    let streak = 0;
    // Sells only spend what this run bought — per actor, because a position
    // belongs to the wallet that opened it.
    const bought = new Map<string, [bigint, bigint]>();

    for (let i = 0; i < n; i++) {
      const size = Math.max(0.5, avg * (0.5 + rand()));
      const actor = cast[i % cast.length]!;
      const held = bought.get(actor.label) ?? ([0n, 0n] as [bigint, bigint]);
      let r: Out;
      let desc: string;
      if (graduated) {
        const m = snap.market;
        const mid = Math.round(yesPrice(m.qYes, m.qNo, m.b) * 1000);
        const side = rand() < 0.5 ? 0 : 1;
        const offset = 1 + Math.floor(rand() * 40);
        const tick = Math.min(999, Math.max(1, side === 0 ? mid - offset : mid + offset));
        const amount = toUsdcBaseUnits(size.toFixed(2))!;
        desc = `${actor.label}: place ${side === 0 ? "bid" : "ask"} @${tick} ${size.toFixed(2)} USDC`;
        r = await this.placeWithInit(ref, side, tick, amount, actor.as);
      } else {
        const outcome = (rand() < 0.5 ? 0 : 1) as 0 | 1;
        const sharesWad = toWadShares(size.toFixed(2))!;
        const canSell = held[outcome] >= sharesWad;
        const isSell = canSell && rand() < 0.3;
        desc = `${actor.label}: ${isSell ? "sell" : "buy"} ${outcome === 1 ? "YES" : "NO"} ${size.toFixed(2)}`;
        r = await this.writeViaShim(
          "tradePositions",
          [ref, outcome, isSell ? -sharesWad : sharesWad, isSell ? 0n : sharesWad * 2n],
          actor.as,
        );
        if (r.result.success) {
          held[outcome] += isSell ? -sharesWad : sharesWad;
          bought.set(actor.label, held);
        }
      }
      if (r.result.success) {
        ok++;
        streak = 0;
        const cost = r.output.find((l) => /^(cost|proceeds)/.test(l.text))?.text;
        emit(line("plain", `  ${String(i + 1).padStart(3)}/${n}  ${desc}  ✓${cost ? `  (${cost})` : ""}`));
      } else {
        failures++;
        streak++;
        emit(line("warn", `  ${String(i + 1).padStart(3)}/${n}  ${desc}  ✗ ${(r.result.message ?? "").slice(0, 60)}`));
        if (streak >= 3) {
          emit(line("error", "3 consecutive failures — aborting run."));
          break;
        }
      }
    }

    const after = await demo.adapter.readSnapshot(ref);
    const m = after.market;
    emit(line("plain", ""));
    emit(line("bold", `Done: ${ok} ok, ${failures} failed.`));
    emit(line("plain", `YES price now ${yesPrice(m.qYes, m.qNo, m.b).toFixed(4)}  q=(${fmtWadShares(m.qYes, 1)}, ${fmtWadShares(m.qNo, 1)})`));
    return {
      result: { success: failures === 0, message: `${ok}/${n}` },
      output,
    };
  }

  // ─── Actors — burner wallets that sign without popups ────────────────────

  /**
   * `actors` / `actors create N` / `actors fund <sol> <usdc>` /
   * `actors export <n>` / `actors clear`.
   *
   * The fleet exists so `simulate` can move a market at chain speed: a wallet
   * extension confirms every transaction, and the demo of "how fast is this"
   * must not be a demo of clicking. Funding is the single confirmed
   * transaction in the whole flow — one SOL transfer from the connected
   * wallet fans out to every actor, and the USDC mint after it is signed by
   * the faucet key this deployment already ships.
   */
  private async actorsCmd(rest: string[]): Promise<Out> {
    const sub = (rest[0] ?? "").toLowerCase();
    if (sub === "create") {
      const n = /^\d+$/.test(rest[1] ?? "") ? Number(rest[1]) : 5;
      if (n < 1 || n > 32) return fail("actors create takes 1..32");
      const fresh = createActors(n);
      return {
        result: { success: true, message: String(n) },
        output: [
          line("success", `Created ${n} actor(s); fleet is ${loadActors().length}.`),
          ...fresh.map((k, i) => line("dim", `  +${i} ${k.publicKey.toBase58()}`)),
          line("plain", "Fund them: actors fund 0.05 500"),
        ],
      };
    }
    if (sub === "clear") {
      clearActors();
      return {
        result: { success: true, message: "" },
        output: [
          line("warn", "Fleet forgotten. Keys not exported first are unrecoverable."),
        ],
      };
    }
    if (sub === "export") {
      const idx = Number(rest[1] ?? NaN);
      const fleet = loadActors();
      const kp = fleet[idx];
      if (!kp) return fail(`No actor ${rest[1] ?? ""} — fleet has ${fleet.length}.`);
      return {
        result: { success: true, message: kp.publicKey.toBase58() },
        output: [
          line("bold", `Actor ${idx} — ${kp.publicKey.toBase58()}`),
          line("plain", "Secret key (base58, Phantom → Import Private Key):"),
          line("plain", `  ${toBase58(kp.secretKey)}`),
          line("warn", "Anyone with this string owns the wallet. Devnet or not, treat it like a key."),
        ],
      };
    }
    if (sub === "fund") {
      return this.actorsFund(rest[1], rest[2]);
    }
    // default: list with balances
    const fleet = loadActors();
    if (fleet.length === 0) {
      return {
        result: { success: true, message: "" },
        output: [
          line("plain", "No actors. `actors create 10` makes a fleet;"),
          line("plain", "`actors fund 0.05 500` funds it with one wallet confirmation."),
        ],
      };
    }
    const demo = this.demo;
    const output: OutputLine[] = [line("bold", `Actors (${fleet.length})`)];
    // Raw account reads, one batched RPC: lamports come straight off the
    // account, USDC off the decoded ATA. `getBalance` /
    // `getTokenAccountBalance` would be 2N calls and are the two methods
    // thin connections (test harnesses) tend not to implement.
    let infos: ({ lamports: number; data: Uint8Array } | null)[] = [];
    if (demo) {
      const keys = fleet.flatMap((kp) => [
        kp.publicKey,
        getAssociatedTokenAddressSync(demo.adapter.bookMint, kp.publicKey),
      ]);
      try {
        infos = (await demo.adapter.connection.getMultipleAccountsInfo(keys)) as typeof infos;
      } catch {
        infos = [];
      }
    }
    for (const [i, kp] of fleet.entries()) {
      const wallet = infos[i * 2];
      const ata = infos[i * 2 + 1];
      const solText = wallet ? (wallet.lamports / 1e9).toFixed(3) : "0";
      let usdcText = "0";
      if (ata) {
        try {
          usdcText = fmtUsdc(TokenAccountLayout.decode(ata.data).amount);
        } catch {
          // Not a token account — leave 0.
        }
      }
      output.push(
        line(
          "plain",
          `  ${String(i).padStart(2)} ${kp.publicKey.toBase58().slice(0, 8)}…  SOL ${solText}  USDC ${usdcText}`,
        ),
      );
    }
    output.push(line("dim", "actors export <n> prints a key; actors clear forgets the fleet."));
    return { result: { success: true, message: "" }, output };
  }

  private async actorsFund(solArg?: string, usdcArg?: string): Promise<Out> {
    const demo = this.demo;
    const payerBase58 = userBase58FromDemo(demo);
    const signTx = demo?.signer?.signTransaction;
    if (!demo || !payerBase58 || !signTx) {
      return fail("No connected wallet", "Connect a wallet first — it pays the SOL.");
    }
    const fleet = loadActors();
    if (fleet.length === 0) return fail("No actors — `actors create 10` first.");
    const solEach = /^\d+(\.\d+)?$/.test(solArg ?? "") ? Number(solArg) : 0.05;
    const usdcEach = toUsdcBaseUnits(usdcArg ?? "500");
    if (usdcEach === null) return fail("Usage: actors fund <sol-each> <usdc-each>");
    const lamportsEach = Math.round(solEach * 1e9);
    const conn = demo.adapter.connection;
    const output: OutputLine[] = [];

    // 1. SOL: one transfer transaction, one wallet confirmation — the only
    //    popup in the entire actor flow, and the only spend of real funds.
    const payerPk = new PublicKey(payerBase58);
    const tx = new Transaction();
    for (const kp of fleet) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payerPk,
          toPubkey: kp.publicKey,
          lamports: lamportsEach,
        }),
      );
    }
    tx.feePayer = payerPk;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    try {
      const signed = await signTx(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );
      const sig = await conn.sendRawTransaction(signed, { skipPreflight: false });
      output.push(
        line("success", `SOL: ${solEach} × ${fleet.length} sent (${String(sig).slice(0, 12)}…).`),
      );
    } catch (e) {
      return fail((e as Error).message, `SOL funding failed: ${(e as Error).message}`);
    }

    // 2. USDC: minted straight to each actor, signed by the faucet key this
    //    deployment ships and fee-paid by the actor itself — no popups.
    const rawBytes =
      this.faucetAuthorityBytes ??
      (import.meta as unknown as { env?: Record<string, string | undefined> })
        .env?.VITE_TEST_MINT_AUTHORITY_BYTES;
    if (!rawBytes) {
      output.push(
        line("warn", "No faucet key in this build — actors have SOL but no USDC."),
      );
      return { result: { success: true, message: "" }, output };
    }
    let mintAuthority: Keypair;
    try {
      mintAuthority = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(rawBytes) as number[]),
      );
    } catch (e) {
      return fail(`faucet key unreadable: ${(e as Error).message}`);
    }
    const mints = [demo.adapter.bookMint];
    if (!demo.adapter.ammMint.equals(demo.adapter.bookMint)) {
      mints.push(demo.adapter.ammMint);
    }
    let minted = 0;
    for (const kp of fleet) {
      try {
        const mtx = new Transaction();
        for (const mint of mints) {
          const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
          mtx.add(
            createAssociatedTokenAccountIdempotentInstruction(
              kp.publicKey,
              ata,
              kp.publicKey,
              mint,
            ),
            createMintToInstruction(mint, ata, mintAuthority.publicKey, usdcEach),
          );
        }
        mtx.feePayer = kp.publicKey;
        mtx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        mtx.partialSign(kp, mintAuthority);
        await conn.sendRawTransaction(
          mtx.serialize({ requireAllSignatures: false, verifySignatures: false }),
          { skipPreflight: false },
        );
        minted++;
      } catch (e) {
        output.push(
          line("warn", `USDC mint to actor ${kp.publicKey.toBase58().slice(0, 8)}… failed: ${(e as Error).message}`),
        );
      }
    }
    output.push(
      line("success", `USDC: ${fmtUsdc(usdcEach)} × ${minted}/${fleet.length} minted, no confirmations needed.`),
    );
    output.push(line("plain", "`actors` shows balances; `simulate` now rotates through the fleet."));
    return { result: { success: minted === fleet.length, message: "" }, output };
  }

  // ─── Honest stubs ────────────────────────────────────────────────────────

  private notPorted(what: string): Out {
    return fail(
      "Not ported",
      `${what} replays EVM traces upstream and has no Solana equivalent yet.`,
    );
  }
  async approve(..._args: unknown[]): Promise<Out> {
    return fail("No approvals on Solana", "SPL tokens have no allowance step — just trade.");
  }
  async allowance(): Promise<Out> {
    return this.approve();
  }
  async trialstatus(..._args: unknown[]): Promise<Out> {
    return this.notPorted("trialstatus");
  }
  async transferlp(..._args: unknown[]): Promise<Out> {
    return this.notPorted("transferlp");
  }
  async pausestatus(..._args: unknown[]): Promise<Out> {
    return this.notPorted("pausestatus");
  }
  async sbSetMarket(keyOrIndex: string): Promise<Out> {
    return this.setMarket(keyOrIndex);
  }
  async sbmerge(..._args: unknown[]): Promise<Out> {
    return this.notPorted("mergeset");
  }
  async sbbalance(): Promise<Out> {
    return this.balance();
  }
  async sbprice(): Promise<Out> {
    return this.marketstatus();
  }
  async sbhistory(..._args: unknown[]): Promise<Out> {
    return this.notPorted("history");
  }

  // ─── Command parser ──────────────────────────────────────────────────────

  async executeCommand(input: string): Promise<Out> {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase() ?? "";
    const rest = parts.slice(1);
    switch (cmd) {
      case "":
        return { result: { success: true, message: "" }, output: [] };
      case "help":
      case "?":
        return {
          result: { success: true, message: "" },
          output: [
            line("bold", "Getting started"),
            line("plain", "  1. Connect Phantom or Solflare from the navbar, network set to Devnet."),
            line("plain", "     Your keys stay in your wallet — this app has no server and stores nothing."),
            line("plain", "  2. `mint 1000` gives you test USDC. Devnet SOL for fees: https://faucet.solana.com"),
            line("plain", "  3. `markets`, `setmarket 0`, then trade."),
            line("dim", "  Every write is a real on-chain transaction your wallet signs — graduate and"),
            line("dim", "  simulate submit one per step, so expect one approval each unless your wallet"),
            line("dim", "  offers auto-approve. More wallets = more accounts in your wallet extension."),
            line("plain", ""),
            line("bold", "Discovery"),
            line("plain", "  markets | m            list markets     setmarket <n|pubkey>"),
            line("plain", "  marketstatus | status  active-market snapshot + price"),
            line("bold", "Wallet"),
            line("plain", "  balance   whoami   mint <usdc>  — test-USDC faucet"),
            line("bold", "Actors — popup-free fleet for simulate"),
            line("plain", "  actors create 10       actors fund 0.05 500   (one confirmation total)"),
            line("plain", "  actors                 actors export <n>      actors clear"),
            line("bold", "AMM"),
            line("plain", "  buyyes <shares>   buyno <shares>   sell <shares> [yes|no]"),
            line("plain", "  createmarket <question…> [b]      graduate [step] [rounds]"),
            line("plain", "  simulate [N] [avgSize] [seed]     — seeded order flow"),
            line("bold", "Book (post-graduation)"),
            line("plain", "  book      orders      place <bid|ask> <tick> <usdc>"),
            line("plain", "  cancelorder <seq>     sbredeem"),
            line("bold", "Settlement"),
            line("plain", "  settle   redeem   claim   claimrefund   dismiss"),
            line("plain", "  redeemlp [shares]     lpbalance"),
          ],
        };
      case "whoami": {
        const u = userBase58FromDemo(this.demo);
        return {
          result: { success: !!u, message: u ?? "" },
          output: [
            u ? line("plain", u) : line("error", "No connected wallet."),
          ],
        };
      }
      case "market": {
        const m = this.marketRef();
        return {
          result: { success: !!m, message: m ?? "" },
          output: [
            m
              ? line("plain", m.replace(/^sol:/, ""))
              : line("error", "No active market."),
          ],
        };
      }
      case "markets":
      case "m":
        return this.markets();
      case "actors":
      case "actor":
        return this.actorsCmd(rest);
      case "setmarket":
        return this.setMarket(rest[0] ?? "");
      case "balance":
        return this.balance();
      case "marketstatus":
      case "status":
      case "state":
        return this.marketstatus();
      case "buyyes":
        return this.buyyes(rest);
      case "buyno":
        return this.buyno(rest);
      case "sell":
        return this.sell(rest);
      case "mint":
      case "faucet":
        return this.mint(rest);
      case "book":
        return this.sbbook();
      case "orders":
      case "positions":
        return this.sbstate();
      case "place":
        return this.sbmint(rest);
      case "cancelorder":
        return this.sbcancel(rest);
      case "sbredeem":
        return this.sbredeem();
      case "settle":
      case "finalize":
        return this.settle();
      case "redeem":
      case "redeemamm":
        return this.redeem();
      case "claim":
        return this.claim();
      case "claimrefund":
        return this.claimrefund();
      case "dismiss":
        return this.dismiss();
      case "redeemlp":
        return this.redeemlp(rest);
      case "lpbalance":
        return this.lpbalance();
      case "graduate":
        return this.graduate(rest);
      case "simulate":
        return this.simulate(rest);
      case "createmarket":
        return this.createmarket(rest);
      case "approve":
        return this.approve();
      case "allowance":
        return this.allowance();
      default:
        return {
          result: { success: false, message: `Unknown command: ${cmd}` },
          output: [
            line("error", `Unknown command: ${cmd}`),
            line("dim", 'Type "help" for the command list.'),
          ],
        };
    }
  }
}
