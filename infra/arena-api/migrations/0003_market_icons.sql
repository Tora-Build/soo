-- Creator-supplied market icons, keyed by market PDA.
--
-- Off-chain on purpose: an https URL committed into the on-chain question
-- hash pinned a MUTABLE target — the image behind a link changes at its
-- owner's whim, so the "immutable icon" was theater that cost two thirds of
-- the question's byte budget. A D1 row gives every viewer the same icon
-- without pretending it is something it is not.
CREATE TABLE market_icons (
  market TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  -- The wallet that set it — first writer wins, and only they may update.
  creator TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
