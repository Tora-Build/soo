// Header badge that surfaces RPC reachability. Three states:
//
//   - probing (initial): subdued grey "checking…"
//   - ok: green "Localnet" / "Devnet" / "Mainnet" — endpoint-derived label
//   - down: red "Localnet down" with a tooltip giving the last error and a
//     hint to run `pnpm dev:localnet`.
//
// Endpoint-label heuristic: `127.0.0.1`/`localhost` → Localnet; the
// `*.devnet.*` / `*.mainnet.*` substrings infer the cluster from the URL.
// Falls back to `RPC` for anything else.
//
// Hook-call gating: `useRpcHealth` reads from `useConnection`, which throws
// if no `ConnectionProvider` is mounted. The test path mounts
// `<DemoProvider override>` directly — no wallet-adapter providers — so we
// short-circuit before the hook runs.

import { useDemo } from "../lib/DemoContext";
import { useRpcHealth } from "../hooks/useRpcHealth";

function endpointLabel(endpoint: string): string {
  const e = endpoint.toLowerCase();
  if (e.includes("127.0.0.1") || e.includes("localhost")) return "Localnet";
  if (e.includes("devnet")) return "Devnet";
  if (e.includes("testnet")) return "Testnet";
  if (e.includes("mainnet")) return "Mainnet";
  return "RPC";
}

export function RpcStatus() {
  const { isOverride } = useDemo();
  if (isOverride) {
    // The bankrun shim doesn't expose a real RPC endpoint; the test
    // doesn't care about RPC health and the providers aren't mounted.
    return null;
  }
  return <ProductionRpcStatus />;
}

function ProductionRpcStatus() {
  const { ok, lastError, endpoint } = useRpcHealth();
  const label = endpointLabel(endpoint);

  if (ok === null) {
    return (
      <span
        className="px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-slate-500 border border-slate-700 rounded"
        data-testid="rpc-status"
        data-rpc-state="probing"
        title={`Probing ${endpoint}`}
      >
        {label} · checking
      </span>
    );
  }

  if (ok) {
    return (
      <span
        className="px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-emerald-400 border border-emerald-700/50 rounded"
        data-testid="rpc-status"
        data-rpc-state="ok"
        title={endpoint}
      >
        {label} · ok
      </span>
    );
  }

  const hint =
    label === "Localnet"
      ? "Run `pnpm --filter @sooth/demo dev:localnet`"
      : "Check VITE_SOLANA_RPC_URL";

  return (
    <span
      className="px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-rose-400 border border-rose-700/50 rounded cursor-help"
      data-testid="rpc-status"
      data-rpc-state="down"
      title={`${endpoint}\n${lastError ?? "unknown error"}\n${hint}`}
    >
      {label} · down
    </span>
  );
}
