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

/**
 * The two venues price in different tokens, so the faucet dispenses both.
 *
 * One faucet is not enough under the split: a wallet holding only the book's
 * token cannot trade the AMM, and every market trades on the AMM until it
 * graduates — so a single-token faucet leaves a new user unable to make their
 * first trade.
 *
 * Labelled by ROLE, not ticker. The AMM's token is chosen per deployment; the
 * name on the card would be wrong the moment the protocol is deployed with a
 * different one.
 */
const VENUES = [
  {
    key: "amm",
    role: "AMM",
    title: "AMM Token",
    blurb:
      "Collateral for the bonding-curve venue. Every market trades here until it graduates, so this is the token you need first.",
    mintKey: "ammMint",
  },
  {
    key: "book",
    role: "Book",
    title: "Mock USDC",
    blurb:
      "Collateral for the order book. Only usable on markets that have already graduated.",
    mintKey: "usdcMint",
  },
] as const;

function VenueFaucetCard({
  venue,
  mintAddress,
  address,
  isConnected,
  decimals,
  isMinting,
  balanceLabel,
  onMint,
}: {
  venue: (typeof VENUES)[number];
  mintAddress: string | undefined;
  address: string | undefined;
  isConnected: boolean;
  decimals: number;
  isMinting: boolean;
  balanceLabel: string;
  onMint: (
    venue: (typeof VENUES)[number],
    mintAddress: string | undefined,
    refetch: () => void,
  ) => void;
}) {
  const { data: balance, refetch } = useReadContract({
    address: mintAddress as `0x${string}` | undefined,
    abi: MOCK_ERC20_ABI,
    functionName: "balanceOf",
    args: [address || "0x0"],
    query: { enabled: !!address && !!mintAddress },
  });

  return (
    <div className="panel p-6">
      <h3 className="text-xl font-bold text-ink mb-1 flex items-center gap-2">
        <Coins className="text-muted w-5 h-5" />
        {venue.title}
      </h3>
      <div className="text-xs font-mono uppercase tracking-wide text-faint mb-4">
        {venue.role} venue
      </div>

      <p className="text-muted text-sm mb-6">{venue.blurb}</p>

      <div className="bg-inset p-4 mb-6 border border-rule">
        <div className="flex justify-between items-center text-sm mb-1">
          <span className="text-muted">{balanceLabel}</span>
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
        data-testid={`faucet-mint-button-${venue.key}`}
        className="btn btn-primary w-full"
        onClick={() => onMint(venue, mintAddress, refetch)}
        isLoading={isMinting}
        disabled={!isConnected}
      >
        {isConnected ? `Request 100,000` : "Connect Wallet to Mint"}
      </Button>
    </div>
  );
}

export const Faucet = () => {
  const { t } = useTranslation();
  const { address, isConnected } = useAccount();

  const [mintingKey, setMintingKey] = useState<string | null>(null);
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const decimals = useBaseTokenDecimals();

  const programs = demoConfig.node.programs as
    | Record<string, string | undefined>
    | undefined;

  const handleMint = async (
    venue: (typeof VENUES)[number],
    mintAddress: string | undefined,
    refetch: () => void,
  ) => {
    if (!address) {
      toast.error("Please connect your wallet first");
      return;
    }
    if (!mintAddress) {
      toast.error(`${venue.title} mint not configured for this cluster`);
      return;
    }

    setMintingKey(venue.key);
    const tid = toast.loading(`Requesting 100,000 ${venue.title}...`);

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
        toast.success(`100,000 ${venue.title} received!`, { id: tid });
        refetch();
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
      setMintingKey(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-8">
      <div className="space-y-2 text-center">
        <h1 className="text-lg font-bold text-ink">{t("faucet.title")}</h1>
        <p className="text-muted text-sm">{t("faucet.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {VENUES.map((venue) => (
          <VenueFaucetCard
            key={venue.key}
            venue={venue}
            mintAddress={programs?.[venue.mintKey]}
            address={address}
            isConnected={isConnected}
            decimals={decimals}
            isMinting={mintingKey === venue.key}
            balanceLabel={t("faucet.yourBalance")}
            onMint={handleMint}
          />
        ))}

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
            Note: both faucet tokens are mocks with no real value, for protocol
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
