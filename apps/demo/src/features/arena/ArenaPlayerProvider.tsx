import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAppKit, useAppKitAccount } from "../../lib/chain-shim/appkit-shim";
import { useAccount } from "@/lib/chain-shim";
import { useWallet } from "@solana/wallet-adapter-react";
import { arenaApi, ArenaApiError } from "./arenaApi";
import type {
  ArenaLeaderboardEntry,
  ArenaProfile,
  ArenaReaction,
  ArenaSocial,
  ConfirmedArenaTrade,
} from "./types";

interface StoredSession {
  token: string;
  expiresAt: number;
}

interface ArenaPlayerContextValue {
  wallet?: string;
  profile: ArenaProfile | null;
  leaderboard: ArenaLeaderboardEntry[];
  socialByMarket: Record<string, ArenaSocial>;
  isLoading: boolean;
  isAuthenticating: boolean;
  serviceError: string | null;
  isAuthenticated: boolean;
  connectWallet: () => void;
  authenticate: () => Promise<void>;
  refresh: (market?: string, silent?: boolean) => Promise<void>;
  claimDaily: () => Promise<ArenaProfile>;
  updateHandle: (handle: string) => Promise<ArenaProfile>;
  toggleReaction: (market: string, reaction: ArenaReaction) => Promise<ArenaSocial>;
  postComment: (market: string, body: string) => Promise<ArenaSocial>;
  registerConfirmedPlay: (trade: ConfirmedArenaTrade) => Promise<number>;
}

const ArenaPlayerContext = createContext<ArenaPlayerContextValue | null>(null);

const sessionKey = (wallet: string) => `sooth:arena-session:${wallet.toLowerCase()}`;

function readStoredSession(wallet?: string): StoredSession | null {
  if (!wallet || typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(sessionKey(wallet));
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredSession;
    if (!parsed.token || parsed.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
      localStorage.removeItem(sessionKey(wallet));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function ArenaPlayerProvider({ children }: { children: ReactNode }) {
  const { open: openAppKit } = useAppKit();
  const { address: wagmiAddress } = useAccount();
  const { address: appKitAddress } = useAppKitAccount();
  // Solana wallets sign raw bytes; the arena server's challenge is a UTF-8
  // string, and the signature travels base64 — the server treats it as an
  // opaque token bound to the wallet, so the encoding just has to be
  // consistent.
  const { signMessage: walletSignMessage } = useWallet();
  const signMessageAsync = async ({ message }: { message: string }) => {
    if (!walletSignMessage) {
      throw new Error("Connected wallet cannot sign messages");
    }
    const sig = await walletSignMessage(new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...sig));
  };
  const wallet = (wagmiAddress ?? appKitAddress)?.toLowerCase();
  const [profile, setProfile] = useState<ArenaProfile | null>(null);
  const [leaderboard, setLeaderboard] = useState<ArenaLeaderboardEntry[]>([]);
  const [socialByMarket, setSocialByMarket] = useState<Record<string, ArenaSocial>>({});
  const [session, setSession] = useState<StoredSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const authPromise = useRef<Promise<StoredSession> | null>(null);
  const activeWallet = useRef(wallet);
  activeWallet.current = wallet;

  const rememberSession = useCallback(
    (next: StoredSession | null) => {
      setSession(next);
      if (!wallet || typeof window === "undefined") return;
      if (next) localStorage.setItem(sessionKey(wallet), JSON.stringify(next));
      else localStorage.removeItem(sessionKey(wallet));
    },
    [wallet],
  );

  const refresh = useCallback(
    async (market?: string, silent = false) => {
      const requestedWallet = wallet;
      if (!silent) setIsLoading(true);
      try {
        const data = await arenaApi.bootstrap(requestedWallet, market);
        if (activeWallet.current !== requestedWallet) return;
        if (data.profile) setProfile(data.profile);
        else if (!requestedWallet) setProfile(null);
        setLeaderboard(data.leaderboard ?? []);
        if (data.social) {
          setSocialByMarket((current) => ({
            ...current,
            [data.social!.market.toLowerCase()]: data.social!,
          }));
        }
        setServiceError(null);
      } catch (error) {
        if (activeWallet.current !== requestedWallet) return;
        setServiceError(error instanceof Error ? error.message : "Arena sync is unavailable");
      } finally {
        if (!silent && activeWallet.current === requestedWallet) {
          setIsLoading(false);
        }
      }
    },
    [wallet],
  );

  useEffect(() => {
    setProfile(null);
    setSession(readStoredSession(wallet));
    void refresh();
  }, [refresh, wallet]);

  const createSession = useCallback(async () => {
    if (!wallet) {
      openAppKit();
      throw new ArenaApiError(401, "Connect a wallet to sync your player profile", "WALLET_REQUIRED");
    }
    if (!wagmiAddress) {
      throw new ArenaApiError(409, "Wallet connection is still syncing. Try again in a moment", "WALLET_SYNCING");
    }
    setIsAuthenticating(true);
    try {
      const challenge = await arenaApi.nonce(wallet);
      const signature = await signMessageAsync({ message: challenge.message });
      const result = await arenaApi.session(wallet, signature);
      const next = { token: result.token, expiresAt: result.expiresAt };
      rememberSession(next);
      setProfile(result.profile);
      setServiceError(null);
      return next;
    } finally {
      setIsAuthenticating(false);
    }
  }, [openAppKit, rememberSession, signMessageAsync, wagmiAddress, wallet]);

  const ensureSession = useCallback(
    async (force = false) => {
      const active = force ? null : session ?? readStoredSession(wallet);
      if (active && active.expiresAt > Math.floor(Date.now() / 1000) + 30) return active;
      if (authPromise.current) return authPromise.current;
      authPromise.current = createSession();
      try {
        return await authPromise.current;
      } finally {
        authPromise.current = null;
      }
    },
    [createSession, session, wallet],
  );

  const authenticated = useCallback(
    async <T,>(action: (token: string) => Promise<T>) => {
      let active = await ensureSession();
      try {
        return await action(active.token);
      } catch (error) {
        if (!(error instanceof ArenaApiError) || error.status !== 401) throw error;
        rememberSession(null);
        active = await ensureSession(true);
        return action(active.token);
      }
    },
    [ensureSession, rememberSession],
  );

  const authenticate = useCallback(async () => {
    await ensureSession();
  }, [ensureSession]);

  const claimDaily = useCallback(async () => {
    const result = await authenticated((token) => arenaApi.daily(token));
    setProfile(result.profile);
    setLeaderboard(result.leaderboard ?? []);
    return result.profile;
  }, [authenticated]);

  const updateHandle = useCallback(
    async (handle: string) => {
      const result = await authenticated((token) => arenaApi.profile(token, handle));
      setProfile(result.profile);
      setLeaderboard(result.leaderboard ?? []);
      return result.profile;
    },
    [authenticated],
  );

  const toggleReaction = useCallback(
    async (market: string, reaction: ArenaReaction) => {
      const result = await authenticated((token) => arenaApi.reaction(token, market, reaction));
      setSocialByMarket((current) => ({
        ...current,
        [market.toLowerCase()]: result.social,
      }));
      return result.social;
    },
    [authenticated],
  );

  const postComment = useCallback(
    async (market: string, body: string) => {
      const result = await authenticated((token) => arenaApi.comment(token, market, body));
      setSocialByMarket((current) => ({
        ...current,
        [market.toLowerCase()]: result.social,
      }));
      return result.social;
    },
    [authenticated],
  );

  const registerConfirmedPlay = useCallback(
    async (trade: ConfirmedArenaTrade) => {
      const result = await authenticated((token) => arenaApi.play(token, trade));
      setProfile(result.profile);
      if (result.leaderboard) setLeaderboard(result.leaderboard);
      if (result.social) {
        setSocialByMarket((current) => ({
          ...current,
          [trade.market.toLowerCase()]: result.social!,
        }));
      }
      return result.duplicate ? 0 : result.xpAwarded;
    },
    [authenticated],
  );

  const value = useMemo<ArenaPlayerContextValue>(
    () => ({
      wallet,
      profile,
      leaderboard,
      socialByMarket,
      isLoading,
      isAuthenticating,
      serviceError,
      isAuthenticated: Boolean(session),
      connectWallet: () => openAppKit(),
      authenticate,
      refresh,
      claimDaily,
      updateHandle,
      toggleReaction,
      postComment,
      registerConfirmedPlay,
    }),
    [
      wallet,
      profile,
      leaderboard,
      socialByMarket,
      isLoading,
      isAuthenticating,
      serviceError,
      session,
      openAppKit,
      authenticate,
      refresh,
      claimDaily,
      updateHandle,
      toggleReaction,
      postComment,
      registerConfirmedPlay,
    ],
  );

  return <ArenaPlayerContext.Provider value={value}>{children}</ArenaPlayerContext.Provider>;
}

export function useArenaPlayer() {
  const value = useContext(ArenaPlayerContext);
  if (!value) throw new Error("useArenaPlayer must be used within ArenaPlayerProvider");
  return value;
}
