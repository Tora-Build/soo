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
const line = (type: OutputLineType, text: string, id?: string): OutputLine => ({
  type,
  text,
  ...(id ? { id } : {}),
});
import { dispatchAmmWrite, NOT_HANDLED } from "@/lib/chain-shim/amm-bridge";
import type { SolanaChainAdapter, SignerRef } from "@sooth/sdk-solana";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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

/**
 * Explicit compute budget for burst transactions.
 *
 * Without one, the runtime RESERVES the default — 200k per instruction, 600k
 * for a three-instruction trade — against the 12M CU-per-account-per-block
 * write cap, so exactly 20 bursting trades fit a block no matter that each
 * actually consumes ~115k. Measured on devnet: 114,841 CU for a live trade;
 * 160k leaves headroom without hoarding the block. 12M / 160k ≈ 75 per block.
 */
const BURST_CU_LIMIT = 160_000;

function fmtUsdc(baseUnits: bigint): string {
  // USDC is 6 decimals.
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
}

function fmtWadShares(wad: bigint, places = 4): string {
  const whole = wad / WAD;
  if (places <= 0) return `${whole}`;
  const frac = wad % WAD;
  return `${whole}.${frac.toString().padStart(18, "0").slice(0, places)}`;
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

/**
 * Local LMSR trade estimate in USDC — ΔC plus the 5% bonding fee, floats.
 *
 * The burst's est column used to be one readQuote RPC per row; forty rows of
 * that (on top of forty builds) tripped the proxied RPC's rate limits and
 * the throttling then slowed the very confirmation polls that stop the
 * clock. The cost function is closed-form and every input is already in the
 * snapshot, so the estimate is arithmetic, not I/O. Log-sum-exp with a shift
 * for stability; "est" in the header stays honest about the fee approximation.
 */
function lmsrEstUsdc(
  qYes: bigint,
  qNo: bigint,
  b: bigint,
  outcome: 0 | 1,
  deltaShares: number, // positive buy, negative sell
): number {
  const bf = Number(b) / 1e18;
  if (bf <= 0) return 0;
  const qy = Number(qYes) / 1e18;
  const qn = Number(qNo) / 1e18;
  const C = (a: number, c: number) => {
    const m = Math.max(a, c);
    return m + bf * Math.log(Math.exp((a - m) / bf) + Math.exp((c - m) / bf));
  };
  const before = C(qy, qn);
  const after = outcome === 1 ? C(qy + deltaShares, qn) : C(qy, qn + deltaShares);
  const delta = after - before; // positive on buys, negative on sells
  const fee = Math.abs(delta) * 0.05;
  return delta >= 0 ? -(delta + fee) : -delta - fee; // display sign: buys negative, sells positive net
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

/**
 * Actor identity is a hex pair: 00–ff.
 *
 * Two characters address 256 actors where a0–a9 style ran out of alignment
 * at ten, and every table column stays exactly two wide. Input accepts the
 * hex pair OR the legacy aN decimal form, tried in that order of shape.
 */
const actorLabel = (i: number) => i.toString(16).padStart(2, "0");

function parseActorRef(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  const legacy = /^a(\d+)$/.exec(t);
  if (legacy) return Number(legacy[1]);
  if (/^[0-9a-f]{1,2}$/.test(t)) return parseInt(t, 16);
  return null;
}

/** 0 NO · 1 YES · 2 INVALID, as the program's enum reads. */
function outcomeWord(outcome: number): string {
  return outcome === 1 ? "YES" : outcome === 0 ? "NO" : outcome === 2 ? "INVALID" : `?${outcome}`;
}

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
  /**
   * The scripted burst: exact (actor, side, outcome, size) rows the next
   * `burst` executes instead of random flow. In-memory on purpose — a plan
   * is choreography for the next run, not configuration.
   */
  private plan: Array<{
    actor: number;
    side: "buy" | "sell";
    outcome: 0 | 1;
    size: number;
  }> = [];
  /** Monotonic per-instance run counter, so two bursts' row ids never
   *  collide — colliding ids made a second burst overwrite the first
   *  burst's table in place. */
  private burstSeq = 0;

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
      const questionText = (m.question ?? "").replace(/§[a-z]+\s*/gi, " ").trim();
      const lines: OutputLine[] = [
        ...(questionText ? [line("bold", questionText)] : []),
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
        // The full PDA, copyable: a truncated prefix cannot be pasted into
        // setmarket, an explorer, or anything else that wants an address.
        const q = (snap.market.question ?? "").replace(/§[a-z]+\s*/gi, " ").trim();
        output.push(
          line(
            "plain",
            `${mark} ${String(i).padStart(2)}  ${state.padEnd(7)} YES ${p.toFixed(2)}  ${q.slice(0, 44) || "(no question text)"}`,
          ),
          line("dim", `        ${pda}`),
        );
      } else {
        output.push(
          line("dim", `${mark} ${String(i).padStart(2)}  (unreadable)      ${pda}`),
        );
      }
    });
    this.lastListing = listing;
    output.push(line("dim", "setmarket <n> or setmarket <full address> to switch; `market` prints the active one."));
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
    const quote = await this.tryQuote(market, outcome, isSell ? -sharesWad : sharesWad);
    const quoteLine = quote ? this.formatQuote(quote) : null;
    let r: Out;
    if (isSell) {
      // Slippage floor at 95% of quoted proceeds — the EVM terminal's anchor.
      // Floor 0 only when the quote itself was unreadable: "take what the
      // curve gives" beats refusing to sell on a read failure.
      const proceeds = quote && quote.netCost < 0n ? -quote.netCost : 0n;
      const minProceeds = (proceeds * 95n) / 100n;
      r = await this.writeViaShim("tradePositions", [market, outcome, -sharesWad, minProceeds]);
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
   * A trade preview, or null when the AmmState cannot be read.
   *
   * Advisory only: the chain re-prices inside the slippage bound, and a
   * market with no preview still trades.
   */
  private async tryQuote(
    market: string,
    outcome: 0 | 1,
    deltaShares: bigint,
  ): Promise<{ netCost: bigint; fee: bigint } | null> {
    try {
      return await this.demo!.adapter.readQuote(market, outcome, deltaShares);
    } catch {
      return null;
    }
  }

  private formatQuote(q: { netCost: bigint; fee: bigint }): OutputLine {
    const abs = q.netCost < 0n ? -q.netCost : q.netCost;
    const word = q.netCost < 0n ? "proceeds" : "cost";
    return line(
      "dim",
      `${word} ${fmtWadShares(abs, 2)} USDC (fee ${fmtWadShares(q.fee, 2)})`,
    );
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
   * `graduate` — computed, not ground out.
   *
   * The threshold is closed-form (`b·ln2`), the fee rate is on-chain config,
   * and LMSR is translation-invariant: a balanced pair (buy X YES + buy X NO)
   * costs exactly X and moves the price nowhere. So the volume that
   * graduates a market is arithmetic — deficit × 10000/feeBps — and the
   * whole climb is TWO transactions per payer instead of the old fifty-share
   * rounds inching up 0.2% a step.
   *
   * Actors pay first, largest balance first; the connected wallet is the
   * payer of last resort. If the combined fleet cannot cover the volume, the
   * command says exactly how much more to fund instead of burning rounds. A
   * refinement pass re-reads the chain afterwards, so any drift between this
   * model and the program's fee accounting costs one extra pair, not a wrong
   * answer.
   */
  async graduate(args: unknown[], out?: Stream): Promise<Out> {
    const flat = (Array.isArray(args) ? args : [args]).map(String).filter(Boolean);
    const demo = this.demo;
    const ref = this.marketRef();
    if (!demo || !ref) return fail("No active market");

    const output: OutputLine[] = [];
    const emit = (l: OutputLine) => {
      output.push(l);
      out?.(l);
    };
    const useWallet = flat[0]?.toLowerCase() === "wallet";
    if (flat.length > 0 && !useWallet) {
      emit(line("dim", "graduate is auto-planned now — `graduate` spends actors, `graduate wallet` spends the connected wallet."));
    }

    let g = await demo.adapter.readGraduationProgress(ref);
    if (g.isGraduated) {
      emit(line("success", "Already graduated."));
      return { result: { success: true, message: "" }, output };
    }
    const feeBps = Math.max(1, (await demo.adapter.readVenueFeeBps().catch(() => ({ amm: 500, book: 0 }))).amm || 500);

    // ── The plan, before any transaction ──
    const deficitWad = g.thresholdWad - g.feesAccumulatedWad;
    // 2% overshoot so rounding in the program's favour cannot strand the
    // market at 99.9%.
    const volumeWad = (deficitWad * 10_000n * 102n) / (BigInt(feeBps) * 100n);
    emit(line("bold", "Graduation plan"));
    emit(
      line(
        "plain",
        `fees ${fmtWadShares(g.feesAccumulatedWad, 2)} / ${fmtWadShares(g.thresholdWad, 2)} — deficit ${fmtWadShares(deficitWad, 2)} at ${feeBps} bps fee`,
      ),
    );
    emit(
      line(
        "plain",
        `requires ~${fmtWadShares(volumeWad, 2)} USDC of balanced volume (price-neutral pairs).`,
      ),
    );

    // ── Payers: actors by balance, connected wallet last ──
    interface Payer {
      label: string;
      userBase58: string;
      signer?: SignerRef;
      usdcWad: bigint;
    }
    const payers: Payer[] = [];
    const fleet = useWallet ? [] : loadActors();
    if (fleet.length > 0) {
      try {
        const conn = demo.adapter.connection;
        const atas = fleet.map((kp) =>
          getAssociatedTokenAddressSync(demo.adapter.bookMint, kp.publicKey),
        );
        const infos = await conn.getMultipleAccountsInfo(atas);
        fleet.forEach((kp, i) => {
          let usdc = 0n;
          const info = infos[i];
          if (info) {
            try {
              usdc = TokenAccountLayout.decode(info.data).amount;
            } catch {
              usdc = 0n;
            }
          }
          payers.push({
            label: actorLabel(i),
            userBase58: kp.publicKey.toBase58(),
            signer: keypairSigner(kp),
            usdcWad: usdc * 1_000_000_000_000n,
          });
        });
      } catch {
        // Unreadable balances — the connected wallet still stands.
      }
    }
    // The connected wallet joins ONLY when asked for by name. The default is
    // the fleet: every wallet transaction is a popup, and springing even one
    // on a founder who built a fleet to avoid them is the wrong surprise.
    const me = useWallet ? userBase58FromDemo(demo) : null;
    if (me) {
      // Raw account decode, not getTokenAccountBalance — the thin
      // connections that lack the RPC method are exactly where a zero here
      // would wrongly bench the richest payer.
      let usdc = 0n;
      try {
        const ata = getAssociatedTokenAddressSync(demo.adapter.bookMint, new PublicKey(me));
        const info = await demo.adapter.connection.getAccountInfo(ata);
        if (info) usdc = TokenAccountLayout.decode(info.data).amount;
      } catch {
        usdc = 0n;
      }
      payers.push({ label: "you", userBase58: me, usdcWad: usdc * 1_000_000_000_000n });
    }
    // Actors first — richest actor to poorest — and the connected wallet
    // strictly last. Sorting purely by balance put the founder's wallet at
    // the front, so a funded fleet watched its human click through the
    // popups it existed to remove. Capacity keeps 10% margin for the fee
    // and curve asymmetry (the two legs split X unevenly around the price).
    payers.sort((a, b) => {
      const aWallet = a.signer === undefined ? 1 : 0;
      const bWallet = b.signer === undefined ? 1 : 0;
      if (aWallet !== bWallet) return aWallet - bWallet;
      return a.usdcWad > b.usdcWad ? -1 : 1;
    });
    const capacity = (p: Payer) => (p.usdcWad * 90n) / 100n;
    const assignments: Array<{ payer: Payer; sizeWad: bigint }> = [];
    let remaining = volumeWad;
    for (const p of payers) {
      if (remaining <= 0n) break;
      const take = capacity(p) < remaining ? capacity(p) : remaining;
      if (take < WAD) continue; // sub-1-USDC pairs are noise
      assignments.push({ payer: p, sizeWad: take });
      remaining -= take;
    }
    if (remaining > 0n) {
      const total = payers.reduce((acc, p) => acc + capacity(p), 0n);
      const short = volumeWad - total;
      const perActor = fleet.length > 0 ? short / BigInt(fleet.length) + 1n : short;
      return {
        result: { success: false, message: "insufficient funds" },
        output: [
          ...output,
          line("error", `Not enough USDC across actors + wallet: need ~${fmtWadShares(volumeWad, 2)}, usable ~${fmtWadShares(total, 2)}.`),
          line(
            "plain",
            useWallet
              ? "Top up the connected wallet, or fund the fleet and run plain `graduate`."
              : fleet.length > 0
                ? `\`actors fund 0 ${Math.ceil(Number(perActor / WAD))}\` closes the gap and keeps it popup-free — or \`graduate wallet\` to spend the connected wallet.`
                : "`actors create 10` then `actors fund 0.05 <usdc>` — or `graduate wallet` to spend the connected wallet.",
          ),
        ],
      };
    }
    emit(
      line(
        "plain",
        `${assignments.length} payer(s), ${assignments.length * 2} transaction(s): ` +
          assignments.map((a) => `${a.payer.label} ${fmtWadShares(a.sizeWad, 0)}`).join(" · "),
      ),
    );

    // ── Execute: one YES leg + one NO leg per payer, streamed ──
    let legNo = 0;
    let txCount = 0;
    const runLeg = async (a: { payer: Payer; sizeWad: bigint }, outcome: 0 | 1): Promise<boolean> => {
      const id = `grad-${++legNo}`;
      const desc = `${a.payer.label}: buy ${outcome === 1 ? "YES" : "NO"} ${fmtWadShares(a.sizeWad, 2)}`;
      emit(line("pending", `  ${desc} …`, id));
      const r = await this.writeViaShim(
        "tradePositions",
        [ref, outcome, a.sizeWad, (a.sizeWad * 120n) / 100n],
        a.payer.signer
          ? { userBase58: a.payer.userBase58, signer: a.payer.signer }
          : undefined,
      );
      txCount++;
      emit(
        line(
          r.result.success ? "success" : "warn",
          `  ${desc} ${r.result.success ? "✓" : `✗ ${(r.result.message ?? "").slice(0, 60)}`}`,
          id,
        ),
      );
      return r.result.success;
    };
    for (const a of assignments) {
      if (!(await runLeg(a, 1))) return { result: { success: false, message: "leg failed" }, output };
      if (!(await runLeg(a, 0))) return { result: { success: false, message: "leg failed" }, output };
    }

    // ── Refinement: the chain is the referee, not the model ──
    for (let pass = 0; pass < 2; pass++) {
      g = await demo.adapter.readGraduationProgress(ref);
      if (g.isGraduated) break;
      const left = g.thresholdWad - g.feesAccumulatedWad;
      emit(line("plain", `fees ${fmtWadShares(g.feesAccumulatedWad, 2)} / ${fmtWadShares(g.thresholdWad, 2)} — refining.`));
      const top = assignments[0] ?? (payers[0] ? { payer: payers[0], sizeWad: 0n } : null);
      if (!top) break;
      const extra = (left * 10_000n * 110n) / (BigInt(feeBps) * 100n);
      const sized = { payer: top.payer, sizeWad: extra < WAD ? WAD : extra };
      if (!(await runLeg(sized, 1)) || !(await runLeg(sized, 0))) break;
    }
    g = await demo.adapter.readGraduationProgress(ref);
    if (g.isGraduated) {
      emit(line("success", `Graduated in ${txCount} transaction(s). Book venue is live.`));
      return { result: { success: true, message: String(txCount) }, output };
    }
    emit(line("warn", `Not graduated after ${txCount} transaction(s) — fees ${fmtWadShares(g.feesAccumulatedWad, 2)} / ${fmtWadShares(g.thresholdWad, 2)}. Run graduate again.`));
    return { result: { success: false, message: "not graduated" }, output };
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
            label: actorLabel(i),
            as: { userBase58: kp.publicKey.toBase58(), signer: keypairSigner(kp) },
          }))
        : [{ label: "you" }];

    emit(
      line(
        "bold",
        `Simulation — ${n} ${graduated ? "book orders" : "AMM trades"}, avg ${avg}, seed ${seed}, ${fleet.length > 0 ? `${fleet.length} actors` : "connected wallet"}`,
      ),
    );

    // Rent preflight. An actor's first trade on a market creates its Position
    // (~0.002 SOL, actor-paid), so a fleet that LOOKS funded can be unable to
    // open a single position — and without this check that surfaces as N
    // opaque code=1 failures instead of one sentence before any is spent.
    if (fleet.length > 0) {
      try {
        const infos = await demo.adapter.connection.getMultipleAccountsInfo(
          fleet.map((kp) => kp.publicKey),
        );
        const MIN_LAMPORTS = 4_500_000; // position rent + ATA rent + fees
        const short = infos.filter((a) => (a?.lamports ?? 0) < MIN_LAMPORTS).length;
        if (short > 0) {
          emit(
            line(
              "warn",
              `${short}/${fleet.length} actors hold under 0.0045 SOL — a first trade on a market pays ~0.002 SOL position rent (plus ~0.002 for a missing token account). \`actors fund 0.01 0\` prevents mid-run failures.`,
            ),
          );
        }
      } catch {
        // A preflight that cannot read balances must not block the run.
      }
    }

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
        emit(line("warn", `  ${String(i + 1).padStart(3)}/${n}  ${desc}  ✗ ${(r.result.message ?? "").slice(0, 90)}`));
        if (streak >= 3) {
          emit(line("error", "3 consecutive failures — aborting run."));
          // Translated from a live reproduction, not the error table: code=1
          // on a first trade is almost always the SYSTEM program refusing the
          // Position account's rent — an actor's first play on a market pays
          // ~0.002 SOL for its position (and ~0.002 more if a venue token
          // account is missing). Token InsufficientFunds shares the code, so
          // both refills are named.
          if (/code=1\b/.test(r.result.message ?? "") && fleet.length > 0) {
            emit(
              line(
                "info",
                "code=1 means an account ran short mid-transaction. Most often it is the actor's SOL — the first trade on a market pays ~0.002 SOL rent — so `actors fund 0.01 0` tops that up; if `actors` shows USDC 0, `actors fund 0 500` instead.",
              ),
            );
          }
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
          ...fresh.map((k, i) => line("dim", `  +${actorLabel(loadActors().length - fresh.length + i)} ${k.publicKey.toBase58()}`)),
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
      const idx = parseActorRef(rest[1] ?? "") ?? NaN;
      const fleet = loadActors();
      const kp = fleet[idx];
      if (!kp) return fail(`No actor ${rest[1] ?? ""} — fleet has ${fleet.length}.`);
      return {
        result: { success: true, message: kp.publicKey.toBase58() },
        output: [
          line("bold", `Actor ${actorLabel(idx)} — ${kp.publicKey.toBase58()}`),
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
          `  ${actorLabel(i)} ${kp.publicKey.toBase58().slice(0, 8)}…  SOL ${solText}  USDC ${usdcText}`,
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
      // The mints below are FEE-PAID BY THE ACTORS, so this transfer must have
      // landed before any of them is submitted — on devnet, "sent" precedes
      // "spendable" by a slot or two, and racing it fails every mint at once.
      await this.waitForFunds(fleet[0]!.publicKey, lamportsEach);
      output.push(
        line("success", `SOL: ${solEach} × ${fleet.length} confirmed (${String(sig).slice(0, 12)}…).`),
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

  /**
   * Blocks until `who` holds at least `lamports`, or ~20s pass.
   *
   * Confirmation by OUTCOME, not by signature status: the question the
   * caller needs answered is "can this account pay a fee yet", and reading
   * the account answers it on every connection — including test harnesses
   * that process transactions synchronously and never index signatures.
   */
  private async waitForFunds(who: PublicKey, lamports: number): Promise<void> {
    const conn = this.demo!.adapter.connection;
    for (let i = 0; i < 40; i++) {
      try {
        const info = await conn.getAccountInfo(who);
        if ((info?.lamports ?? 0) >= lamports) return;
      } catch {
        // Fall through to the wait.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("SOL transfer not visible after 20s — check the wallet approved it");
  }

  // ─── Resolution lifecycle ────────────────────────────────────────────────

  /**
   * `resolution` — where the active market stands on the road to settlement.
   *
   * The lifecycle the program enforces:
   *   lock (permissionless, past deadline) → attest (entry authority only)
   *   → veto window → settle (permissionless) → redeem.
   * Each line below states a fact from the chain; the hint at the end is the
   * one step that is actually available next.
   */
  private async resolutionCmd(): Promise<Out> {
    const demo = this.demo;
    const ref = this.marketRef();
    if (!demo || !ref) return fail("No active market");
    const state = await demo.adapter.readResolutionState(ref);
    if (!state) return fail("Market unreadable");
    const output: OutputLine[] = [
      line("bold", `Resolution — ${ref.replace(/^sol:/, "").slice(0, 12)}…`),
      line("plain", `Lifecycle:   ${state.lifecycle}${state.isDismissed ? " (dismissed)" : ""}`),
      line("plain", `Deadline:    ${new Date(Number(state.deadline) * 1000).toISOString()}`),
      line("plain", `Adjudicator: ${state.adjudicator}`),
    ];
    const entry = state.adjudicatorEntry;
    let hint = "";
    if (state.lifecycle === "Settled") {
      output.push(line("success", `Settled — winning outcome ${outcomeWord(state.winningOutcome)}.`));
      hint = "redeem pays this wallet's winning shares.";
    } else if (!entry) {
      output.push(line("warn", "No adjudicator entry — nobody can attest yet."));
      hint = "register [authority] creates the entry (creator only, or protocol authority).";
    } else if (entry.attestedOutcome === null) {
      output.push(line("plain", `Entry:       authority ${entry.authority.slice(0, 8)}… — not attested`));
      hint =
        state.lifecycle === "Locked"
          ? "attest <yes|no|invalid> — signer must be the entry authority."
          : "lock — permissionless once the deadline has passed.";
    } else {
      const vetoSecs = (await demo.adapter.readVetoPeriodSecs()) ?? 0;
      const vetoEndsAt = Number(entry.attestedAt ?? 0n) + vetoSecs;
      output.push(
        line("plain", `Attested:    ${outcomeWord(entry.attestedOutcome)} at ${new Date(Number(entry.attestedAt) * 1000).toISOString()}`),
        line("plain", `Veto ends:   ${new Date(vetoEndsAt * 1000).toISOString()} (${vetoSecs}s window)`),
      );
      if (entry.disputed) output.push(line("warn", "DISPUTED — the veto was used."));
      hint = "settle — permissionless once the veto window has run out.";
    }
    if (hint) output.push(line("dim", `Next: ${hint}`));
    return { result: { success: true, message: state.lifecycle }, output };
  }

  async lock(): Promise<Out> {
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim("requestLock", [market]);
  }

  async attest(...args: unknown[]): Promise<Out> {
    const flat = (Array.isArray(args[0]) ? (args[0] as unknown[]) : args).map(String);
    const word = (flat[0] ?? "").toLowerCase();
    const outcome = word === "yes" ? 1 : word === "no" ? 0 : word === "invalid" ? 2 : -1;
    if (outcome === -1) {
      return fail("Bad outcome", "Usage: attest <yes|no|invalid>  — signer must be the entry authority");
    }
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim("attestOutcome", [market, outcome]);
  }

  async register(...args: unknown[]): Promise<Out> {
    const flat = (Array.isArray(args[0]) ? (args[0] as unknown[]) : args).map(String);
    const market = this.marketRef();
    if (!market) return fail("No active market");
    return this.writeViaShim(
      "registerAdjudicator",
      flat[0] ? [market, flat[0]] : [market],
    );
  }

  /**
   * `plan <actor> <buy|sell> <yes|no> <size>` — choreograph the next burst.
   *
   * Random flow shows that a market moves; a plan shows a STORY: a2 dumps,
   * a5 buys the dip, and the price does what the reader predicted. Rows
   * accumulate; bare `plan` shows the table; `plan clear` returns burst to
   * random flow.
   */
  private planCmd(rest: string[]): Out {
    const sub = (rest[0] ?? "").toLowerCase();
    if (sub === "clear") {
      this.plan = [];
      return {
        result: { success: true, message: "" },
        output: [line("plain", "Plan cleared — burst is random flow again.")],
      };
    }
    if (sub !== "") {
      const actorIdx = parseActorRef(sub) ?? -1;
      const side = (rest[1] ?? "").toLowerCase();
      const outcomeWordArg = (rest[2] ?? "").toLowerCase();
      const size = Number(rest[3] ?? NaN);
      const fleetSize = loadActors().length;
      if (fleetSize === 0) {
        return fail("No actors", "No actors yet — `actors create 10` first.");
      }
      if (
        !Number.isInteger(actorIdx) ||
        actorIdx < 0 ||
        actorIdx >= fleetSize ||
        (side !== "buy" && side !== "sell") ||
        (outcomeWordArg !== "yes" && outcomeWordArg !== "no") ||
        !Number.isFinite(size) ||
        size <= 0
      ) {
        return fail(
          "Bad plan row",
          `Usage: plan <00..${actorLabel(fleetSize - 1)}> <buy|sell> <yes|no> <size>   e.g. \`plan 02 sell yes 5\``,
        );
      }
      this.plan.push({
        actor: actorIdx,
        side: side as "buy" | "sell",
        outcome: outcomeWordArg === "yes" ? 1 : 0,
        size,
      });
    }
    if (this.plan.length === 0) {
      return {
        result: { success: true, message: "" },
        output: [
          line("plain", "No plan. `plan a0 buy yes 10` adds a row; `burst` then executes the plan."),
        ],
      };
    }
    const output: OutputLine[] = [
      line("bold", `Burst plan — ${this.plan.length} row(s)`),
      line("dim", "  #   actor  action     size"),
      ...this.plan.map((r, i) =>
        line(
          "plain",
          `  ${String(i + 1).padEnd(3)} ${actorLabel(r.actor).padEnd(6)} ${(r.side + " " + (r.outcome === 1 ? "YES" : "NO")).padEnd(10)} ${r.size.toFixed(2)}`,
        ),
      ),
      line("dim", "`burst` executes this; `plan clear` discards it."),
    ];
    return { result: { success: true, message: String(this.plan.length) }, output };
  }

  /**
   * `burst [N] [avgSize] [seed]` — every trade signed up front, fired at
   * once, throughput measured.
   *
   * `simulate` is sequential and confirmation-gated because a readable tape
   * is its job; this command's job is the opposite question — how fast can
   * the market move — so nothing waits on anything. All N trades share one
   * blockhash, go out together via sendRawTransaction, and a single status
   * poll times the gap from first send to last confirmation. They all
   * write-lock the same market accounts, so the chain executes them
   * serially — the speed shown is real contention on one market, not an
   * embarrassingly-parallel best case.
   *
   * Buys only: a sell's precondition is a position whose existence depends
   * on an earlier trade in the SAME burst, and ordering inside a burst is
   * the scheduler's choice, not ours.
   */
  async burst(args: unknown[], out?: Stream): Promise<Out> {
    const flat = (Array.isArray(args) ? args : [args]).map(String);
    const n = /^\d+$/.test(flat[0] ?? "") ? Number(flat[0]) : 10;
    const avg = /^\d+(\.\d+)?$/.test(flat[1] ?? "") ? Number(flat[1]) : 3;
    const seed = /^\d+$/.test(flat[2] ?? "") ? Number(flat[2]) : 42;
    const demo = this.demo;
    const ref = this.marketRef();
    if (!demo || !ref) return fail("No active market");
    const fleet = loadActors();
    if (fleet.length === 0) {
      return fail(
        "No actors",
        "burst needs the fleet — every transaction is signed in-page. `actors create 10` then `actors fund 0.05 500`.",
      );
    }

    const output: OutputLine[] = [];
    const emit = (l: OutputLine) => {
      output.push(l);
      out?.(l);
    };
    const rand = lcg(seed);
    const conn = demo.adapter.connection;

    // (venue announced after the snapshot read below)

    // Build + sign everything before a single byte is sent, so the send
    // window measures the network, not our build loop.
    const toIx = (m: {
      ixProgramId?: string;
      programId?: string;
      ixKeys?: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
      keys?: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
      ixData?: string;
      data?: string;
    }) =>
      new TransactionInstruction({
        programId: new PublicKey((m.ixProgramId ?? m.programId)!),
        keys: (m.ixKeys ?? m.keys ?? []).map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Buffer.from((m.ixData ?? m.data)!, "base64"),
      });

    // Venue follows the market, exactly as `simulate` does: a graduated
    // market's writes are book orders — its AMM refuses trades, and a burst
    // of refusals measures nothing.
    const preSnap = await demo.adapter.readSnapshot(ref);
    const graduated = preSnap.market.isGraduated;
    const mid = Math.round(
      yesPrice(preSnap.market.qYes, preSnap.market.qNo, preSnap.market.b) * 1000,
    );

    // The cast: the scripted plan when one exists, random flow otherwise.
    interface BurstEntry {
      label: string;
      kp: Keypair;
      side: "buy" | "sell";
      outcome: 0 | 1;
      size: number;
      skip?: string;
    }
    const planned = this.plan.length > 0;
    if (planned && graduated) {
      return fail(
        "Plan needs the bonding curve",
        "Planned bursts are AMM buys and sells; this market has graduated to the order book. `plan clear`, or pick a bonding market.",
      );
    }
    // A graduated market's book account only exists once someone paid its
    // rent — and the burst built straight against it, so a first burst on a
    // fresh book was forty instant on-chain failures. Same ensure-then-write
    // the single `place` command uses, with the first actor paying.
    if (graduated) {
      let book: Awaited<ReturnType<SolanaChainAdapter["readBook"]>> | null = null;
      try {
        book = await demo.adapter.readBook(ref);
      } catch {
        const init = await this.writeViaShim("bookInit", [ref], {
          userBase58: fleet[0]!.publicKey.toBase58(),
          signer: keypairSigner(fleet[0]!),
        });
        if (!init.result.success) {
          return fail("Book init failed", `The order book account could not be created: ${init.result.message ?? ""}`);
        }
        emit(line("info", "Book account created (first orders on this market)."));
      }
      if (book && book.orderCount + n > book.capacity) {
        emit(
          line(
            "warn",
            `Book holds ${book.orderCount}/${book.capacity} resting orders — up to ${book.orderCount + n - book.capacity} of this burst may fail with a full book. Cancel resting orders or burst smaller.`,
          ),
        );
      }
    }

    let entries: BurstEntry[];
    if (planned) {
      entries = [];
      for (const row of this.plan) {
        const kp = fleet[row.actor];
        if (!kp) {
          entries.push({ label: actorLabel(row.actor), kp: fleet[0]!, side: row.side, outcome: row.outcome, size: row.size, skip: "no such actor" });
          continue;
        }
        let skip: string | undefined;
        if (row.side === "sell") {
          // A sell's precondition is shares the actor ALREADY holds — a buy
          // in the same burst cannot supply them, because intra-burst
          // ordering belongs to the scheduler, not this list.
          try {
            const pos = await demo.adapter.readPosition(ref, `sol:${kp.publicKey.toBase58()}`);
            const held = row.outcome === 1 ? pos.yesShares : pos.noShares;
            if (held < toWadShares(row.size.toFixed(2))!) {
              skip = `holds ${fmtWadShares(held, 2)} ${row.outcome === 1 ? "YES" : "NO"}, cannot sell ${row.size.toFixed(2)}`;
            }
          } catch {
            skip = "no position on this market yet";
          }
        }
        entries.push({ label: actorLabel(row.actor), kp, side: row.side, outcome: row.outcome, size: row.size, skip });
      }
    } else {
      entries = Array.from({ length: n }, (_, i) => {
        const size = Math.max(0.5, avg * (0.5 + rand()));
        return {
          label: actorLabel(i % fleet.length),
          kp: fleet[i % fleet.length]!,
          side: "buy" as const,
          outcome: (rand() < 0.5 ? 0 : 1) as 0 | 1,
          size,
        };
      });
    }
    const liveEntries = entries.filter((e) => !e.skip);

    emit(
      line(
        "bold",
        planned
          ? `Burst — scripted plan, ${liveEntries.length} of ${entries.length} row(s) executable`
          : `Burst — ${n} ${graduated ? "book orders" : "AMM buys"}, ${fleet.length} actors, one market, no waiting`,
      ),
    );

    // ── The live table ──
    // Each row carries a stable id; re-emitting the id REPLACES the line, so
    // the same row walks queued → signed → sent → ✓ in place. Confirmations
    // arrive independently of send order — that is the point of the table:
    // the reader watches rows 7, 3 and 12 light up in whatever order the
    // chain settles them.
    const runId = ++this.burstSeq;
    const rowState: string[] = entries.map((e) => (e.skip ? `SKIP: ${e.skip}` : "· queued"));

    // Estimates are LOCAL arithmetic over the snapshot already in hand — an
    // RPC quote per row was what tripped the proxied RPC's rate limits and
    // slowed the confirmation polls that stop the throughput clock.
    const rowEst: string[] = entries.map((e) => {
      if (e.skip || graduated) return "—";
      const est = lmsrEstUsdc(
        preSnap.market.qYes,
        preSnap.market.qNo,
        preSnap.market.b,
        e.outcome,
        e.side === "sell" ? -e.size : e.size,
      );
      return `${est >= 0 ? "+" : "-"}${Math.abs(est).toFixed(2)}`;
    });
    // Random bursts render as a MATRIX — four transactions per display row,
    // each a compact cell whose glyph is its lifecycle — because sixty
    // one-line rows scroll the table off screen while the right half of the
    // terminal sits empty. Scripted plans keep the detailed one-per-row
    // table: a plan is a story with few rows, and the story reads best wide.
    const matrix = !planned;
    const CELLS = 4;
    const glyphOf = (st: string) =>
      st.startsWith("✓") ? "✓" : st.startsWith("✗") ? "✗" : st.startsWith("↻") ? "↻" : st.startsWith("→") ? "➤" : st.startsWith("⧗") ? "⧗" : "·";
    const cellText = (i: number) => {
      const e = entries[i]!;
      return `${glyphOf(rowState[i]!)} ${e.label}${e.outcome === 1 ? "Y" : "N"} ${e.size.toFixed(2).padStart(5)} ${rowEst[i]!.padStart(6)}`;
    };
    const matrixRowLine = (r: number) => {
      const cells: string[] = [];
      let allDone = true;
      for (let c = 0; c < CELLS; c++) {
        const i = r * CELLS + c;
        if (i >= entries.length) break;
        cells.push(cellText(i).padEnd(22));
        const st = rowState[i]!;
        if (!st.startsWith("✓") && !st.startsWith("✗")) allDone = false;
      }
      return line(allDone ? "plain" : "pending", `  ${cells.join("│ ")}`, `burst-${runId}-mrow-${r}`);
    };
    const emitCell = (i: number) => emit(matrixRowLine(Math.floor(i / CELLS)));
    const rowLine = (i: number) => {
      const e = entries[i]!;
      return line(
        e.skip
          ? "warn"
          : rowState[i]!.startsWith("✓")
            ? "success"
            : rowState[i]!.startsWith("✗")
              ? "warn"
              : "pending",
        `  ${String(i + 1).padEnd(3)} ${e.label.padEnd(6)} ${(e.side + " " + (e.outcome === 1 ? "YES" : "NO")).padEnd(10)} ${e.size.toFixed(2).padStart(6)}  ${rowEst[i]!.padStart(9)}  ${rowState[i]!}`,
        `burst-${runId}-row-${i}`,
      );
    };
    if (matrix) {
      emit(line("dim", "  · queued  ⧗ signed  ➤ sent  ↻ resent  ✓ confirmed  ✗ failed   (cell: actor·side size est)"));
      for (let r = 0; r * CELLS < entries.length; r++) emit(matrixRowLine(r));
    } else {
      emit(line("dim", "  #   actor  action     size    est.USDC  status"));
      for (let i = 0; i < entries.length; i++) emit(rowLine(i));
    }
    const paint = (i: number) => (matrix ? emitCell(i) : emit(rowLine(i)));
    if (liveEntries.length === 0) {
      return fail("Nothing executable", "Every plan row was skipped — see the reasons above.");
    }

    // ── Build + sign, all rows in parallel ──
    // Building is one RPC round trip per row; done sequentially it WAS the
    // visible slow phase. The signatures share one blockhash so the send
    // window that follows measures the network, not this loop.
    const { blockhash } = await conn.getLatestBlockhash();
    const liveIdx = entries.map((e, i) => (e.skip ? -1 : i)).filter((i) => i >= 0);
    const buildsForRetry: Array<{ actor: Keypair; ixs: TransactionInstruction[] }> = [];
    const signed: Uint8Array[] = [];
    // Bounded parallelism: eight builds in flight. Fully parallel builds are
    // what tripped the proxied RPC's rate limits — the throttling then
    // outlived the build phase and slowed the confirmation polls, which is
    // how a fully-confirmed burst reported 3.7 tx/s.
    const buildOne = async (i: number) => {
      const e = entries[i]!;
      const sharesWad = toWadShares(e.size.toFixed(2))!;
      const userRef = `sol:${e.kp.publicKey.toBase58()}`;
      const req = graduated
        ? await demo.adapter.buildBookPlace(ref, {
            user: userRef,
            side: e.outcome,
            limitTick: Math.min(
              999,
              Math.max(1, e.outcome === 0 ? mid - 1 - Math.floor(rand() * 40) : mid + 1 + Math.floor(rand() * 40)),
            ),
            amount: toUsdcBaseUnits(e.size.toFixed(2))!,
            matchLimit: 8,
            postRemainder: true,
          })
        : e.side === "sell"
          ? await demo.adapter.buildSell(ref, {
              outcome: e.outcome,
              deltaShares: sharesWad,
              minProceedsWad: 0n,
              user: userRef,
            })
          : await demo.adapter.buildTrade(ref, {
              side: "buy",
              outcome: e.outcome,
              deltaShares: sharesWad,
              maxCostWad: sharesWad * 2n,
              // @ts-expect-error — Solana-only meta channel; see adapter.ts.
              user: userRef,
            });
      const meta = req.meta as { preIxs?: unknown[] } & Record<string, unknown>;
      const ixs = [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: BURST_CU_LIMIT }),
        ...(meta.preIxs ?? []).map((pre) => toIx(pre as never)),
        toIx(meta as never),
      ];
      const tx = new Transaction();
      for (const ix of ixs) tx.add(ix);
      tx.feePayer = e.kp.publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(e.kp);
      rowState[i] = "⧗ signed";
      paint(i);
      return { i, actor: e.kp, ixs, raw: tx.serialize() };
    };
    // A build that throws costs ITS ROW, never the burst: a 429 mid-pool used
    // to reject the whole Promise.all and surface as a bare "Error: 429" with
    // half the table stuck on "queued". Rate limits get three tries with
    // growing backoff first, because a 429 is by definition temporary.
    const built: Array<Awaited<ReturnType<typeof buildOne>> | null> = new Array(liveIdx.length).fill(null);
    {
      let next = 0;
      const worker = async () => {
        for (;;) {
          const slot = next++;
          if (slot >= liveIdx.length) return;
          const i = liveIdx[slot]!;
          for (let attempt = 0; ; attempt++) {
            try {
              built[slot] = await buildOne(i);
              break;
            } catch (e) {
              const msg = (e as Error).message ?? "";
              if (attempt < 3 && /429|rate|failed to fetch|fetch failed|network|timeout/i.test(msg)) {
                await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
                continue;
              }
              rowState[i] = `✗ build failed: ${msg.slice(0, 40)}`;
              paint(i);
              break;
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, liveIdx.length) }, worker));
    }
    const builtOk = built.filter((b): b is NonNullable<typeof b> => b !== null);
    if (builtOk.length === 0) {
      return fail("No transaction could be built", "Every build failed — see the rows above.");
    }
    for (const b of builtOk) {
      buildsForRetry.push({ actor: b.actor, ixs: b.ixs });
      signed.push(b.raw);
    }
    const n2 = builtOk.length;
    if (planned) this.plan = [];

    const t0 = Date.now();
    // Concurrency-limited sends, no fixed pacing. The previous 12-per-chunk
    // loop slept 250ms between chunks, so the send phase grew linearly with
    // burst size — 2.4 of a 40-burst's 3.4 measured seconds were OUR sleeps,
    // and "tx/s" was measuring the meter again. Twelve in flight keeps the
    // proxied RPC happy; a 429 retries with backoff instead of pacing
    // everyone else.
    const sigs: string[] = new Array(signed.length);
    {
      let next = 0;
      const sendWorker = async () => {
        for (;;) {
          const k = next++;
          if (k >= signed.length) return;
          let out = "";
          for (let attempt = 0; ; attempt++) {
            try {
              out = await conn.sendRawTransaction(signed[k]!, { skipPreflight: true });
              break;
            } catch (e) {
              const msg = (e as Error).message ?? "";
              if (attempt < 3 && /429|rate|failed to fetch|fetch failed|network|timeout/i.test(msg)) {
                await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
                continue;
              }
              out = `send-failed: ${msg.slice(0, 120)}`;
              break;
            }
          }
          sigs[k] = out;
          const i = builtOk[k]!.i;
          rowState[i] = out.startsWith("send-failed") ? "✗ send failed" : "→ sent";
          paint(i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(12, signed.length) }, sendWorker));
    }
    const sendMs = Date.now() - t0;
    emit(
      line(
        "plain",
        `${sigs.filter((x) => !String(x).startsWith("send-failed")).length}/${n2} sent in ${sendMs}ms.`,
        `burst-${runId}-sent`,
      ),
    );

    // ── Confirmation watch: rows light up as the chain settles them ──
    const summary = (confirmedN: number, failedN: number) =>
      line(
        confirmedN + failedN >= n2 ? "info" : "pending",
        `confirmed ${confirmedN}/${n2}${failedN ? ` · failed on-chain ${failedN}` : ""} · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        `burst-${runId}-progress`,
      );
    emit(summary(0, 0));

    const done = new Set<number>();
    let confirmed = 0;
    let failedOnChain = 0;
    let retriedOnce = false;
    let pollFailures = 0;
    let confirmMs = Date.now() - t0;

    // Fresh blockhash for everything the first wave lost — send failures and
    // never-landed alike. Shared by the poll loop and the statusless-
    // connection fallback, which must retry BEFORE declaring itself done.
    const retryWave = async () => {
      if (retriedOnce) return 0;
      retriedOnce = true;
      let retried = 0;
      for (let k = 0; k < sigs.length; k++) {
        if (done.has(k)) continue;
        const { actor, ixs } = buildsForRetry[k]!;
        try {
          const tx = new Transaction();
          for (const ix of ixs) tx.add(ix);
          tx.feePayer = actor.publicKey;
          tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
          tx.sign(actor);
          sigs[k] = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
          rowState[builtOk[k]!.i] = "↻ resent";
          paint(builtOk[k]!.i);
          retried++;
        } catch {
          // Row keeps its failed state; the summary counts it.
        }
      }
      if (retried > 0) emit(line("dim", `${retried} re-sent with a fresh blockhash.`));
      return retried;
    };
    for (let tick = 0; tick < 60; tick++) {
      await new Promise((r) => setTimeout(r, 400));
      let statuses: Array<{ err: unknown } | null>;
      try {
        const pollList = sigs.map((x) => (String(x).startsWith("send-failed") ? "1".repeat(87) : (x as string)));
        statuses = (await conn.getSignatureStatuses(pollList)).value ?? [];
      } catch {
        pollFailures++;
        if (pollFailures >= 3) {
          // No status read on this connection (synchronous harnesses execute
          // on send): a successful send IS execution there — so retry the
          // losses first, then count every landed send as done.
          for (let k = 0; k < sigs.length; k++) {
            if (String(sigs[k]).startsWith("send-failed") || done.has(k)) continue;
            done.add(k);
            confirmed++;
            rowState[builtOk[k]!.i] = "✓ confirmed";
            paint(builtOk[k]!.i);
          }
          if ((await retryWave()) > 0) {
            for (let k = 0; k < sigs.length; k++) {
              if (String(sigs[k]).startsWith("send-failed") || done.has(k)) continue;
              done.add(k);
              confirmed++;
              rowState[builtOk[k]!.i] = "✓ confirmed";
              paint(builtOk[k]!.i);
            }
          }
          confirmMs = Date.now() - t0;
          break;
        }
        continue;
      }
      for (let k = 0; k < sigs.length; k++) {
        if (done.has(k) || String(sigs[k]).startsWith("send-failed")) continue;
        const st = statuses[k];
        if (!st) continue;
        done.add(k);
        const i = builtOk[k]!.i;
        if (st.err === null) {
          confirmed++;
          rowState[i] = "✓ confirmed";
        } else {
          failedOnChain++;
          rowState[i] = "✗ failed on-chain";
        }
        paint(i);
      }
      confirmMs = Date.now() - t0;
      emit(summary(confirmed, failedOnChain));
      const pending = sigs.filter(
        (x, k) => !done.has(k) && !String(x).startsWith("send-failed"),
      ).length;
      const sendFails = sigs.filter((x) => String(x).startsWith("send-failed")).length;
      if (pending === 0 && sendFails === 0) break;

      // The retry fires as soon as it is clearly needed: everything sent has
      // settled and losses remain, or three seconds have passed with
      // stragglers.
      if (
        !retriedOnce &&
        (pending === 0 || Date.now() - t0 > 3_000) &&
        (pending > 0 || sendFails > 0)
      ) {
        await retryWave();
        continue;
      }
      if (pending === 0) break;
    }

    const secs = confirmMs / 1000;
    emit(summary(confirmed, failedOnChain));
    emit(
      line(
        "success",
        `${confirmed}/${n2} confirmed in ${secs.toFixed(1)}s — ${(confirmed / Math.max(secs, 0.001)).toFixed(1)} tx/s on one market.`,
      ),
    );
    try {
      const snap = await demo.adapter.readSnapshot(ref);
      const m = snap.market;
      emit(line("plain", `YES price now ${yesPrice(m.qYes, m.qNo, m.b).toFixed(4)}`));
    } catch {
      // A throttled price read must not throw away a finished burst.
    }

    // The streamed path replaced rows in place; the buffered path (no stream)
    // must not return every intermediate state of every row.
    const seen = new Set<string>();
    const finalOutput: OutputLine[] = [];
    for (let i = output.length - 1; i >= 0; i--) {
      const l = output[i]!;
      if (l.id) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
      }
      finalOutput.unshift(l);
    }
    return {
      result: { success: confirmed > 0, message: `${confirmed}/${n2}` },
      output: finalOutput,
    };
  }

  /**
   * `history [aN|me] [count]` — recent transactions of one wallet, each with
   * its explorer link.
   *
   * The link is the deliverable: a demo's "that really happened" moment is a
   * signature the viewer can open on a block explorer themselves, and until
   * now the terminal printed synthetic hashes that resolve nowhere.
   */
  async history(...args: unknown[]): Promise<Out> {
    const flat = (Array.isArray(args[0]) ? (args[0] as unknown[]) : args).map(String);
    const demo = this.demo;

    // Target resolution needs no connection, so it happens first — a person
    // with no wallet still deserves "no actor a7" over "no demo context".
    const who = (flat[0] ?? "me").toLowerCase();
    const limit = /^\d+$/.test(flat[1] ?? "") ? Math.min(20, Number(flat[1])) : 8;
    let pk: PublicKey;
    let label: string;
    const actorIdx = who === "me" ? null : parseActorRef(who);
    if (actorIdx !== null) {
      const kp = loadActors()[actorIdx];
      if (!kp) return fail(`No actor ${who} — fleet has ${loadActors().length}.`);
      pk = kp.publicKey;
      label = `${actorLabel(actorIdx)} · ${pk.toBase58()}`;
    } else {
      const me = userBase58FromDemo(demo);
      if (!me) return fail("No connected wallet", "Connect a wallet, or name an actor: `history 03`.");
      pk = new PublicKey(me);
      label = `you · ${me}`;
    }
    if (!demo) return fail("No demo context");

    let sigs: Array<{ signature: string; slot: number; err: unknown; blockTime?: number | null }>;
    try {
      sigs = await demo.adapter.connection.getSignaturesForAddress(pk, { limit });
    } catch (e) {
      return fail(
        (e as Error).message,
        "History needs an RPC that serves getSignaturesForAddress — this connection does not.",
      );
    }
    if (sigs.length === 0) {
      return {
        result: { success: true, message: "" },
        output: [line("plain", `No transactions yet for ${label}.`)],
      };
    }
    const output: OutputLine[] = [line("bold", `History — ${label}`)];
    for (const [i, sig] of sigs.entries()) {
      const when = sig.blockTime
        ? new Date(sig.blockTime * 1000).toISOString().slice(5, 19).replace("T", " ")
        : `slot ${sig.slot}`;
      output.push(
        line(
          sig.err ? "warn" : "plain",
          `  ${String(i + 1).padEnd(3)} ${when}  ${sig.err ? "FAILED" : "ok"}  ${sig.signature.slice(0, 20)}…`,
        ),
        // The full URL on its own line: clickable where the terminal links,
        // selectable everywhere else.
        line("dim", `      https://explorer.solana.com/tx/${sig.signature}?cluster=devnet`),
      );
    }
    return { result: { success: true, message: String(sigs.length) }, output };
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
  async dispute(..._args: unknown[]): Promise<Out> {
    return fail(
      "Not wired",
      "The guardian veto (sooth_core::dispute) exists on-chain but has no client path yet; it is the dispute authority's tool, not a terminal flow.",
    );
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
  async sbhistory(...args: unknown[]): Promise<Out> {
    return this.history(...args);
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
            line("plain", "  history [00..ff|me] [count]  — recent txs with explorer links"),
            line("bold", "Actors — popup-free fleet for simulate"),
            line("plain", "  actors create 10       actors fund 0.05 500   (one confirmation total)"),
            line("plain", "  actors                 actors export <n>      actors clear"),
            line("bold", "AMM"),
            line("plain", "  buyyes <shares>   buyno <shares>   sell <shares> [yes|no]"),
            line("plain", "  createmarket <question…> [b]      graduate — actors pay, no popups"),
            line("plain", "  graduate wallet     — same plan, the connected wallet pays"),
            line("plain", "  simulate [N] [avgSize] [seed]     — seeded order flow, one tx at a time"),
            line("plain", "  burst    [N] [avgSize] [seed]     — all at once, measures tx/s (actors only)"),
            line("plain", "  plan <00..ff> <buy|sell> <yes|no> <size> — script the next burst row by row"),
            line("plain", "  plan                — show the plan     plan clear — back to random"),
            line("bold", "Book (post-graduation)"),
            line("plain", "  book      orders      place <bid|ask> <tick> <usdc>"),
            line("plain", "  cancelorder <seq>     sbredeem"),
            line("bold", "Resolution"),
            line("plain", "  resolution  — lifecycle, attested outcome, veto countdown, next step"),
            line("plain", "  lock   attest <yes|no|invalid>   register [authority]   settle"),
            line("bold", "Settlement"),
            line("plain", "  redeem   claim   claimrefund   dismiss   redeemlp [shares]   lpbalance"),
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
      case "history":
        return this.history(rest);
      case "place":
        return this.sbmint(rest);
      case "cancelorder":
        return this.sbcancel(rest);
      case "sbredeem":
        return this.sbredeem();
      case "resolution":
      case "phase":
        return this.resolutionCmd();
      case "lock":
        return this.lock();
      case "attest":
        return this.attest(rest);
      case "register":
        return this.register(rest);
      case "dispute":
        return this.dispute();
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
      case "burst":
        return this.burst(rest);
      case "plan":
        return this.planCmd(rest);
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
