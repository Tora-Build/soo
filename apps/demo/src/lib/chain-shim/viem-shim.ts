// chain-shim/viem-shim.ts — minimal stand-in for the `viem` surface upstream
// `apps/demo` consumes. Only the symbols the upstream React tree imports are
// reproduced; the rest of viem's surface is intentionally absent.
//
// Goal: keep upstream component code unchanged. EVM-flavored types collapse to
// `string` because Solana has no `0x`-prefixed addresses and the components
// only read these as opaque identifiers (toast messages, key props).
//
// Numeric helpers (formatUnits, parseUnits, keccak256, encodePacked, etc.)
// have viable Solana equivalents and are implemented here directly so we
// don't take a runtime dep on viem itself.

import { PublicKey } from "@solana/web3.js";

// ─── Types upstream code references at compile time ─────────────────────────

// Match viem's template literal types so upstream code that narrows to
// `0x${string}` still compiles. Solana base58 addresses don't naturally
// fit this shape; the chain-shim creates synthetic `0x...` placeholders
// whenever a Solana ref needs to flow through an EVM-typed slot.
export type Address = `0x${string}`;
export type Hash = `0x${string}`;
export type Hex = `0x${string}`;
export type Abi = readonly unknown[];
export type AbiFunction = unknown;
export type AbiParameter = unknown;

// Any-shaped chain object — upstream's `defineChain` calls return one of
// these. Components only read `.id` / `.name`. We pass through verbatim.
export interface Chain {
  id: number;
  name: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  rpcUrls?: { default: { http: readonly string[] } };
  blockExplorers?: { default: { name: string; url: string } };
  contracts?: Record<string, unknown>;
  testnet?: boolean;
}

// Stand-in transaction receipt shape — upstream consumers only ever read
// `transactionHash` and treat the rest as opaque.
export interface TransactionReceipt {
  transactionHash: Hash;
  blockHash?: Hash;
  blockNumber?: bigint;
  status?: "success" | "reverted";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logs: any[];
  // Solana-only: surface the raw signature so debug paths still see it.
  signature?: string;
}

// `PublicClient` and `WalletClient` are reduced to opaque markers — the demo
// fork does not perform direct EVM RPC calls; the chain-shim's
// `usePublicClient` returns null and components handle the fall-through.
export type PublicClient = unknown;
export type WalletClient = unknown;
export type EIP1193Provider = unknown;

// ─── Helpers used in upstream code ──────────────────────────────────────────

const TEN = 10n;

export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const factor = TEN ** BigInt(decimals);
  const whole = v / factor;
  const frac = v % factor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${out}` : out;
}

export function parseUnits(value: string, decimals: number): bigint {
  const [wholeRaw = "0", fracRaw = ""] = value.split(".");
  const negative = wholeRaw.startsWith("-");
  const whole = (negative ? wholeRaw.slice(1) : wholeRaw) || "0";
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  const result = BigInt(whole + frac);
  return negative ? -result : result;
}

export const maxUint256 = (1n << 256n) - 1n;
export const zeroHash: Hash =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
export const zeroAddress: Address =
  "0x0000000000000000000000000000000000000000";

export function encodeFunctionData(_args: unknown): Hex {
  return "0x";
}
export function decodeFunctionData(_args: unknown): {
  args: readonly unknown[];
  functionName: string;
} {
  return { args: [], functionName: "" };
}

// `getAddress` upstream returns a checksummed address. Our shim just
// coerces to the template-literal type without a checksum step.
export function getAddress(addr: string): Address {
  return addr as Address;
}

// ABI helpers — collapsed to no-op pass-throughs. Components only ever pass
// the result back to `useReadContract`/`useReadContracts` which the wagmi
// shim ignores.
export function parseAbi(_strings: readonly string[]): Abi {
  return [];
}
export function parseAbiItem(s: string): AbiFunction {
  // Real viem parses the human-readable signature (e.g. "event Foo(uint256
  // bar)") into a structured ABI item. The chain-shim only consumes the
  // event name (via `args.event.name` in the shim's `getLogs`) — extract
  // it with a tolerant regex so OrderPlaced / OrderCancelled / OrderFilled
  // can be distinguished. Other fields are unused by the Solana fork.
  const match = s.match(
    /^\s*(?:event|function|error)\s+([A-Za-z_][A-Za-z0-9_]*)/i,
  );
  const name = match?.[1];
  return (name ? { type: "event", name } : {}) as AbiFunction;
}
export function parseAbiParameters(_s: string): readonly AbiParameter[] {
  return [];
}
export function encodeAbiParameters(
  _params: readonly AbiParameter[],
  _values: readonly unknown[],
): Hex {
  return "0x";
}

// `keccak256` and `encodePacked` derive `marketKey` from a market address.
// Upstream (EVM) hashes because a 20-byte address needs widening to bytes32.
// A Solana market address is ALREADY 32 bytes, so no hash is needed — the
// pubkey's own bytes are the identifier. That is a bijection: zero collisions,
// and invertible, which lets the data service resolve any market without a
// metadata table.
//
// This MUST stay byte-identical to packages/sooth-data/src/market-key.ts
// (deriveMarketKey). If the two disagree, every fills lookup 404s.
//
// The previous implementation folded FNV-1a over `bytesFromHex("0x" + base58)`,
// which parsed a BASE58 string as hex: only 21 of 58 base58 characters are
// hex-valid and the rest became `parseInt(...) || 0` = zero, destroying ~64%
// of the input before hashing. It then emitted 0x${a}${b}${a}${b}, mirroring
// the first 128 bits into the last. It only survived because the market set
// was two hand-seeded entries; a collision would have served one market's
// fills under another's key.
function hexFromBytes(bytes: Uint8Array): Hex {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `0x${out}` as Hex;
}

/**
 * Deterministic 32-byte id for inputs that are NOT market pubkeys.
 *
 * Upstream also packs synthetic placeholder addresses (deployments.json uses
 * `0x…0a01` etc. to satisfy `!!engineAddress` gates), and those must not blow
 * up — they only ever become React keys, toast ids and localStorage keys. Four
 * FNV-1a passes with distinct offset bases fill the 32 bytes without the
 * half-mirroring the previous implementation had, and the digest is taken over
 * the raw UTF-8 bytes rather than a hex misparse of them.
 *
 * Non-cryptographic and deliberately so; nothing security-relevant reaches it.
 */
function foldToBytes32(text: string): Hex {
  const bytes = new TextEncoder().encode(text);
  const MASK = (1n << 64n) - 1n;
  const PRIME = 0x100000001b3n;
  const BASES = [
    0xcbf29ce484222325n,
    0x9dcf9f0a1b2c3d4fn,
    0x27220a95a8b1c3d7n,
    0x1f5e3d2c4b6a7089n,
  ];
  let out = "";
  for (const base of BASES) {
    let h = base;
    for (const b of bytes) {
      h = (h ^ BigInt(b)) & MASK;
      h = (h * PRIME) & MASK;
    }
    out += h.toString(16).padStart(16, "0");
  }
  return `0x${out}` as Hex;
}

export function keccak256(input: Hex | Uint8Array): Hex {
  if (input instanceof Uint8Array) {
    // A 32-byte buffer is already an identifier.
    if (input.length === 32) return hexFromBytes(input);
    return foldToBytes32(hexFromBytes(input));
  }

  // `encodePacked` hands us "0x" + <base58 pubkey> for real markets. Decode it
  // back to the 32 bytes it always was — that is the identity path, and the
  // one that MUST agree with packages/sooth-data/src/market-key.ts.
  const text = input.startsWith("0x") ? input.slice(2) : input;
  try {
    const bytes = new PublicKey(text).toBytes();
    if (bytes.length === 32) return hexFromBytes(bytes);
  } catch {
    // Not a pubkey — a synthetic placeholder address, an empty "0x", or an
    // upstream bytes32 key. Must not throw: these flow through the same
    // hook paths as real markets.
  }
  return foldToBytes32(text);
}

export function encodePacked(
  _types: readonly string[],
  values: readonly unknown[],
): Hex {
  // Concatenate values' string forms — collision-free for our usage where
  // upstream packs single addresses or single bytes32 keys.
  const out = values
    .map((v) => {
      if (typeof v === "string") {
        return v.startsWith("0x") ? v.slice(2) : v;
      }
      if (typeof v === "bigint") return v.toString(16);
      return String(v);
    })
    .join("");
  return ("0x" + out) as Hex;
}

// `decodeEventLog` is used in a few places to parse SoothBook events. The
// Solana fork has no event-log shape; return an empty stand-in.
export function decodeEventLog(_args: unknown): {
  eventName: string;
  args: Record<string, unknown>;
} {
  return { eventName: "", args: {} };
}

// `defineChain` — upstream uses this to wrap viem chain objects. Our shim
// just returns the input as-is.
export function defineChain<T extends Chain>(c: T): T {
  return c;
}

// HTTP and fallback transports are passed to the wagmi adapter; upstream
// relies on them at config-build time. Our shim never builds wagmi config,
// but the symbols still need to exist for static imports.
export function http(_url?: string, _opts?: unknown): unknown {
  return { type: "http" };
}
export function fallback(_transports: unknown[]): unknown {
  return { type: "fallback" };
}
export function custom(_provider: unknown): unknown {
  return { type: "custom" };
}
export function createWalletClient(_opts: unknown): WalletClient {
  return {};
}

export function privateKeyToAccount(_pk: string): {
  address: Address;
  publicKey: Hex;
  type: "local";
  signMessage: () => Promise<Hex>;
  signTransaction: () => Promise<Hex>;
  signTypedData: () => Promise<Hex>;
} {
  // The Solana fork has no EVM-private-key concept. Return a deterministic
  // placeholder so upstream local-wallet call sites still type
  // and renders, but no signing actually happens.
  return {
    address: "0x0000000000000000000000000000000000000000",
    publicKey: "0x",
    type: "local",
    signMessage: async () => "0x",
    signTransaction: async () => "0x",
    signTypedData: async () => "0x",
  };
}

export function generatePrivateKey(): Hex {
  // Random-looking but inert — feature is disabled in the Solana fork.
  return ("0x" + "00".repeat(32)) as Hex;
}
