import React, { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "@/lib/chain-shim";
import { ChevronDown, AlertCircle } from "lucide-react";
import {
  allowedChains,
  getChainById,
  DEFAULT_CHAIN_ID,
} from "../../lib/chains";
import { ensureChain, getEthereumProvider } from "../../lib/ensureChain";
import { useChainStore } from "../../store/useChainStore";
import { cn } from "../../lib/utils";
import toast from "react-hot-toast";
import { Button } from "./Button";
import { logger } from "../../lib/logger";

export const ChainSelector: React.FC = () => {
  const { isConnected } = useAccount();
  const walletChainId = useChainId();
  const { selectedChainId, setSelectedChain } = useChainStore();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const selectedChain = getChainById(selectedChainId);
  const walletChain = getChainById(walletChainId);
  const isWrongNetwork =
    isConnected && walletChainId !== selectedChainId && !isSwitching;

  const handleChainSwitch = async (chainId: number) => {
    setIsOpen(false);

    // Update selected chain in store
    setSelectedChain(chainId);

    // If wallet is connected, try to switch
    if (isConnected && switchChainAsync) {
      try {
        await switchChainAsync({ chainId });
        toast.success(`Network: ${getChainById(chainId)?.name}`);
      } catch (error: any) {
        logger.chain.error(
          "Chain switch failed via wagmi, trying EIP-3085 fallback:",
          error,
        );

        // Fallback: Try direct EIP-3085/3326 (for Phantom and wallets that need chain added)
        try {
          const provider = getEthereumProvider({ allowPhantom: false });
          if (provider) {
            const success = await ensureChain(provider, chainId);
            if (success) {
              toast.success(`Network: ${getChainById(chainId)?.name}`);
              return;
            } else {
              toast.error("Chain switch rejected by wallet");
              return;
            }
          }
        } catch (fallbackError: any) {
          logger.chain.error("EIP-3085 fallback also failed:", fallbackError);
        }

        if (error.message?.includes("rejected")) {
          toast.error("Chain switch rejected by wallet");
        } else {
          toast.error(
            "Could not switch network. Try again or switch in your wallet.",
          );
        }
      }
    }
  };

  // If selected chain is invalid (e.g., removed from allowedChains), reset to default
  React.useEffect(() => {
    if (!selectedChain && isConnected) {
      setSelectedChain(DEFAULT_CHAIN_ID);
    }
  }, [selectedChain, isConnected, setSelectedChain]);

  // Close on Escape + click outside
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        btnRef.current?.focus();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const el = containerRef.current;
      if (el && !el.contains(e.target as Node)) setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [isOpen]);

  // Only show when wallet is connected
  if (!isConnected) return null;

  // Use fallback chain if selectedChain is invalid
  const displayChain = selectedChain || getChainById(DEFAULT_CHAIN_ID);
  if (!displayChain) return null;

  return (
    <div ref={containerRef} className="relative" style={{ zIndex: 100 }}>
      {/* Main Button */}
      <button
        ref={btnRef}
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "inline-flex items-center gap-1 sm:gap-2 h-8 px-2 sm:px-3 border transition-all text-xs sm:text-sm font-semibold",
          isWrongNetwork
            ? "bg-raised border-error text-muted hover:border-error"
            : "bg-inset border-rule text-ink hover:border-accent hover:bg-raised",
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="tabular-nums">{displayChain.displayName}</span>
        {isSwitching && (
          <span className="ml-1 text-xs text-muted">Switching…</span>
        )}
        <ChevronDown
          size={14}
          className={cn("transition-transform", isOpen && "rotate-180")}
        />
      </button>

      {/* Wrong Network Warning */}
      {isWrongNetwork && walletChain && (
        <div className="absolute top-full left-0 mt-2 w-64 p-3 bg-error/90 border border-error z-overlay">
          <div className="flex items-start gap-2 mb-2">
            <AlertCircle
              size={16}
              className="text-muted mt-0.5 flex-shrink-0"
            />
            <div className="text-xs text-muted">
              <p className="font-semibold mb-1">Wrong Network</p>
              <p className="text-muted">
                Wallet is on{" "}
                <span className="font-mono">{walletChain.name}</span>
              </p>
            </div>
          </div>
          <Button
            onClick={() => handleChainSwitch(Number(selectedChainId))}
            className="w-full mt-2"
            variant="danger"
            size="sm"
          >
            Switch to {displayChain.name}
          </Button>
        </div>
      )}

      {/* Dropdown */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-sticky"
            onClick={() => setIsOpen(false)}
          />

          {/* Menu */}
          <div className="absolute top-full right-0 mt-2 w-60 bg-raised border border-rule z-overlay overflow-hidden">
            <div className="p-2 border-b border-rule">
              <p className="font-mono text-xs text-muted uppercase tracking-wider font-semibold px-2">
                Network
              </p>
            </div>
            <div className="p-1">
              {allowedChains
                .filter((chain) => chain.type === "evm")
                .map((chain) => {
                  const isSelected = chain.id === selectedChainId;
                  const isWalletChain = chain.id === walletChainId;

                  return (
                    <button
                      key={chain.id}
                      onClick={() =>
                        handleChainSwitch(
                          typeof chain.id === "number"
                            ? chain.id
                            : DEFAULT_CHAIN_ID,
                        )
                      }
                      disabled={isSelected}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 font-mono text-xs transition-colors",
                        isSelected
                          ? "text-accent cursor-default"
                          : "text-ink hover:bg-subtle",
                      )}
                      role="option"
                      aria-selected={isSelected}
                    >
                      <div
                        className={cn(
                          "w-1.5 h-1.5",
                          isSelected ? "bg-accent" : "bg-transparent",
                        )}
                      />
                      <div className="flex-1 text-left">
                        <div className="font-medium">{chain.name}</div>
                        <div className="text-xs text-muted tabular-nums font-mono">
                          {chain.nativeCurrency.symbol}
                        </div>
                      </div>

                      {isWalletChain && !isSelected && (
                        <div className="text-xs text-ink font-medium">
                          Connected
                        </div>
                      )}
                    </button>
                  );
                })}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
