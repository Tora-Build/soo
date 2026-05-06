// `useRpcHealth` — pings the active Solana RPC on mount and on a 5s
// interval, surfacing a simple { ok, lastError } result. Used by:
//
//   - `<RpcStatus />` — header badge (Localnet OK / Localnet down)
//   - `<WalletButton />` wrapper — to render a precise "validator not
//     reachable" message instead of letting the wallet adapter swallow the
//     RPC failure.
//
// We use `connection.getVersion()` because it's the cheapest healthcheck
// the RPC exposes — no slot, no account, no transaction.
//
// The interval keeps short so a freshly-booted validator is detected
// quickly, but isn't aggressive enough to spam the RPC. 5s is a compromise
// shared with most wallet UIs.

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

export interface RpcHealth {
  // null = not yet probed (initial render).
  ok: boolean | null;
  // Last error message from a failed probe; cleared on a successful probe.
  lastError: string | null;
  // Endpoint string echoed for display (avoids reaching into config).
  endpoint: string;
}

const PROBE_INTERVAL_MS = 5_000;

export function useRpcHealth(): RpcHealth {
  const { connection } = useConnection();
  const endpoint = connection.rpcEndpoint;
  const [state, setState] = useState<RpcHealth>({
    ok: null,
    lastError: null,
    endpoint,
  });

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        await connection.getVersion();
        if (!cancelled) {
          setState({ ok: true, lastError: null, endpoint });
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setState({ ok: false, lastError: msg, endpoint });
        }
      }
    }

    void probe();
    const id = setInterval(() => void probe(), PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, endpoint]);

  return state;
}
