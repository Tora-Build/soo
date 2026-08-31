import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_CHAIN_ID } from '../lib/chains';
import { resetPortfolioCaches } from '../lib/chain-shim/portfolio-bridge';
import { resetAmmCaches } from '../lib/chain-shim/amm-bridge';

interface ChainState {
  selectedChainId: number | string;
  setSelectedChain: (chainId: number | string) => void;
}

export const useChainStore = create<ChainState>()(
  persist(
    (set) => ({
      selectedChainId: DEFAULT_CHAIN_ID,
      // The chain-shim's caches are keyed by market PDA, which is unique
      // only WITHIN a cluster: the same address on devnet and on a local
      // validator are different accounts holding different balances. This
      // is the one moment that ambiguity can produce wrong numbers, so the
      // caches are dropped here instead of being re-keyed everywhere.
      setSelectedChain: (chainId: number | string) => {
        resetPortfolioCaches();
        resetAmmCaches();
        set({ selectedChainId: chainId });
      },
    }),
    {
      name: 'sooth-chain-storage',
    }
  )
);
