/**
 * EIP-3085 / EIP-3326 chain switching utilities
 * Handles adding chains to wallets that don't have them configured (e.g., Phantom on Base Sepolia)
 */

import { allowedChains, type AllowedChain } from './chains';

// EIP-3085 AddEthereumChainParameter format
interface AddEthereumChainParameter {
  chainId: string; // Hex string
  chainName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/**
 * Convert chain ID to hex string (0x prefixed)
 */
export function chainIdToHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

/**
 * Convert AllowedChain to EIP-3085 AddEthereumChainParameter
 */
export function chainToAddParams(chain: AllowedChain): AddEthereumChainParameter {
  return {
    chainId: chainIdToHex(chain.id as number),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [chain.rpcUrl],
    blockExplorerUrls: [chain.explorerUrl],
  };
}

/**
 * Ensure the wallet is on the specified chain.
 * If the chain isn't added, attempts to add it first via EIP-3085.
 * 
 * @param ethereum - The window.ethereum provider
 * @param chainId - The target chain ID (number)
 * @returns true if switch succeeded, false if user rejected
 * @throws Error if switch fails for non-recoverable reasons
 */
export async function ensureChain(
  ethereum: any,
  chainId: number
): Promise<boolean> {
  if (!ethereum) {
    throw new Error('No Ethereum provider found');
  }

  const targetHex = chainIdToHex(chainId);
  
  // Check current chain
  const currentChainHex = await ethereum.request({ method: 'eth_chainId' });
  if (currentChainHex?.toLowerCase() === targetHex.toLowerCase()) {
    return true; // Already on the right chain
  }

  // Try to switch
  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: targetHex }],
    });
    return true;
  } catch (switchError: any) {
    // 4902 = Chain not added to wallet
    if (switchError?.code === 4902) {
      // Find chain config
      const chain = allowedChains.find(c => c.id === chainId);
      if (!chain) {
        throw new Error(`Chain ${chainId} not found in allowedChains`);
      }

      // Try to add the chain
      try {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [chainToAddParams(chain)],
        });
        return true;
      } catch (addError: any) {
        // User rejected adding chain
        if (addError?.code === 4001) {
          return false;
        }
        throw addError;
      }
    }
    
    // User rejected switch
    if (switchError?.code === 4001) {
      return false;
    }
    
    throw switchError;
  }
}

/**
 * Get the raw ethereum provider from window
 * Prefers MetaMask/Coinbase when multiple injected providers exist.
 *
 * Notes:
 * - Some wallets (including Phantom) inject EVM providers that can "win" as the default.
 * - When multiple providers exist, `window.ethereum.providers` is commonly populated.
 * - We only fall back to Phantom if no better EVM provider is present.
 */
export function getEthereumProvider(opts?: { allowPhantom?: boolean }): any {
  if (typeof window === 'undefined') return null;

  const allowPhantom = opts?.allowPhantom ?? false;
  const eth = (window as any).ethereum;
  const phantom = (window as any).phantom?.ethereum;

  const candidates: any[] = [];

  // Multi-injected providers array (MetaMask + others)
  if (eth && Array.isArray(eth.providers)) {
    candidates.push(...eth.providers);
  } else if (eth) {
    candidates.push(eth);
  }

  // Phantom can also expose a separate provider
  if (phantom && phantom !== eth) {
    candidates.push(phantom);
  }

  const uniq = Array.from(new Set(candidates.filter(Boolean)));
  if (uniq.length === 0) return null;

  const pick = (pred: (p: any) => boolean) => uniq.find(pred);

  // Prefer MetaMask, then Coinbase Wallet, then any non-Phantom provider
  const mm = pick((p) => !!p?.isMetaMask);
  if (mm) return mm;

  const cb = pick((p) => !!p?.isCoinbaseWallet);
  if (cb) return cb;

  const nonPhantom = pick((p) => !p?.isPhantom);
  if (nonPhantom) return nonPhantom;

  return allowPhantom ? uniq[0] : null;
}
