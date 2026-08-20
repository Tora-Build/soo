-- Arena social schema. Wallets and markets are base58 Solana pubkeys,
-- stored verbatim (base58 is case-sensitive; never case-fold these columns).

CREATE TABLE IF NOT EXISTS arena_players (
  wallet TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  tickets INTEGER NOT NULL DEFAULT 3 CHECK (tickets >= 0),
  streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  plays INTEGER NOT NULL DEFAULT 0 CHECK (plays >= 0),
  season INTEGER NOT NULL DEFAULT 1,
  last_active_day TEXT,
  last_daily_claim TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_nonces (
  wallet TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_sessions (
  token_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL REFERENCES arena_players(wallet) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_plays (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL REFERENCES arena_players(wallet) ON DELETE CASCADE,
  market TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('yes', 'no')),
  venue TEXT NOT NULL CHECK (venue IN ('amm', 'orderbook')),
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  xp_awarded INTEGER NOT NULL CHECK (xp_awarded >= 0),
  play_day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_daily_claims (
  wallet TEXT NOT NULL REFERENCES arena_players(wallet) ON DELETE CASCADE,
  claim_day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, claim_day)
);

CREATE TABLE IF NOT EXISTS arena_reactions (
  wallet TEXT NOT NULL REFERENCES arena_players(wallet) ON DELETE CASCADE,
  market TEXT NOT NULL,
  reaction TEXT NOT NULL CHECK (reaction IN ('fire', 'brain')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, market)
);

CREATE TABLE IF NOT EXISTS arena_comments (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL REFERENCES arena_players(wallet) ON DELETE CASCADE,
  market TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  hits INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arena_players_leaderboard
  ON arena_players(season, xp DESC, updated_at ASC);
CREATE INDEX IF NOT EXISTS idx_arena_plays_wallet_market
  ON arena_plays(wallet, market);
CREATE INDEX IF NOT EXISTS idx_arena_plays_market_created
  ON arena_plays(market, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arena_reactions_market
  ON arena_reactions(market, reaction);
CREATE INDEX IF NOT EXISTS idx_arena_comments_market_created
  ON arena_comments(market, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arena_sessions_expiry
  ON arena_sessions(expires_at);

CREATE TRIGGER IF NOT EXISTS arena_play_requires_ticket
BEFORE INSERT ON arena_plays
WHEN COALESCE((SELECT tickets FROM arena_players WHERE wallet = NEW.wallet), 0) < 1
BEGIN
  SELECT RAISE(ABORT, 'NO_TICKETS');
END;

CREATE TRIGGER IF NOT EXISTS arena_play_updates_profile
AFTER INSERT ON arena_plays
BEGIN
  UPDATE arena_players
  SET
    xp = xp + NEW.xp_awarded,
    tickets = tickets - 1,
    plays = plays + 1,
    streak = CASE
      WHEN last_active_day = NEW.play_day THEN streak
      WHEN last_active_day = date(NEW.play_day, '-1 day') THEN streak + 1
      ELSE 1
    END,
    last_active_day = NEW.play_day,
    updated_at = NEW.created_at
  WHERE wallet = NEW.wallet;
END;

CREATE TRIGGER IF NOT EXISTS arena_daily_updates_profile
AFTER INSERT ON arena_daily_claims
BEGIN
  UPDATE arena_players
  SET
    xp = xp + 250,
    tickets = tickets + 1,
    streak = CASE
      WHEN last_active_day = NEW.claim_day THEN streak
      WHEN last_active_day = date(NEW.claim_day, '-1 day') THEN streak + 1
      ELSE 1
    END,
    last_active_day = NEW.claim_day,
    last_daily_claim = NEW.claim_day,
    updated_at = NEW.created_at
  WHERE wallet = NEW.wallet;
END;
