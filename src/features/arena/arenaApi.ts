import type {
  ArenaBootstrap,
  ArenaLeaderboardEntry,
  ArenaProfile,
  ArenaReaction,
  ArenaSocial,
  ConfirmedArenaTrade,
} from "./types";

const API_BASE = (import.meta.env.VITE_ARENA_API_BASE || "").replace(/\/$/, "");

export class ArenaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH";
    token?: string;
    body?: unknown;
  } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}/api/arena/${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    throw new ArenaApiError(
      response.status,
      payload.error || `Arena service returned HTTP ${response.status}`,
      payload.code,
    );
  }
  return payload as T;
}

export const arenaApi = {
  bootstrap(wallet?: string, market?: string) {
    const params = new URLSearchParams();
    if (wallet) params.set("wallet", wallet);
    if (market) params.set("market", market);
    return request<ArenaBootstrap>(`bootstrap?${params.toString()}`);
  },

  nonce(wallet: string) {
    return request<{ wallet: string; message: string; expiresAt: number }>("nonce", {
      method: "POST",
      body: { wallet },
    });
  },

  session(wallet: string, signature: string) {
    return request<{ token: string; expiresAt: number; profile: ArenaProfile }>("session", {
      method: "POST",
      body: { wallet, signature },
    });
  },

  daily(token: string) {
    return request<{ profile: ArenaProfile; leaderboard: ArenaLeaderboardEntry[] }>("daily", {
      method: "POST",
      token,
    });
  },

  reaction(token: string, market: string, reaction: ArenaReaction) {
    return request<{ social: ArenaSocial }>("reaction", {
      method: "PUT",
      token,
      body: { market, reaction },
    });
  },

  comment(token: string, market: string, body: string) {
    return request<{ social: ArenaSocial }>("comments", {
      method: "POST",
      token,
      body: { market, body },
    });
  },

  profile(token: string, handle: string) {
    return request<{ profile: ArenaProfile; leaderboard: ArenaLeaderboardEntry[] }>("profile", {
      method: "PATCH",
      token,
      body: { handle },
    });
  },

  play(token: string, trade: ConfirmedArenaTrade) {
    return request<{
      duplicate: boolean;
      xpAwarded: number;
      profile: ArenaProfile;
      leaderboard?: ArenaLeaderboardEntry[];
      social?: ArenaSocial;
    }>("plays", {
      method: "POST",
      token,
      body: trade,
    });
  },
};
