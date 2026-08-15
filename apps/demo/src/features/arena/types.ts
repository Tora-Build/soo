export type ArenaOutcome = "yes" | "no" | "watch";
export type ArenaReaction = "fire" | "brain";
export type ArenaVenue = "amm" | "orderbook";

export interface ArenaProfile {
  wallet: string;
  handle: string;
  xp: number;
  tickets: number;
  streak: number;
  plays: number;
  season: number;
  lastActiveDay: string | null;
  lastDailyClaim: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArenaLeaderboardEntry {
  rank: number;
  wallet: string;
  handle: string;
  xp: number;
  streak: number;
  plays: number;
}

export interface ArenaComment {
  id: string;
  wallet: string;
  handle: string;
  body: string;
  createdAt: number;
}

export interface ArenaSocial {
  market: string;
  reactions: Record<ArenaReaction, number>;
  viewerReaction: ArenaReaction | null;
  sentiment: {
    yes: number;
    no: number;
    total: number;
    yesPercent: number;
  };
  commentCount: number;
  comments: ArenaComment[];
}

export interface ArenaBootstrap {
  profile: ArenaProfile | null;
  leaderboard: ArenaLeaderboardEntry[];
  social: ArenaSocial | null;
}

export interface ConfirmedArenaTrade {
  market: string;
  outcome: Exclude<ArenaOutcome, "watch">;
  venue: ArenaVenue;
  chainId: number;
  txHash: `0x${string}`;
}
