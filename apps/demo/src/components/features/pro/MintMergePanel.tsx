import { useState, useEffect, useCallback, useRef } from "react";
import { formatUnits, parseUnits, maxUint256, type Address } from "@/lib/chain-shim";
import {
  useAccount,
  useChainId,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "@/lib/chain-shim";
import { Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "../../../lib/utils";
import { ERC20_ABI, SOOTHBOOK_ABI } from "../../../config/abis";
import { useDeployments } from "../../../hooks/useDeployments";
import { useBaseTokenDecimals } from "../../../hooks/useBaseTokenDecimals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MintMergePanelProps {
  marketAddress: Address;
  marketKey: `0x${string}`;
  soothBookAddress?: Address;
}

type Tab = "mint" | "merge";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MintMergePanel({
  marketAddress,
  marketKey,
  soothBookAddress: soothBookProp,
}: MintMergePanelProps) {
  const { address: user } = useAccount();
  const chainId = useChainId();
  const { contracts } = useDeployments();
  const decimals = useBaseTokenDecimals();

  const usdcAddress = (contracts.MockUSDC ?? contracts.USDC) as
    | Address
    | undefined;
  const soothBookAddress = (soothBookProp ?? contracts.SoothBook) as
    | Address
    | undefined;
  // OrderEngine is the actual USDC custodian — SoothBook.mint delegates
  // the `safeTransferFrom` call to it, so allowance must target OrderEngine.
  const orderEngineAddress = contracts.OrderEngine as Address | undefined;

  const [tab, setTab] = useState<Tab>("mint");
  const [amount, setAmount] = useState("");
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | null>(
    null,
  );
  const pendingToastIdRef = useRef<string | null>(null);

  // -----------------------------------------------------------------------
  // Read balances, allowance, decimals
  // -----------------------------------------------------------------------

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      // 0: getBalance → [yesBalance, noBalance]
      {
        address: soothBookAddress,
        abi: SOOTHBOOK_ABI,
        functionName: "getBalance",
        args: user && marketKey ? [marketKey, user] : undefined,
        chainId,
      },
      // 1: USDC balanceOf
      {
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: user ? [user] : undefined,
        chainId,
      },
      // 2: USDC allowance (spender = OrderEngine, the actual custodian)
      {
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args:
          user && orderEngineAddress ? [user, orderEngineAddress] : undefined,
        chainId,
      },
    ],
    query: {
      enabled:
        !!user && !!usdcAddress && !!soothBookAddress && !!orderEngineAddress,
    },
  });

  const yesBalance =
    (reads?.[0]?.result as [bigint, bigint] | undefined)?.[0] ?? 0n;
  const noBalance =
    (reads?.[0]?.result as [bigint, bigint] | undefined)?.[1] ?? 0n;
  const usdcBalance = (reads?.[1]?.result as bigint) ?? 0n;
  const allowance = (reads?.[2]?.result as bigint) ?? 0n;

  // -----------------------------------------------------------------------
  // Derived values
  // -----------------------------------------------------------------------

  // SoothBook.mint/merge take WAD amounts and convert to collateral
  // decimals internally via _wadToBaseUnits. YES/NO outcome tokens are
  // also WAD.
  const amountWad = (() => {
    if (!amount || isNaN(Number(amount))) return 0n;
    try {
      return parseUnits(amount, 18);
    } catch {
      return 0n;
    }
  })();

  // For USDC balance/allowance comparisons, scale the user's input to
  // the token's actual decimals.
  const amountInUsdcUnits = (() => {
    if (!amount || isNaN(Number(amount))) return 0n;
    try {
      return parseUnits(amount, decimals);
    } catch {
      return 0n;
    }
  })();

  const needsApproval =
    tab === "mint" && amountInUsdcUnits > 0n && amountInUsdcUnits > allowance;

  const maxMerge = yesBalance < noBalance ? yesBalance : noBalance;

  const maxAmount =
    tab === "mint"
      ? formatUnits(usdcBalance, decimals)
      : formatUnits(maxMerge, 18);

  const isValidAmount =
    amountWad > 0n &&
    (tab === "mint" ? amountInUsdcUnits <= usdcBalance : amountWad <= maxMerge);

  // -----------------------------------------------------------------------
  // Write contract
  // -----------------------------------------------------------------------

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    reset: resetWrite,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({
      hash: pendingTxHash ?? undefined,
    });

  // Track pending tx hash
  useEffect(() => {
    if (txHash) setPendingTxHash(txHash);
  }, [txHash]);

  // Handle confirmation
  useEffect(() => {
    if (isConfirmed && pendingTxHash) {
      if (pendingToastIdRef.current) {
        toast.dismiss(pendingToastIdRef.current);
        pendingToastIdRef.current = null;
      }
      toast.success(
        needsApproval ? "Approved" : tab === "mint" ? "Minted" : "Merged",
      );
      setPendingTxHash(null);
      setAmount("");
      resetWrite();
      refetch();
    }
  }, [isConfirmed, pendingTxHash, needsApproval, tab, resetWrite, refetch]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const handleSubmit = useCallback(() => {
    if (
      !user ||
      !soothBookAddress ||
      !usdcAddress ||
      !orderEngineAddress ||
      amountWad === 0n
    )
      return;

    const toastId = `tx-${Date.now()}`;
    pendingToastIdRef.current = toastId;

    const handleError = (err: Error) => {
      if (pendingToastIdRef.current) {
        toast.dismiss(pendingToastIdRef.current);
        pendingToastIdRef.current = null;
      }
      toast.error(err.message.slice(0, 80));
    };

    if (needsApproval) {
      toast.loading("Approving USDC…", { id: toastId });
      writeContract(
        {
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          // Approve OrderEngine (the custodian SoothBook.mint delegates to)
          // with maxUint256 so we never re-approve in this session.
          args: [orderEngineAddress, maxUint256],
        },
        {
          onError: handleError,
        },
      );
      return;
    }

    if (tab === "mint") {
      toast.loading("Minting tokens…", { id: toastId });
      writeContract(
        {
          address: soothBookAddress,
          abi: SOOTHBOOK_ABI,
          functionName: "mint",
          // SoothBook.mint takes WAD; it converts to collateral decimals
          // internally via _wadToBaseUnits for the safeTransferFrom.
          args: [marketKey, amountWad],
        },
        {
          onError: handleError,
        },
      );
    } else {
      toast.loading("Merging tokens…", { id: toastId });
      writeContract(
        {
          address: soothBookAddress,
          abi: SOOTHBOOK_ABI,
          functionName: "merge",
          args: [marketKey, amountWad],
        },
        {
          onError: handleError,
        },
      );
    }
  }, [
    user,
    soothBookAddress,
    usdcAddress,
    orderEngineAddress,
    amountWad,
    needsApproval,
    tab,
    marketKey,
    writeContract,
  ]);

  const handleMax = useCallback(() => {
    setAmount(maxAmount);
  }, [maxAmount]);

  // -----------------------------------------------------------------------
  // Button label
  // -----------------------------------------------------------------------

  const buttonLabel = (() => {
    if (!user) return "Connect Wallet";
    if (isWritePending || isConfirming) return "Confirming…";
    if (!isValidAmount && amount) return "Invalid Amount";
    if (needsApproval) return "Approve USDC";
    return tab === "mint" ? "Mint Tokens" : "Merge Tokens";
  })();

  const isDisabled =
    !user ||
    isWritePending ||
    isConfirming ||
    (!isValidAmount && !!amount) ||
    !amount;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-3">
      {/* Mint / Merge sub-tab */}
      <div className="flex border-b border-rule">
        {(["mint", "merge"] as const).map((t) => (
          <button
            key={t}
            data-testid={`mm-tab-${t}`}
            onClick={() => {
              setTab(t);
              setAmount("");
            }}
            className={cn(
              "flex-1 pb-2 font-mono text-xs uppercase tracking-[0.12em] transition-colors border-b-2 -mb-px",
              tab === t
                ? "text-accent border-accent"
                : "text-faint border-transparent hover:text-muted",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Balances */}
      <div className="grid grid-cols-3 gap-3 text-xs font-mono">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">
            USDC
          </span>
          <span className="text-ink tabular-nums">
            ${Number(formatUnits(usdcBalance, decimals)).toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">
            YES
          </span>
          <span className="text-ink tabular-nums">
            {Math.floor(Number(formatUnits(yesBalance, 18))).toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">
            NO
          </span>
          <span className="text-ink tabular-nums">
            {Math.floor(Number(formatUnits(noBalance, 18))).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Amount input with MAX button inside */}
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          data-testid="mm-amount-input"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="input-field w-full pl-3 pr-16 py-3 text-sm tabular-nums"
        />
        <button
          data-testid="mm-max"
          onClick={handleMax}
          className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] font-mono uppercase tracking-[0.12em] text-accent hover:text-ink transition-colors"
        >
          Max
        </button>
      </div>

      {/* Info line */}
      <p className="text-[10px] font-mono uppercase tracking-[0.12em] text-faint leading-relaxed">
        {tab === "mint"
          ? "Deposit USDC to receive equal YES + NO tokens"
          : "Burn equal YES + NO tokens to reclaim USDC"}
      </p>

      {/* Submit button */}
      <button
        data-testid="mm-submit"
        onClick={handleSubmit}
        disabled={isDisabled}
        className={cn(
          "w-full py-2.5 font-mono text-sm font-medium transition-all flex items-center justify-center gap-2",
          isDisabled
            ? "bg-raised text-faint cursor-not-allowed"
            : "btn btn-primary",
        )}
      >
        {(isWritePending || isConfirming) && (
          <Loader2 className="w-4 h-4 animate-spin" />
        )}
        {buttonLabel}
      </button>
    </div>
  );
}
