-- One handle, one player. The uniqueness key folds case — "Zakrad" and
-- "zakrad" are the same identity on a leaderboard — while the stored
-- handle keeps the casing its owner chose.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_handle ON arena_players (LOWER(handle));
