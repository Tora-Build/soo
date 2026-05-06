import React from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_CHAIN_ID } from '../lib/chains';

export type ChainType = 'evm' | 'solana';

export interface ChainInfo {
  id: number | string;
  name: string;
  type: ChainType;
  isTestnet?: boolean;
}

interface ChainState {
  selectedChainId: number | string;
  setSelectedChain: (chainId: number | string) => void;
  getChainType: () => ChainType;
  isSolana: () => boolean;
  isEVM: () => boolean;
}

// Solana chain IDs (using string format to distinguish from EVM)
export const SOLANA_DEVNET_ID = 'solana-devnet';
export const SOLANA_MAINNET_ID = 'solana-mainnet';

export const useChainStore = create<ChainState>()(
  persist(
    (set, get) => ({
      selectedChainId: DEFAULT_CHAIN_ID,
      setSelectedChain: (chainId: number | string) => set({ selectedChainId: chainId }),

      getChainType: () => {
        const chainId = get().selectedChainId;
        if (typeof chainId === 'string' && chainId.startsWith('solana-')) {
          return 'solana';
        }
        return 'evm';
      },

      isSolana: () => get().getChainType() === 'solana',
      isEVM: () => get().getChainType() === 'evm',
    }),
    {
      name: 'sooth-chain-storage',
    }
  )
);
