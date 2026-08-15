import { useCallback, useMemo, useEffect } from "react";
import {
  useAccount,
  usePublicClient,
  useWalletClient,
  useChainId,
  useBalance,
  useReadContract,
  useConfig,
  useDemo,
} from "@/lib/chain-shim";
import { Terminal, Wallet, Key, Download } from "lucide-react";
import { formatUnits } from "@/lib/chain-shim";
import { Card } from "../components/ui/Card";
import { WebTerminal } from "../components/features/WebTerminal";
import { SoothSDK, type OutputLine } from "../lib/sdk";
import deployments from "../config/deployments.json";
import { allowedChains } from "../lib/chains";
import { parseAbi } from "@/lib/chain-shim";
import { useLocalWallet } from "../hooks/useLocalWallet";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const WELCOME_OUTPUT: OutputLine[] = [
  { type: "bold", text: "SOOTH PROTOCOL SDK CLI v1.0" },
  { type: "dim", text: "────────────────────────────────────────" },
  { type: "plain", text: "" },
  { type: "info", text: 'Type "help" for available commands' },
  { type: "plain", text: "" },
];

export function Geek() {
  const { t } = useTranslation();
  const { address: connectedAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const qc = useQueryClient();
  const { data: connectedWalletClient } = useWalletClient();
  const wagmiConfig = useConfig();

  const networkConfig = useMemo(() => {
    return Object.values(deployments.networks).find(
      (n) => n.chainId === chainId,
    );
  }, [chainId]);

  const currentChain = useMemo(() => {
    return wagmiConfig.chains.find((c) => c.id === chainId);
  }, [wagmiConfig.chains, chainId]);

  const rpcUrlForLocalWallet = useMemo(() => {
    const chain = allowedChains.find((c) => c.id === chainId);
    return chain?.rpcUrl;
  }, [chainId]);

  const localWallet = useLocalWallet(currentChain, rpcUrlForLocalWallet);

  const activeAddress = localWallet.isActive
    ? localWallet.address
    : connectedAddress;
  const activeWalletClient = localWallet.isActive
    ? localWallet.walletClient
    : connectedWalletClient;

  const isSupported = !!networkConfig;
  const hasWallet = localWallet.isActive || isConnected;

  const rpcHost = useMemo(() => {
    const chain = allowedChains.find((c) => c.id === chainId);
    if (!chain?.rpcUrl) return null;
    try {
      return new URL(chain.rpcUrl).host;
    } catch {
      return chain.rpcUrl;
    }
  }, [chainId]);

  const { data: gasBalance } = useBalance({
    address: activeAddress ?? undefined,
    query: { enabled: hasWallet && isSupported },
  });

  const { data: usdcBalance } = useReadContract({
    address: networkConfig?.contracts.MockUSDC as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: activeAddress ? [activeAddress] : undefined,
    query: {
      enabled: hasWallet && isSupported && !!networkConfig?.contracts.MockUSDC,
    },
  });

  const { data: usdcDecimals } = useReadContract({
    address: networkConfig?.contracts.MockUSDC as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "decimals",
    query: {
      enabled: hasWallet && isSupported && !!networkConfig?.contracts.MockUSDC,
    },
  });

  const demo = useDemo();
  const sdk = useMemo(() => {
    if (!publicClient || !chainId || !isSupported) return null;

    try {
      return new SoothSDK(
        chainId,
        publicClient,
        activeWalletClient ?? undefined,
        activeAddress ?? undefined,
        // 5th arg is Solana-fork-only — the SDK pulls adapter + signer +
        // market ref from here for the wired commands (balance, buyyes,
        // buyno, mint, marketstatus).
        demo,
      );
    } catch {
      return null;
    }
  }, [
    chainId,
    publicClient,
    activeWalletClient,
    activeAddress,
    isSupported,
    demo,
  ]);

  useEffect(() => {
    if (sdk && activeAddress) {
      sdk.setAddress(activeAddress);
    }
  }, [sdk, activeAddress]);

  useEffect(() => {
    if (sdk && activeWalletClient) {
      sdk.setWalletClient(activeWalletClient);
    }
  }, [sdk, activeWalletClient]);

  // Commands that change on-chain state — after they finish we must
  // invalidate React Query so the AMM trading panel, portfolio, indexer
  // hooks, etc. all refetch and stop showing the pre-write snapshot.
  const WRITE_COMMANDS = new Set([
    "createmarket",
    "graduate",
    "approve",
    "mint",
    "trade",
    "buy",
    "sell",
    "merge",
    "redeem",
    "claim",
    "resolve",
    "settle",
    "dismiss",
    "veto",
    "attest",
    "faucet",
    "transfer",
  ]);

  const handleCommand = useCallback(
    async (
      input: string,
      stream?: (line: OutputLine) => void,
    ): Promise<OutputLine[]> => {
      const parts = input.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      const subCmd = parts[1]?.toLowerCase();

      if (cmd === "localwallet" || cmd === "lw") {
        if (!subCmd || subCmd === "status") {
          if (localWallet.isActive) {
            return [
              { type: "success", text: "Local wallet ACTIVE" },
              { type: "plain", text: `Address: ${localWallet.address}` },
              { type: "dim", text: "All transactions auto-signed (no popups)" },
            ];
          }
          return [
            {
              type: "info",
              text: localWallet.hasStoredKey
                ? "Local wallet DISABLED"
                : "Local wallet not set up",
            },
            { type: "plain", text: "" },
            { type: "plain", text: "Commands:" },
            { type: "plain", text: "  lw create   Generate new wallet" },
            ...(localWallet.hasStoredKey
              ? [
                  {
                    type: "plain" as const,
                    text: "  lw enable   Activate stored wallet",
                  },
                  {
                    type: "dim" as const,
                    text: `              (${localWallet.storedAddress})`,
                  },
                ]
              : []),
            { type: "plain", text: "  lw disable  Deactivate (keep key)" },
            { type: "plain", text: "  lw clear    Remove wallet permanently" },
          ];
        }

        if (subCmd === "create") {
          const addr = localWallet.create();
          return [
            { type: "success", text: "Local wallet created!" },
            { type: "plain", text: `Address: ${addr}` },
            {
              type: "dim",
              text: "Send native gas token to this address to start",
            },
          ];
        }

        if (subCmd === "enable") {
          if (localWallet.isActive) {
            return [
              { type: "info", text: "Local wallet already active" },
              { type: "plain", text: `Address: ${localWallet.address}` },
            ];
          }
          const addr = localWallet.enable();
          if (!addr) {
            return [
              { type: "error", text: "No stored wallet. Use: lw create" },
            ];
          }
          return [
            { type: "success", text: "Local wallet enabled!" },
            { type: "plain", text: `Address: ${addr}` },
          ];
        }

        if (subCmd === "disable") {
          if (!localWallet.isActive) {
            return [{ type: "info", text: "Local wallet already disabled" }];
          }
          localWallet.disable();
          return [
            { type: "success", text: "Local wallet disabled" },
            {
              type: "dim",
              text: 'Key preserved. Use "lw enable" to reactivate.',
            },
          ];
        }

        if (subCmd === "clear") {
          localWallet.clear();
          return [{ type: "success", text: "Local wallet cleared" }];
        }

        return [
          {
            type: "error",
            text: "Unknown subcommand. Use: lw create|enable|disable|clear",
          },
        ];
      }

      if (!sdk) {
        return [
          {
            type: "error",
            text: "SDK not initialized. Connect wallet to a supported chain.",
          },
        ];
      }

      if (!hasWallet) {
        const readOnlyCommands = ["help", "state", "book", "info", "markets"];
        if (cmd && !readOnlyCommands.includes(cmd)) {
          return [
            {
              type: "error",
              text: 'No wallet. Use "lw create" or connect via navbar.',
            },
          ];
        }
      }

      if (cmd === "createmarket") {
        let streamed = false;
        const out = (line: OutputLine) => {
          streamed = true;
          stream?.(line);
        };
        const { output } = await sdk.createmarket(parts.slice(1), out);
        return streamed ? [] : output;
      }

      if (cmd === "graduate") {
        let streamed = false;
        const out = (line: OutputLine) => {
          streamed = true;
          stream?.(line);
        };
        const { output } = await sdk.graduate(parts.slice(1), out);
        return streamed ? [] : output;
      }

      if (cmd === "simulate") {
        let streamed = false;
        const out = (line: OutputLine) => {
          streamed = true;
          stream?.(line);
        };
        const { output } = await sdk.simulate(parts.slice(1), out);
        return streamed ? [] : output;
      }

      const { output } = await sdk.executeCommand(input);
      return output;
    },
    [sdk, hasWallet, localWallet],
  );

  // Wrap handleCommand so any write-type command triggers a global cache
  // invalidation when it returns (success OR failure — the partial state
  // change still needs to surface). Read-only commands are skipped to
  // avoid unnecessary refetches on every `balance` / `whoami` query.
  const handleCommandWithRefresh = useCallback(
    async (
      input: string,
      stream?: (line: OutputLine) => void,
    ): Promise<OutputLine[]> => {
      const cmd = input.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      try {
        return await handleCommand(input, stream);
      } finally {
        if (WRITE_COMMANDS.has(cmd)) {
          await qc.invalidateQueries();
        }
      }
    },
    [handleCommand, qc],
  );

  const formatBalance = (
    value: bigint | undefined,
    decimals: number,
    symbol: string,
    maxDecimals = 2,
  ) => {
    if (value === undefined) return "—";
    const formatted = parseFloat(formatUnits(value, decimals));
    return `${formatted.toLocaleString(undefined, { minimumFractionDigits: maxDecimals, maximumFractionDigits: maxDecimals })}${symbol ? ` ${symbol}` : ""}`;
  };

  return (
    <div className="h-[calc(100vh-12rem)] flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Terminal className="text-muted w-8 h-8" />
          <div>
            <h1 className="text-lg font-bold text-ink">{t("geek.title")}</h1>
            <p className="text-sm text-muted">{t("geek.subtitle")}</p>
          </div>
        </div>
        <button
          disabled
          className="flex items-center gap-2 px-3 py-1.5 bg-raised/50 border border-rule text-muted cursor-not-allowed opacity-50"
          title="Coming Soon"
        >
          <Download className="w-4 h-4" />
          <span className="text-sm">SDK</span>
          <span className="text-xs px-1.5 py-0.5 bg-raised/50 text-muted">
            Soon
          </span>
        </button>
      </div>

      {!isSupported ? (
        <Card className="flex-1 flex items-center justify-center border-rule bg-raised">
          <div className="text-center space-y-4">
            <Wallet className="w-12 h-12 text-muted mx-auto" />
            <h2 className="text-xl font-bold text-ink">Unsupported Network</h2>
            <p className="text-muted max-w-md">
              Switch to a supported network using the chain selector in the
              navbar.
            </p>
          </div>
        </Card>
      ) : (
        <div className="flex-1 flex flex-col border border-rule bg-raised overflow-hidden">
          {/* Terminal title bar */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-rule bg-inset select-none">
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: "rgba(255, 95, 87, 0.7)" }}
                />
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: "rgba(254, 188, 46, 0.7)" }}
                />
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: "rgba(40, 201, 63, 0.7)" }}
                />
              </div>
              <span className="ml-3 font-mono text-xs uppercase tracking-[0.12em] text-faint">
                sooth-cli — {currentChain?.name ?? "unknown"}
              </span>
            </div>
            <span className="font-mono text-xs text-faint">v0.1.2</span>
          </div>
          {/* Terminal body */}
          <div className="flex-1 min-h-0">
            <WebTerminal
              onCommand={handleCommandWithRefresh}
              prompt="sooth>"
              initialOutput={WELCOME_OUTPUT}
            />
          </div>
        </div>
      )}

      {isSupported && (
        <div className="text-xs px-1 text-muted space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {hasWallet && (
                <>
                  <span>
                    Gas:{" "}
                    {gasBalance
                      ? `${parseFloat(gasBalance.formatted).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${gasBalance.symbol}`
                      : "—"}
                  </span>
                  <span>
                    USDC:{" "}
                    {formatBalance(
                      usdcBalance as bigint | undefined,
                      Number(usdcDecimals ?? 18),
                      "",
                      2,
                    )}
                  </span>
                </>
              )}
              {rpcHost && <span>RPC: {rpcHost}</span>}
              {!hasWallet && (
                <span className="text-faint">Type "lw create" to start</span>
              )}
            </div>
            <span className="text-faint">↑↓ {t("geek.history")}</span>
          </div>
          {localWallet.isActive && localWallet.address && (
            <div className="flex items-center gap-2">
              <Key className="w-3 h-3 text-muted" />
              <span className="text-muted">LOCAL:</span>
              <span
                className="text-muted cursor-pointer hover:text-ink transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(localWallet.address!);
                }}
                title="Click to copy"
              >
                {localWallet.address}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
