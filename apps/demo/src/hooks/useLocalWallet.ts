import { useState, useCallback, useMemo } from 'react';
import { createWalletClient, http, type WalletClient, type Chain } from '@/lib/chain-shim';
import { privateKeyToAccount, generatePrivateKey } from '@/lib/chain-shim';

const STORAGE_KEY = 'sooth_local_wallet';

export interface LocalWalletState {
  privateKey: `0x${string}` | null;
  address: `0x${string}` | null;
  walletClient: WalletClient | null;
  isActive: boolean;
}

export function useLocalWallet(chain: Chain | undefined, rpcUrl?: string) {
  const [privateKey, setPrivateKey] = useState<`0x${string}` | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored as `0x${string}` | null;
  });

  const [isEnabled, setIsEnabled] = useState(true);

  const account = useMemo(() => {
    if (!privateKey || !isEnabled) return null;
    try {
      return privateKeyToAccount(privateKey);
    } catch {
      return null;
    }
  }, [privateKey, isEnabled]);

  const storedAddress = useMemo(() => {
    if (!privateKey) return null;
    try {
      return privateKeyToAccount(privateKey).address;
    } catch {
      return null;
    }
  }, [privateKey]);

  const walletClient = useMemo(() => {
    if (!account || !chain) return null;
    return createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });
  }, [account, chain, rpcUrl]);

  const create = useCallback(() => {
    const newKey = generatePrivateKey();
    localStorage.setItem(STORAGE_KEY, newKey);
    setPrivateKey(newKey);
    setIsEnabled(true);
    return privateKeyToAccount(newKey).address;
  }, []);

  const importKey = useCallback((key: string): `0x${string}` | null => {
    const normalized = key.startsWith('0x') ? key : `0x${key}`;
    try {
      const acc = privateKeyToAccount(normalized as `0x${string}`);
      localStorage.setItem(STORAGE_KEY, normalized);
      setPrivateKey(normalized as `0x${string}`);
      setIsEnabled(true);
      return acc.address;
    } catch {
      return null;
    }
  }, []);

  const enable = useCallback((): `0x${string}` | null => {
    if (!privateKey) return null;
    setIsEnabled(true);
    return storedAddress;
  }, [privateKey, storedAddress]);

  const disable = useCallback(() => {
    setIsEnabled(false);
  }, []);

  const clear = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setPrivateKey(null);
    setIsEnabled(false);
  }, []);

  const hasStoredKey = !!privateKey;

  return {
    privateKey: isEnabled ? privateKey : null,
    address: account?.address ?? null,
    storedAddress,
    walletClient,
    isActive: !!account,
    hasStoredKey,
    create,
    importKey,
    enable,
    disable,
    clear,
  };
}
