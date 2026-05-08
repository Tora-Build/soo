// Solana fork of the Geek-page SDK class.
//
// Upstream's Geek terminal mounts a class instance with EVM-shaped methods
// (`balance`, `buyyes`, `buyno`, `mint`, `marketstatus`, `executeCommand`,
// etc.) and feeds user input through `executeCommand`. The Solana fork
// keeps the class shape so Geek.tsx compiles unchanged, but the methods
// route through the @sooth/sdk-solana adapter + chain-shim dispatchers
// instead of wagmi.
//
// Wired today: balance / buyyes / buyno / mint / marketstatus / claim /
// redeem / mint-complete-set / merge-complete-set. The rest still stub
// with a "not implemented in Solana fork" line — the AMM / Portfolio /
// Faucet / Launchpad pages cover the same writes through real UX.

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
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const NOT_WIRED_LINE: OutputLine = {
  type: "warn",
  text: "Solana fork: command not yet wired. Use the AMM / Portfolio / Faucet / Launchpad pages.",
};

function notWired(): { result: CommandResult; output: OutputLine[] } {
  return {
    result: { success: false, message: "Not wired in Solana fork" },
    output: [NOT_WIRED_LINE],
  };
}

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

function fmtUsdc(baseUnits: bigint): string {
  // USDC is 6 decimals.
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
}

function fmtWadShares(wad: bigint, places = 4): string {
  const ONE = 1_000_000_000_000_000_000n;
  const whole = wad / ONE;
  const frac = wad % ONE;
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
  return BigInt(whole) * 1_000_000_000_000_000_000n + BigInt(fracPadded || "0");
}

// ─── SDK class ──────────────────────────────────────────────────────────────

export class SoothSDK {
  private demo: DemoLike | null;
  private connectedAddress: string | null = null;

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

  getMarketInfo(): { marketKey?: string; marketAddress?: string } {
    const ref = this.demo?.marketRef;
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

  // ─── Wired reads ──────────────────────────────────────────────────────────

  async balance(): Promise<{ result: CommandResult; output: OutputLine[] }> {
    const demo = this.demo;
    const userBase58 = userBase58FromDemo(demo);
    if (!demo || !userBase58) {
      return {
        result: { success: false, message: "No connected wallet" },
        output: [
          {
            type: "error",
            text: "No connected wallet — connect via navbar or `lw enable`.",
          },
        ],
      };
    }
    const userPk = new PublicKey(userBase58);
    const conn = demo.adapter.connection;
    const sol = await conn.getBalance(userPk);
    const usdcMint = demo.adapter.usdcMint;
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, userPk);
    let usdcBaseUnits = 0n;
    try {
      const r = await conn.getTokenAccountBalance(usdcAta);
      usdcBaseUnits = BigInt(r.value.amount);
    } catch {
      // ATA may not exist yet — show 0.
    }
    const output: OutputLine[] = [
      { type: "plain", text: `Wallet:  ${userBase58}` },
      { type: "plain", text: `SOL:     ${(sol / 1e9).toFixed(4)}` },
      { type: "plain", text: `USDC:    ${fmtUsdc(usdcBaseUnits)}` },
    ];
    if (demo.marketRef) {
      try {
        const pos = await demo.adapter.readPosition(
          demo.marketRef,
          demo.userRef!,
        );
        output.push(
          {
            type: "plain",
            text: `YES:     ${fmtWadShares(pos.yesShares)} (market ${demo.marketRef.replace(/^sol:/, "").slice(0, 8)}…)`,
          },
          { type: "plain", text: `NO:      ${fmtWadShares(pos.noShares)}` },
        );
      } catch {
        // Position PDA may not exist yet for this user/market.
      }
    }
    return { result: { success: true, message: "" }, output };
  }

  async marketstatus(): Promise<{
    result: CommandResult;
    output: OutputLine[];
  }> {
    const demo = this.demo;
    if (!demo?.marketRef) {
      return {
        result: { success: false, message: "No active market" },
        output: [
          {
            type: "error",
            text: "No active market — set VITE_DEMO_MARKET_REF or run dev:localnet.",
          },
        ],
      };
    }
    try {
      const snap = await demo.adapter.readSnapshot(demo.marketRef);
      const m = snap.market;
      const lifecycle = m.isSettled
        ? `Settled (winning=${m.outcome ?? "?"})`
        : m.isLive
          ? "Live"
          : "Initializing";
      const lines: OutputLine[] = [
        line("plain", `Market:    ${demo.marketRef.replace(/^sol:/, "")}`),
        line("plain", `Lifecycle: ${lifecycle}`),
        line("plain", `qYes:      ${fmtWadShares(m.qYes)}`),
        line("plain", `qNo:       ${fmtWadShares(m.qNo)}`),
        line("plain", `b:         ${fmtWadShares(m.b)}`),
        line("plain", `Graduated: ${m.isGraduated}`),
      ];
      if (m.deadline !== undefined && m.deadline > 0n) {
        const d = new Date(Number(m.deadline) * 1000);
        lines.push(line("plain", `Deadline:  ${d.toISOString()}`));
      }
      return { result: { success: true, message: "" }, output: lines };
    } catch (e) {
      return {
        result: { success: false, message: (e as Error).message },
        output: [line("error", `marketstatus failed: ${(e as Error).message}`)],
      };
    }
  }

  // ─── Wired writes (route through chain-shim dispatchers) ─────────────────

  private async writeViaShim(
    functionName: string,
    args: unknown[],
  ): Promise<{ result: CommandResult; output: OutputLine[] }> {
    const demo = this.demo;
    if (!demo) {
      return {
        result: { success: false, message: "No demo context" },
        output: [
          {
            type: "error",
            text: "SDK not initialized — open the page from inside the app.",
          },
        ],
      };
    }
    try {
      const out = await dispatchAmmWrite(
        { functionName, args },
        {
          adapter: demo.adapter,
          connection: demo.adapter.connection as never,
          userBase58: userBase58FromDemo(demo) ?? undefined,
          signer: demo.signer,
        },
      );
      if (out === NOT_HANDLED) {
        return notWired();
      }
      const sig = String(out).replace(/^0x/, "").slice(0, 16);
      return {
        result: { success: true, message: sig },
        output: [
          { type: "success", text: `${functionName} OK` },
          { type: "dim", text: `tx (synth hash): 0x${sig}…` },
        ],
      };
    } catch (e) {
      return {
        result: { success: false, message: (e as Error).message },
        output: [
          {
            type: "error",
            text: `${functionName} failed: ${(e as Error).message}`,
          },
        ],
      };
    }
  }

  async mint(
    ...args: unknown[]
  ): Promise<{ result: CommandResult; output: OutputLine[] }> {
    // Faucet mint. Geek upstream calls `mint <amount>` (USDC, decimal).
    const arg0 = Array.isArray(args[0]) ? args[0][0] : args[0];
    const amount = toUsdcBaseUnits(typeof arg0 === "string" ? arg0 : "100");
    if (amount === null) {
      return {
        result: { success: false, message: "Bad amount" },
        output: [line("error", "Usage: mint <amount-usdc>  e.g. `mint 100`")],
      };
    }
    return this.writeViaShim("mint", [this.connectedAddress, amount]);
  }

  async buyyes(
    ...args: unknown[]
  ): Promise<{ result: CommandResult; output: OutputLine[] }> {
    return this.tradeBuy(1, args);
  }

  async buyno(
    ...args: unknown[]
  ): Promise<{ result: CommandResult; output: OutputLine[] }> {
    return this.tradeBuy(0, args);
  }

  private async tradeBuy(
    outcome: 0 | 1,
    args: unknown[],
  ): Promise<{ result: CommandResult; output: OutputLine[] }> {
    const arg0 = Array.isArray(args[0]) ? args[0][0] : args[0];
    const arg1 = Array.isArray(args[0]) ? args[0][1] : args[1];
    const sharesWad = toWadShares(typeof arg0 === "string" ? arg0 : undefined);
    if (sharesWad === null) {
      const cmd = outcome === 1 ? "buyyes" : "buyno";
      return {
        result: { success: false, message: "Bad amount" },
        output: [
          line(
            "error",
            `Usage: ${cmd} <shares> [maxCostWad]  e.g. \`${cmd} 5\``,
          ),
        ],
      };
    }
    const maxCostWad =
      toWadShares(typeof arg1 === "string" ? arg1 : undefined) ??
      sharesWad * 2n; // sane default ceiling — 2x face value
    const market = this.demo?.marketRef;
    if (!market) {
      return {
        result: { success: false, message: "No active market" },
        output: [line("error", "No active market.")],
      };
    }
    return this.writeViaShim("tradePositions", [
      market,
      outcome,
      sharesWad,
      maxCostWad,
    ]);
  }

  // ─── Stubs (still EVM-shaped or behind a deferred feature) ───────────────

  async setMarket(_keyOrIndex: string) {
    return notWired();
  }
  async sbSetMarket(_keyOrIndex: string) {
    return notWired();
  }
  async approve(..._args: unknown[]) {
    return notWired();
  }
  async allowance() {
    return notWired();
  }
  async createmarket(..._args: unknown[]) {
    return notWired();
  }
  async graduate(..._args: unknown[]) {
    return notWired();
  }
  async simulate(..._args: unknown[]) {
    return notWired();
  }
  async trialstatus(..._args: unknown[]) {
    return notWired();
  }
  async dismiss(..._args: unknown[]) {
    return notWired();
  }
  async claimrefund(..._args: unknown[]) {
    return notWired();
  }
  async lpbalance(..._args: unknown[]) {
    return notWired();
  }
  async redeemlp(..._args: unknown[]) {
    return notWired();
  }
  async transferlp(..._args: unknown[]) {
    return notWired();
  }
  async pausestatus(..._args: unknown[]) {
    return notWired();
  }
  async sbmint(..._args: unknown[]) {
    return notWired();
  }
  async sbmerge(..._args: unknown[]) {
    return notWired();
  }
  async sbcancel(..._args: unknown[]) {
    return notWired();
  }
  async sbredeem(..._args: unknown[]) {
    return notWired();
  }
  async sbbook(..._args: unknown[]) {
    return notWired();
  }
  async sbbalance(..._args: unknown[]) {
    return notWired();
  }
  async sbstate(..._args: unknown[]) {
    return notWired();
  }
  async sbprice(..._args: unknown[]) {
    return notWired();
  }
  async sbhistory(..._args: unknown[]) {
    return notWired();
  }

  // ─── Command parser ──────────────────────────────────────────────────────

  async executeCommand(
    input: string,
  ): Promise<{ result: CommandResult; output: OutputLine[] }> {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase() ?? "";
    const rest = parts.slice(1);
    switch (cmd) {
      case "":
        return { result: { success: true, message: "" }, output: [] };
      case "help":
        return {
          result: { success: true, message: "" },
          output: [
            { type: "bold", text: "Solana fork — wired commands:" },
            {
              type: "plain",
              text: "  balance              — SOL + USDC + active-market position",
            },
            {
              type: "plain",
              text: "  marketstatus         — Market PDA snapshot",
            },
            {
              type: "plain",
              text: "  buyyes <shares>      — buy YES (5 = 5·WAD)",
            },
            { type: "plain", text: "  buyno  <shares>      — buy NO" },
            {
              type: "plain",
              text: "  mint   <usdc>        — faucet (localnet only)",
            },
            {
              type: "plain",
              text: "  whoami               — connected pubkey",
            },
            {
              type: "plain",
              text: "  market               — active market PDA",
            },
            { type: "plain", text: "" },
            {
              type: "dim",
              text: "Other upstream commands stub with 'not wired' — use the AMM / Portfolio / Faucet / Launchpad pages.",
            },
          ],
        };
      case "whoami": {
        const u = userBase58FromDemo(this.demo);
        return {
          result: { success: !!u, message: u ?? "" },
          output: [
            u
              ? { type: "plain", text: u }
              : { type: "error", text: "No connected wallet." },
          ],
        };
      }
      case "market": {
        const m = this.demo?.marketRef;
        return {
          result: { success: !!m, message: m ?? "" },
          output: [
            m
              ? { type: "plain", text: m.replace(/^sol:/, "") }
              : { type: "error", text: "No active market." },
          ],
        };
      }
      case "balance":
        return this.balance();
      case "marketstatus":
      case "status":
        return this.marketstatus();
      case "buyyes":
        return this.buyyes(rest);
      case "buyno":
        return this.buyno(rest);
      case "mint":
      case "faucet":
        return this.mint(rest);
      default:
        return {
          result: { success: false, message: `Unknown command: ${cmd}` },
          output: [
            { type: "error", text: `Unknown command: ${cmd}` },
            { type: "dim", text: 'Type "help" for the wired-command list.' },
          ],
        };
    }
  }
}
