// Adapter factory. The demo creates exactly one `SolanaChainAdapter` per
// (connection, programIds, usdcMint) tuple and reuses it across hooks. Tests
// inject their own connection (BankrunConnection) — production hits the
// configured RPC.
//
// Naming: this file is intentionally tiny. The whole point of the
// integrator-contract surface is that demos don't add their own glue;
// they call adapter methods directly.

import { Connection, PublicKey } from "@solana/web3.js";
import { SolanaChainAdapter, type SoothNode } from "@sooth/sdk-solana";

export interface BuildAdapterOpts {
  node: SoothNode;
  // Optional connection override (tests inject BankrunConnection).
  connection?: Connection;
}

export function buildAdapter(opts: BuildAdapterOpts): SolanaChainAdapter {
  const { node, connection } = opts;
  return new SolanaChainAdapter({
    node,
    connection: connection ?? new Connection(node.rpcUrl, "confirmed"),
    // The SolanaChainAdapter resolves programIds + usdcMint from
    // node.programs — we don't override unless the caller passes connection
    // (in which case the override path triggers the same resolution path).
    programIds: node.programs?.soothAmm
      ? {
          soothAmm: new PublicKey(node.programs.soothAmm),
          soothMarket: new PublicKey(
            node.programs.soothMarket ??
              "SoothMkt11111111111111111111111111111111111",
          ),
        }
      : undefined,
    usdcMint: node.programs?.usdcMint
      ? new PublicKey(node.programs.usdcMint)
      : undefined,
  });
}
