// chain-shim/wagmi-shim.ts — stand-in implementations of the `wagmi` hook
// surface upstream consumes. Each hook accepts the same input shape upstream
// uses and returns the same output shape, but the chain-integration body is
// either:
//
//   1. Routed through `@solana/wallet-adapter-react` (account / chain ID),
//   2. Returns a stable "not available in Solana fork" sentinel (every
//      `useReadContract` / `useReadContracts` / `useWatchContractEvent`),
//   3. Throws at write time (`useWriteContract.writeContract*`) — the
//      upstream form/error UX surfaces the failure verbatim.
//
// Type permissiveness: input args are typed as wide `Record<string, unknown>`
// or `any` so upstream call sites compile without modification. The Solana
// fork doesn't actually decode any of these — they're inputs to a sentinel.

import {
  useEffect,
  useContext,
  useMemo,
  useState,
  type ContextType,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Address, Chain, Hash, TransactionReceipt } from "./viem-shim";

/** Every market the demo should list: the seeded one plus any extras.
 *
 *  There is no on-chain registry — `getMarkets` is served from this list — so
 *  without the extras a market created outside the seed script is invisible in
 *  the UI even though it exists on chain. */
function knownMarketRefs(demo: {
  marketRef: string | null;
  // Required, not optional: a `?:` here lets the field go missing from
  // DemoCtx while this silently returns only the seeded market.
  extraMarketRefs: string[];
}): string[] {
  const refs = new Set<string>();
  if (demo.marketRef) refs.add(demo.marketRef);
  for (const r of demo.extraMarketRefs) refs.add(r);
  return [...refs];
}
import {
  dispatchAmmRead,
  dispatchAmmWrite,
  NOT_HANDLED,
  type AmmBridgeCtx,
  type ReadCallShape,
} from "./amm-bridge";
import { fetchUserOpenOrders, synthOrderPlacedLogs } from "./orderbook-reads";
import {
  dispatchPortfolioRead,
  PORTFOLIO_NOT_HANDLED,
  type PortfolioBridgeCtx,
} from "./portfolio-bridge";
import {
  dispatchMarketsRead,
  MARKETS_NOT_HANDLED,
  type MarketsBridgeCtx,
} from "./markets-bridge";
import { DemoContextObj } from "../DemoContext";
import { DEFAULT_CHAIN_ID } from "../chains";

// ─── Read dispatch order ────────────────────────────────────────────────────
//
// Bridge precedence (most-specific first):
//
//   1. portfolio-bridge — claims `getMarkets`, market-PDA-derived reads
//      (`isSettled`, `winningOutcome`, `price`, `questionHash`, …) plus the
//      remaining graceful-zero LP/locked-funds set.
//   2. markets-bridge — claims `getGraduationProgress` + `totalSupply`,
//      synthesized from `AmmState.{q_yes,q_no,b}`. Runs *before* the
//      amm-bridge so its `getGraduationProgress` synthesis wins, and
//      *after* portfolio-bridge so the latter's market-PDA-typed reads
//      keep their existing semantics.
//   3. amm-bridge — claims AMM-shaped reads (`getMarketState`, `getPosition`,
//      `getPositionQuote`, `getLiquidity`, `markets`, `balanceOf`,
//      `allowance`, `decimals`, …).
//   4. Sentinel fallback — `undefined` (publicClient) or `data: undefined`
//      (hook-shape).
//
// Function-name uniqueness: when multiple bridges define a name, the
// earlier one wins. Today's collision: `totalSupply` is claimed by
// markets-bridge, which is what surfaces a non-zero LP anchor.
async function dispatchRead(
  call: ReadCallShape,
  amm: AmmBridgeCtx,
  portfolio: PortfolioBridgeCtx,
  markets: MarketsBridgeCtx,
): Promise<unknown | typeof NOT_HANDLED> {
  const portfolioOut = await dispatchPortfolioRead(call, portfolio);
  if (portfolioOut !== PORTFOLIO_NOT_HANDLED) return portfolioOut;
  const marketsOut = await dispatchMarketsRead(call, markets);
  if (marketsOut !== MARKETS_NOT_HANDLED) return marketsOut;
  return dispatchAmmRead(call, amm);
}

// ─── Account / chain hooks (real, backed by wallet-adapter) ─────────────────

export interface UseAccountReturn {
  address: Address | undefined;
  addresses: readonly Address[] | undefined;
  chain: Chain | undefined;
  chainId: number | undefined;
  connector: unknown;
  isConnecting: boolean;
  isReconnecting: boolean;
  isConnected: boolean;
  isDisconnected: boolean;
  status: "connected" | "reconnecting" | "connecting" | "disconnected";
}

export function useAccount(): UseAccountReturn {
  const wallet = useWallet();
  const demo = useContext(DemoContextObj);
  // In test-injection mode the DemoProvider receives a userRef directly;
  // wallet-adapter never connects a wallet. Surface the injected user as
  // the active account so upstream's `if (!isConnected)` gates flip on.
  const injected = demo?.isOverride ? demo.userRef : null;
  const base58 = injected
    ? injected.replace(/^sol:/, "")
    : wallet.publicKey?.toBase58();
  // Coerce the Solana base58 pubkey into the EVM-shaped `0x${string}` literal
  // so upstream code that pipes the address through wagmi-typed slots
  // continues to type-check. The Solana fork never reads the value as an
  // EVM address — toasts and key props treat it as an opaque string.
  const address = base58 ? (`0x${base58}` as Address) : undefined;
  const isConnected = !!address;
  return {
    address,
    addresses: address ? [address] : undefined,
    chain: undefined,
    chainId: isConnected ? 1 : undefined,
    connector: undefined,
    isConnecting: !!wallet.connecting,
    isReconnecting: false,
    isConnected,
    isDisconnected: !isConnected,
    status: isConnected
      ? "connected"
      : wallet.connecting
        ? "connecting"
        : "disconnected",
  };
}

export function useChainId(): number {
  // The chain-shim doesn't expose multi-chain switching on the Solana fork
  // (Phantom's Custom RPC is user-side), so the wallet "chain" matches
  // whatever cluster the dapp is configured for. Single-sourced from
  // chains.ts (902 localnet / 901 devnet / 900 mainnet).
  return DEFAULT_CHAIN_ID;
}

export function useDisconnect() {
  const wallet = useWallet();
  return {
    disconnect: () => {
      void wallet.disconnect?.();
    },
    disconnectAsync: async () => {
      await wallet.disconnect?.();
    },
    isPending: false,
    error: null,
  };
}

export function useConnect() {
  return {
    connect: () => {},
    connectAsync: async () => undefined,
    connectors: [] as unknown[],
    isPending: false,
    error: null,
  };
}

export function useSwitchChain() {
  return {
    switchChain: (_args?: { chainId?: number }) => {},
    switchChainAsync: async (_args?: { chainId?: number }) => undefined,
    chains: [] as Chain[],
    isPending: false,
    error: null,
  };
}

// ─── Public client (Solana Connection wrapped in EVM-shaped methods) ───────
//
// Upstream code often calls `publicClient.readContract(...)`,
// `publicClient.waitForTransactionReceipt(...)`, `publicClient.getLogs(...)`,
// `publicClient.multicall(...)`, etc. The Solana fork has no equivalent of
// any of these by ABI dispatch; the methods exist on the shim's public
// client purely to satisfy upstream's call sites and return sentinel
// values that upstream's catch blocks handle.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ShimPublicClient {
  readonly solanaConnection: unknown;
  chain?: { id: number; name: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract: (args?: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContracts: (args?: any) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  multicall: (args?: any) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  simulateContract: (args?: any) => Promise<{ result: any }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitForTransactionReceipt: (args?: any) => Promise<TransactionReceipt>;
  getBlockNumber: () => Promise<bigint>;
  // Generic to satisfy upstream's `typeof publicClient.getLogs<typeof X>`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLogs: <_E = unknown>(args?: any) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getBalance: (args?: any) => Promise<bigint>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  estimateContractGas: (args?: any) => Promise<bigint>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: (args?: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

function makeShimPublicClient(
  connection: unknown,
  bridge: AmmBridgeCtx | null,
  portfolio: PortfolioBridgeCtx | null,
  markets: MarketsBridgeCtx | null,
): ShimPublicClient {
  // Methods are loosely typed because upstream destructures result fields
  // freely (event-log shape, multicall tuple shape, etc.). Most return
  // sentinels; `readContract` dispatches AMM-shaped reads through the
  // bridge and falls through to `undefined` for unhandled function names.
  //
  // `getLogs`: synthesize EVM-shaped `OrderPlaced` logs from on-chain
  // sooth_book Order PDAs so `useBookOrders.fetchOpenOrdersFromBook`
  // populates the My-Orders panel. Only the buy-path (forOutcome=true)
  // shape is emitted — see orderbook-reads.ts for the full mapping. All
  // other event topics fall through to `[]` (empty), preserving the
  // pre-orderbook behaviour for AMM logs / activity / etc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getLogs = async <_E = unknown>(args?: any): Promise<any[]> => {
    if (!bridge || !bridge.marketRef || !bridge.userBase58) return [];
    const eventName: string | undefined =
      args?.event?.name ?? args?.eventName ?? undefined;
    // OrderPlaced is the only event upstream's open-orders RPC fallback
    // path (`useBookOrders.fetchOpenOrdersFromBook`) inspects to
    // reconstruct level-aggregated rows. Cancelled / Filled aggregates
    // would also be synthesized here once the SELL / fill paths are
    // wired — until then we deliberately emit `[]` for them so the
    // upstream subtraction `placed - cancelled - filled = stake_unmatched`
    // yields the right remaining amount.
    if (eventName !== "OrderPlaced") return [];
    try {
      const orders = await fetchUserOpenOrders(
        bridge.connection,
        bridge.adapter,
        bridge.marketRef,
        bridge.userBase58,
      );
      const marketKey =
        typeof args?.args?.marketKey === "string"
          ? (args.args.marketKey as string)
          : undefined;
      const ownerLower =
        typeof args?.args?.maker === "string"
          ? (args.args.maker as string).toLowerCase()
          : `0x${bridge.userBase58}`.toLowerCase();
      return synthOrderPlacedLogs(orders, marketKey, ownerLower);
    } catch {
      return [];
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readContract = async (args?: any): Promise<any> => {
    if (!bridge || !portfolio || !markets || !args) return undefined;
    const out = await dispatchRead(args, bridge, portfolio, markets);
    return out === NOT_HANDLED ? undefined : out;
  };
  // Multicall fan-out: walk each `{address, functionName, args}` tuple and
  // route each through the same dispatch chain, then aggregate into the
  // wagmi multicall shape `{status, result}`. Failures inside a leg
  // surface as `{status: "failure", error}` so upstream multicall consumers
  // (useReadContracts.data[i].result) keep their per-leg fallbacks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const multicallFanout = async (mcArgs?: any): Promise<any[]> => {
    if (!bridge || !portfolio || !markets || !mcArgs) return [];
    const contracts = (mcArgs.contracts ?? []) as ReadCallShape[];
    return Promise.all(
      contracts.map(async (call) => {
        try {
          const out = await dispatchRead(call, bridge, portfolio, markets);
          if (out === NOT_HANDLED) {
            return { status: "success", result: undefined };
          }
          return { status: "success", result: out };
        } catch (err) {
          return { status: "failure", error: err as Error };
        }
      }),
    );
  };
  return {
    solanaConnection: connection,
    chain: { id: 1, name: "solana" },
    readContract,
    readContracts: multicallFanout,
    multicall: multicallFanout,
    // simulateContract: upstream's SimpleTradingPanel calls this to surface
    // pre-flight reverts. For AMM trades the real adapter's `submit` does
    // its own preflight; returning a successful empty result here lets
    // upstream's catch path stay quiet while the bridged write still
    // surfaces real errors via the toast pipeline.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    simulateContract: async (_args?: any) => ({ result: undefined }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    waitForTransactionReceipt: async (
      _args?: unknown,
    ): Promise<TransactionReceipt> => ({
      transactionHash: "0x0" as Hash,
      // status is load-bearing: useOrderbookTrade.executeWrite throws
      // "Transaction reverted on-chain" when receipt.status !== "success"
      // (useOrderbookTrade.ts:422). Without it the post-submit toast
      // always shows error even when the on-chain tx landed cleanly.
      status: "success",
      logs: [],
    }),
    getBlockNumber: async () => 0n,
    getLogs,
    getBalance: async () => 0n,
    estimateContractGas: async () => 0n,
    request: async () => undefined,
  };
}

export function usePublicClient(_args?: unknown): ShimPublicClient {
  const { connection } = useConnection();
  const demo = useContext(DemoContextObj);
  // Use the adapter's connection (LiteSvmConnection in tests). In production
  // both routes converge on the same Connection instance via
  // ProductionDemoProvider — but the test override path replaces it with a
  // LiteSVM-backed shim, and balance reads need to flow through *that*
  // connection (not the wallet-adapter ConnectionProvider's).
  const effectiveConnection = demo?.adapter?.connection ?? connection;
  // Memoize on the actual identity inputs. Without this the function
  // returns a NEW ShimPublicClient on every render, which thrashes any
  // useEffect/useCallback in upstream hooks that take publicClient as
  // a dep (notably useOrderbook.fetchOrderbook → setIsLoading(true)
  // re-fires every render → panelLoading never resolves to false).
  return useMemo(() => {
    const bridge: AmmBridgeCtx | null = demo
      ? {
          adapter: demo.adapter,
          connection: effectiveConnection as never,
          userBase58: demo.userRef
            ? demo.userRef.replace(/^sol:/, "")
            : undefined,
          signer: demo.signer,
          marketRef: demo.marketRef,
        }
      : null;
    const portfolio: PortfolioBridgeCtx | null = demo
      ? {
          adapter: demo.adapter,
          knownMarkets: knownMarketRefs(demo),
        }
      : null;
    const markets: MarketsBridgeCtx | null = demo
      ? {
          adapter: demo.adapter,
          knownMarkets: knownMarketRefs(demo),
        }
      : null;
    return makeShimPublicClient(
      effectiveConnection,
      bridge,
      portfolio,
      markets,
    );
  }, [
    effectiveConnection,
    demo?.adapter,
    demo?.userRef,
    demo?.marketRef,
    demo?.signer,
  ]);
}

export function useWalletClient(_args?: unknown) {
  // No EVM wallet client — return undefined data so upstream form code
  // gates on `if (!walletClient)`.
  return {
    data: undefined,
    error: null,
    isLoading: false,
    isError: false,
    isSuccess: false,
  };
}

export function useBalance(_args?: unknown) {
  return {
    data: undefined as
      | { value: bigint; decimals: number; symbol: string; formatted: string }
      | undefined,
    error: null,
    isLoading: false,
    isError: false,
    isSuccess: false,
    refetch: STABLE_REFETCH,
  };
}

export function useBlockNumber(_opts?: {
  watch?: boolean;
  cacheTime?: number;
  query?: { enabled?: boolean };
}) {
  return {
    data: undefined as bigint | undefined,
    error: null,
    isLoading: false,
  };
}

export interface ShimWagmiConfig {
  chains: readonly Chain[];
  connectors: readonly unknown[];
}

export function useConfig(): ShimWagmiConfig {
  // Upstream code accesses `useConfig().chains.find(...)` on a wagmi config.
  // We return an inert config-like object — chains is empty and `find()`
  // returns undefined, so callers that branch on the chain not being
  // present already cover this path.
  return {
    chains: [] as readonly Chain[],
    connectors: [] as readonly unknown[],
  };
}

// ─── Bridge context construction (shared by read + write hooks) ─────────────
//
// useReadContract, useReadContracts, and useWriteContract all build the same
// shape from `(demo, connection)` to feed the dispatchers. Single-source it
// here so the connection-fallback rule and the userBase58 strip stay in one
// place.

type DemoCtx = NonNullable<ContextType<typeof DemoContextObj>>;

function buildBridgeCtxs(
  demo: DemoCtx,
  connection: ReturnType<typeof useConnection>["connection"],
): {
  bridge: AmmBridgeCtx;
  portfolio: PortfolioBridgeCtx;
  markets: MarketsBridgeCtx;
} {
  const effectiveConnection = demo.adapter?.connection ?? connection;
  const knownMarkets = demo.marketRef ? [demo.marketRef] : [];
  return {
    bridge: {
      adapter: demo.adapter,
      connection: effectiveConnection as never,
      userBase58: demo.userRef ? demo.userRef.replace(/^sol:/, "") : undefined,
      signer: demo.signer,
      marketRef: demo.marketRef,
    },
    portfolio: { adapter: demo.adapter, knownMarkets },
    markets: { adapter: demo.adapter, knownMarkets },
  };
}

// ─── Read hooks (sentinel — Solana fork has no EVM ABI dispatcher) ──────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ReadContractResult<T = any> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  isPending: boolean;
  isFetching: boolean;
  status: "pending" | "error" | "success";
  refetch: () => Promise<{ data: T | undefined; error: Error | null }>;
}

const STABLE_REFETCH = async () => ({ data: undefined, error: null });

const stableEmptyRead = Object.freeze({
  data: undefined,
  error: null,
  isLoading: false,
  isError: false,
  isSuccess: false,
  isPending: false,
  isFetching: false,
  status: "success" as const,
  refetch: STABLE_REFETCH,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useReadContract<T = any>(
  args?: unknown,
): ReadContractResult<T> {
  // Hook-shape consumer (vs. publicClient.readContract). When the bridge
  // can serve the call (balanceOf / allowance / decimals in particular)
  // we drive a useState + useEffect to fetch async; otherwise return
  // the existing stable-empty sentinel.
  const { connection } = useConnection();
  const demo = useContext(DemoContextObj);
  const call = (args ?? {}) as {
    functionName?: string;
    args?: readonly unknown[];
    address?: unknown;
    query?: { enabled?: boolean };
  };
  const enabled = call.query?.enabled !== false;
  const fnName = call.functionName;
  const argsKey = JSON.stringify(call.args ?? [], (_k, v) =>
    typeof v === "bigint" ? `${v}n` : v,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [state, setState] = useState<{ data: any; error: Error | null }>({
    data: undefined,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !demo || !fnName) {
      setState({ data: undefined, error: null });
      return;
    }
    const { bridge, portfolio, markets } = buildBridgeCtxs(demo, connection);
    void (async () => {
      try {
        const out = await dispatchRead(call, bridge, portfolio, markets);
        if (cancelled) return;
        if (out === NOT_HANDLED) {
          setState({ data: undefined, error: null });
        } else {
          setState({ data: out, error: null });
        }
      } catch (e) {
        if (cancelled) return;
        setState({ data: undefined, error: e as Error });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, fnName, argsKey, enabled, connection]);

  return {
    data: state.data,
    error: state.error,
    isLoading: false,
    isError: !!state.error,
    isSuccess: state.data !== undefined,
    isPending: false,
    isFetching: false,
    status: state.error ? "error" : "success",
    refetch: STABLE_REFETCH,
  } as unknown as ReadContractResult<T>;
}

export interface ReadContractsItem<T = unknown> {
  status: "success" | "failure";
  result: T | undefined;
  error?: Error;
}

export interface ReadContractsResult<
  T extends readonly unknown[] = readonly unknown[],
> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  isPending: boolean;
  isFetching: boolean;
  status: "pending" | "error" | "success";
  refetch: () => Promise<{ data: T | undefined; error: Error | null }>;
}

export function useReadContracts<
  T extends readonly unknown[] = readonly ReadContractsItem[],
>(args?: unknown): ReadContractsResult<T> {
  // Multicall hook: walk the contracts list and route each leg through the
  // same dispatch chain `useReadContract` uses. Returns
  // `{status, result}` per leg in upstream's expected shape so destructuring
  // (`data?.[i]?.result`) keeps working.
  const { connection } = useConnection();
  const demo = useContext(DemoContextObj);
  const call = (args ?? {}) as {
    contracts?: ReadCallShape[];
    query?: { enabled?: boolean };
  };
  const enabled = call.query?.enabled !== false;
  const contracts = call.contracts ?? [];
  // Stable-ish dependency key: function names + arg shapes.
  const contractsKey = JSON.stringify(
    contracts.map((c) => ({
      a: c?.address,
      f: c?.functionName,
      g: c?.args ?? [],
    })),
    (_k, v) => (typeof v === "bigint" ? `${v}n` : v),
  );

  const [state, setState] = useState<{
    data: ReadContractsItem[] | undefined;
    error: Error | null;
  }>({ data: undefined, error: null });

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !demo || contracts.length === 0) {
      setState({ data: undefined, error: null });
      return;
    }
    const { bridge, portfolio, markets } = buildBridgeCtxs(demo, connection);
    void (async () => {
      const results: ReadContractsItem[] = await Promise.all(
        contracts.map(async (c) => {
          try {
            const out = await dispatchRead(c, bridge, portfolio, markets);
            if (out === NOT_HANDLED) {
              return { status: "success", result: undefined };
            }
            return { status: "success", result: out };
          } catch (e) {
            return {
              status: "failure",
              result: undefined,
              error: e as Error,
            };
          }
        }),
      );
      if (cancelled) return;
      setState({ data: results, error: null });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, contractsKey, enabled, connection]);

  return {
    data: state.data as unknown as T | undefined,
    error: state.error,
    isLoading: false,
    isError: !!state.error,
    isSuccess: state.data !== undefined,
    isPending: false,
    isFetching: false,
    status: state.error ? "error" : "success",
    refetch: STABLE_REFETCH,
  } as unknown as ReadContractsResult<T>;
}

// ─── Write hooks (real failure path) ────────────────────────────────────────

export class SolanaForkUnsupported extends Error {
  constructor(operation: string) {
    super(
      `[sooth-solana] EVM contract write '${operation}' is not available in the Solana fork. ` +
        "The chain-shim layer surfaces this gap intentionally; wire the call to @sooth/sdk-solana to enable.",
    );
    this.name = "SolanaForkUnsupported";
  }
}

interface WriteArgs {
  functionName?: string;
  [k: string]: unknown;
}

interface WriteCallbacks {
  onSuccess?: (data: Hash) => void;
  onError?: (error: Error) => void;
  onSettled?: (data: Hash | undefined, error: Error | null) => void;
}

export function useWriteContract(_opts?: unknown) {
  const { connection } = useConnection();
  const demo = useContext(DemoContextObj);
  const [data, setData] = useState<Hash | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(false);

  const run = async (args?: WriteArgs): Promise<Hash> => {
    if (demo) {
      const { bridge } = buildBridgeCtxs(demo, connection);
      const out = await dispatchAmmWrite(args ?? {}, bridge);
      if (out !== NOT_HANDLED) {
        return out as Hash;
      }
    }
    throw new SolanaForkUnsupported(args?.functionName ?? "writeContract");
  };

  return {
    writeContract: (args?: WriteArgs, opts?: WriteCallbacks): void => {
      setIsPending(true);
      setError(null);
      void run(args)
        .then((hash) => {
          setData(hash);
          setIsPending(false);
          opts?.onSuccess?.(hash);
          opts?.onSettled?.(hash, null);
        })
        .catch((err: Error) => {
          setError(err);
          setIsPending(false);
          opts?.onError?.(err);
          opts?.onSettled?.(undefined, err);
        });
    },
    writeContractAsync: async (
      args?: WriteArgs,
      opts?: WriteCallbacks,
    ): Promise<Hash> => {
      setIsPending(true);
      setError(null);
      try {
        const hash = await run(args);
        setData(hash);
        setIsPending(false);
        opts?.onSuccess?.(hash);
        opts?.onSettled?.(hash, null);
        return hash;
      } catch (err) {
        const e = err as Error;
        setError(e);
        setIsPending(false);
        opts?.onError?.(e);
        opts?.onSettled?.(undefined, e);
        throw e;
      }
    },
    data,
    error,
    isPending,
    isError: !!error,
    isSuccess: !!data && !error,
    reset: () => {
      setData(undefined);
      setError(null);
      setIsPending(false);
    },
    status: (isPending
      ? "pending"
      : error
        ? "error"
        : data
          ? "success"
          : "idle") as "idle" | "pending" | "error" | "success",
  };
}

export function useSendTransaction(_opts?: unknown) {
  return {
    sendTransaction: (_args?: unknown, _opts2?: unknown): void => {
      throw new SolanaForkUnsupported("sendTransaction");
    },
    sendTransactionAsync: async (
      _args?: unknown,
      _opts2?: unknown,
    ): Promise<Hash> => {
      throw new SolanaForkUnsupported("sendTransaction");
    },
    data: undefined as Hash | undefined,
    error: null as Error | null,
    isPending: false,
    isError: false,
    isSuccess: false,
    reset: () => {},
    status: "idle" as const,
  };
}

// ─── Tx receipt watcher (sentinel) ──────────────────────────────────────────

export interface UseWaitForTxReceiptArgs {
  hash?: Hash | undefined;
  chainId?: number;
  query?: { enabled?: boolean };
  confirmations?: number;
  timeout?: number;
  pollingInterval?: number;
  [k: string]: unknown;
}

export interface WaitForTxReceiptResult {
  data: TransactionReceipt | undefined;
  error: Error | null;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  isPending: boolean;
  isFetching: boolean;
  status: "pending" | "error" | "success";
}

export function useWaitForTransactionReceipt(
  args?: UseWaitForTxReceiptArgs,
): WaitForTxReceiptResult {
  // The Solana adapter's `submit` awaits confirmation before resolving.
  // By the time upstream's `useWriteContract.onSuccess` callback hands the
  // hash to this hook, the transaction has already been confirmed. Mirror
  // EVM semantics by reporting `isSuccess` immediately when a hash is
  // present.
  const hasHash = !!args?.hash;
  if (!hasHash) {
    return {
      data: undefined,
      error: null,
      isLoading: false,
      isError: false,
      isSuccess: false,
      isPending: false,
      isFetching: false,
      status: "pending",
    };
  }
  return {
    data: { transactionHash: args!.hash as Hash, logs: [] },
    error: null,
    isLoading: false,
    isError: false,
    isSuccess: true,
    isPending: false,
    isFetching: false,
    status: "success",
  };
}

// ─── Watch / subscribe (no-op) ──────────────────────────────────────────────

export interface UseWatchContractEventArgs {
  address?: Address;
  abi?: unknown;
  eventName?: string;
  args?: unknown;
  onLogs?: (logs: unknown[]) => void;
  onError?: (error: Error) => void;
  enabled?: boolean;
  chainId?: number;
  poll?: boolean;
  pollingInterval?: number;
  syncConnectedChain?: boolean;
  [k: string]: unknown;
}

export function useWatchContractEvent(args?: UseWatchContractEventArgs): void {
  useEffect(() => {
    void args;
  }, [args]);
}

// ─── Provider / config helpers (no-op) ──────────────────────────────────────

import type { ReactNode } from "react";

export function WagmiProvider({ children }: { children: ReactNode }) {
  // The Solana fork mounts `<ConnectionProvider>` + `<WalletProvider>` in
  // `main.tsx`. WagmiProvider is a no-op here; upstream code never imports
  // this directly into pages — only `main.tsx` does.
  return children as unknown as ReturnType<() => ReactNode>;
}

export function createConfig(_args: unknown): unknown {
  return {};
}

export function createConnector<T>(creator: (config: unknown) => T): T {
  return creator({});
}
