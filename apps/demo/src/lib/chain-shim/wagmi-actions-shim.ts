// chain-shim/wagmi-actions-shim — stand-in for `wagmi/actions`. Upstream's
// `Launchpad.tsx` calls `waitForTransactionReceipt(config, { hash })` from
// the wagmi/actions module. The Solana fork has no equivalent; the shim
// returns a sentinel receipt and lets upstream's catch-blocks handle the
// gap.

import type { TransactionReceipt, Hash } from "./viem-shim";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function waitForTransactionReceipt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _config: any,
  _args: {
    hash: Hash;
    chainId?: number;
    timeout?: number;
    confirmations?: number;
  },
): Promise<TransactionReceipt> {
  return { transactionHash: "0x0" as Hash, logs: [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAccount(_config: any) {
  return { status: "disconnected" as const, address: undefined };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function connect(_config: any, _args: unknown) {
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reconnect(_config: any) {
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readContract(_config: any, _args: unknown) {
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function writeContract(
  _config: any,
  _args: unknown,
): Promise<Hash> {
  return "0x0" as Hash;
}
