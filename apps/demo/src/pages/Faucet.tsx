import { useState } from "react";
import { Button } from "../components/ui/Button";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  usePublicClient,
} from "@/lib/chain-shim";
import { parseUnits, formatUnits, parseAbi } from "@/lib/chain-shim";
import { demoConfig } from "../lib/config";
import { useBaseTokenDecimals } from "../hooks/useBaseTokenDecimals";
import { Coins, ExternalLink, Info, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { logger } from "../lib/logger";

// Simple ABIs for faucet
const MOCK_ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const Faucet = () => {
  const { t } = useTranslation();
  const { address, isConnected } = useAccount();
  // Solana fork: use the configured USDC mint from demoConfig instead of
  // the upstream EVM deployments.json lookup (which carries an EVM hex
  // address that's meaningless on Solana). The mint address is the same
  // SPL mint that all on-chain trades use.
  const usdcMintAddress = demoConfig.node.programs?.usdcMint as
    | string
    | undefined;

  const [isMinting, setIsMinting] = useState(false);
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const decimals = useBaseTokenDecimals();

  // Read current USDC balance
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: usdcMintAddress as `0x${string}` | undefined,
    abi: MOCK_ERC20_ABI,
    functionName: "balanceOf",
    args: [address || "0x0"],
    query: { enabled: !!address && !!usdcMintAddress },
  });

  const handleMint = async () => {
    if (!address) {
      toast.error("Please connect your wallet first");
      return;
    }
    if (!usdcMintAddress) {
      toast.error("USDC mint not configured for this cluster");
      return;
    }

    setIsMinting(true);
    const tid = toast.loading("Requesting 100,000 mUSDC...");

    try {
      const amount = parseUnits("100000", decimals);

      const hash = await writeContractAsync({
        address: usdcMintAddress as `0x${string}`,
        abi: MOCK_ERC20_ABI,
        functionName: "mint",
        args: [address, amount],
      });

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash });
        toast.success("100,000 mUSDC received!", { id: tid });
        refetchBalance();
      } else {
        toast.success("Transaction sent!", { id: tid });
      }
    } catch (err: unknown) {
      logger.rpc.error("Faucet error:", err);
      const message =
        err instanceof Error && "shortMessage" in err
          ? (err as { shortMessage: string }).shortMessage
          : "Failed to mint tokens";
      toast.error(message, { id: tid });
    } finally {
      setIsMinting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-8">
      <div className="space-y-2 text-center">
        <h1 className="text-lg font-bold text-ink">{t("faucet.title")}</h1>
        <p className="text-muted text-sm">{t("faucet.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* mUSDC Faucet */}
        <div className="panel p-6">
          <h3 className="text-xl font-bold text-ink mb-4 flex items-center gap-2">
            <Coins className="text-muted w-5 h-5" />
            Mock USDC
          </h3>

          <p className="text-muted text-sm mb-6">
            Mint 100,000 mUSDC to your wallet. This token is used as collateral
            for all trading on Sooth.
          </p>

          <div className="bg-inset p-4 mb-6 border border-rule">
            <div className="flex justify-between items-center text-sm mb-1">
              <span className="text-muted">{t("faucet.yourBalance")}</span>
              <span className="text-ink font-mono font-bold">
                {balance !== undefined
                  ? `${Number(formatUnits(balance as bigint, decimals)).toLocaleString()} mUSDC`
                  : "0 mUSDC"}
              </span>
            </div>
            <div className="text-xs text-faint font-mono truncate">
              {usdcMintAddress || "Not configured"}
            </div>
          </div>

          <Button
            data-testid="faucet-mint-button"
            className="btn btn-primary w-full"
            onClick={handleMint}
            isLoading={isMinting}
            disabled={!isConnected}
          >
            {isConnected ? "Request 100,000 mUSDC" : "Connect Wallet to Mint"}
          </Button>
        </div>

        {/* Native SOL Info */}
        <div className="panel p-6">
          <h3 className="text-xl font-bold text-ink mb-4 flex items-center gap-2">
            <Wallet className="text-muted w-5 h-5" />
            Native SOL
          </h3>

          <p className="text-muted text-sm mb-6">
            Transaction fees on Solana are paid in native SOL. Localnet airdrops
            are unlimited; devnet/mainnet require a real-faucet flow.
          </p>

          <div className="space-y-3">
            <div className="flex items-start gap-3 p-3 bg-raised border border-rule text-xs text-ink">
              <Info className="text-muted w-4 h-4 shrink-0 mt-0.5" />
              <p>
                Localnet:{" "}
                <code className="bg-inset px-1">
                  solana airdrop 10 &lt;your-pubkey&gt; --url
                  http://127.0.0.1:8899
                </code>
                . Devnet: use the official Solana faucet.
              </p>
            </div>
            <a
              href="https://faucet.solana.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-4 bg-inset border border-rule hover:border-accent/50 transition-colors group/link"
            >
              <span className="text-sm font-medium text-ink">
                Solana Devnet Faucet
              </span>
              <ExternalLink
                size={14}
                className="text-muted group-hover/link:text-accent"
              />
            </a>
          </div>
        </div>
      </div>

      {/* Warning / Tips */}
      <div className="panel p-4 flex items-start gap-3">
        <Info className="text-faint w-4 h-4 shrink-0 mt-0.5" />
        <div className="text-faint font-mono text-xs space-y-1">
          <p>
            Note: Mock USDC (mUSDC) has no real value and is for protocol
            testing only.
          </p>
          <p>
            If transactions fail, ensure you have enough native SOL on the
            connected wallet to pay tx fees.
          </p>
        </div>
      </div>
    </div>
  );
};
