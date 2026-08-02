// Which orderbook the demo writes to.
//
// Both are live on-chain while the migration finishes, so this is a real
// switch rather than dead configuration. Reads already come from the
// redesigned book (the depth panel decodes its single account); this governs
// the WRITE path.
//
// Default on. The redesigned book is the one under test, and leaving writes on
// the legacy path would mean the demo exercises an engine we are replacing —
// the opposite of what a localnet run is for. Set
// `VITE_USE_LEGACY_BOOK=1` to compare against the old behaviour.
export const USE_REDESIGNED_BOOK =
  import.meta.env?.VITE_USE_LEGACY_BOOK !== "1";
