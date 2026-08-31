import { useState } from "react";
import { Button } from "../components/ui/Button";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  usePublicClient,
} from "@/lib/chain-shim";
import { parseUnits, formatUnits, parseAbi } from "@/lib/chain-shim";
import { demoConfig, tokenLabels } from "../lib/config";
import { useBaseTokenDecimals } from "../hooks/useBaseTokenDecimals";
import { Coins, ExternalLink, Info, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { logger } from "../lib/logger";
import { useHasModeBanner } from "../components/layout/ModeBanner";

// Simple ABIs for faucet
const MOCK_ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/**
 * Say what actually went wrong.
 *
 * `err.shortMessage` is a wagmi/viem field that a plain `Error` from the
 * Solana bridge never carries, so this falls through to `err.message` and
 * classifies from the raw text. The commonest failure is not a broken faucet
 * at all: the public devnet RPC rate-limits a browser that has already loaded
 * a market page, and `getLatestBlockhash` throws 429 before anything is even
 * sent. That is a fixable environment problem, but only if it is named.
 */
function faucetErrorMessage(err: unknown): string {
  const short =
    err && typeof err === "object" && "shortMessage" in err
      ? String((err as { shortMessage: unknown }).shortMessage)
      : "";
  const raw = short || (err instanceof Error ? err.message : String(err ?? ""));

  if (/\b429\b|too many requests|rate.?limit/i.test(raw)) {
    return "RPC rate-limited (429). The public devnet endpoint cannot serve the demo — set VITE_SOLANA_RPC_URL to a dedicated RPC and restart.";
  }
  if (/VITE_TEST_MINT_AUTHORITY_BYTES/.test(raw)) {
    return "Faucet key missing — re-run the seed to regenerate .env.local.";
  }
  if (/predates the venue split|missing the venue mints/.test(raw)) {
    return "SDK build is stale — run: pnpm -F @sooth/sdk-solana build, then restart the dev server.";
  }
  if (/connect a wallet/i.test(raw)) {
    return "Connect a wallet first.";
  }
  return raw ? `Mint failed: ${raw}` : "Failed to mint tokens";
}

/**
 * Single-token faucet: every venue in this deployment — the bonding curve and
 * the order book — trades in the same mock USDC mint, so one card funds
 * everything a wallet needs to trade.
 */
export const Faucet = () => {
  const hasModeBanner = useHasModeBanner();
  const { t } = useTranslation();
  const { address, isConnected } = useAccount();

  const [isMinting, setIsMinting] = useState(false);
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const decimals = useBaseTokenDecimals();

  const programs = demoConfig.node.programs as
    | Record<string, string | undefined>
    | undefined;
  const mintAddress = programs?.usdcMint;

  const { data: balance, refetch } = useReadContract({
    address: mintAddress as `0x${string}` | undefined,
    abi: MOCK_ERC20_ABI,
    functionName: "balanceOf",
    args: [address || "0x0"],
    query: { enabled: !!address && !!mintAddress },
  });

  const handleMint = async () => {
    if (!address) {
      toast.error("Please connect your wallet first");
      return;
    }
    if (!mintAddress) {
      toast.error(`${tokenLabels.book} mint not configured for this cluster`);
      return;
    }

    setIsMinting(true);
    const tid = toast.loading(`Requesting 100,000 ${tokenLabels.book}...`);

    try {
      const amount = parseUnits("100000", decimals);

      // `address` selects WHICH mint — the bridge resolves it the same way it
      // resolves a balance read, so the faucet and the balance always agree.
      const hash = await writeContractAsync({
        address: mintAddress as `0x${string}`,
        abi: MOCK_ERC20_ABI,
        functionName: "mint",
        args: [address, amount],
      });

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash });
        toast.success(`100,000 ${tokenLabels.book} received!`, { id: tid });
        refetch();
      } else {
        toast.success("Transaction sent!", { id: tid });
      }
    } catch (err: unknown) {
      logger.rpc.error("Faucet error:", err);
      toast.error(faucetErrorMessage(err), { id: tid });
    } finally {
      setIsMinting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-8">
      {/* On /power the arcade banner already reads "Fuel your next run —
          collect test assets and jump back into the arena", so this block
          repeated the page's name underneath it. Under /eastboard/faucet
          there is no banner and this is the page's only title. */}
      {!hasModeBanner && (
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-bold text-ink">{t("faucet.title")}</h1>
          <p className="text-muted text-sm">{t("faucet.subtitle")}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="panel p-6">
          <h3 className="text-xl font-bold text-ink mb-1 flex items-center gap-2">
            <Coins className="text-muted w-5 h-5" />
            {tokenLabels.book}
          </h3>

          <p className="text-muted text-sm mb-6 mt-3">
            Mints test USDC for trading on devnet.
          </p>

          <div className="bg-inset p-4 mb-6 border border-rule">
            <div className="flex justify-between items-center text-sm mb-1">
              <span className="text-muted">{t("faucet.yourBalance")}</span>
              <span className="text-ink font-mono font-bold">
                {balance !== undefined
                  ? Number(
                      formatUnits(balance as bigint, decimals),
                    ).toLocaleString()
                  : "0"}
              </span>
            </div>
            <div className="text-xs text-faint font-mono truncate">
              {mintAddress || "Not configured"}
            </div>
          </div>

          <Button
            data-testid="faucet-mint-button-usdc"
            className="btn btn-primary w-full"
            onClick={handleMint}
            isLoading={isMinting}
            disabled={!isConnected}
          >
            {isConnected ? `Request 100,000` : "Connect Wallet to Mint"}
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
            Note: the faucet token is a mock with no real value, for protocol
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
