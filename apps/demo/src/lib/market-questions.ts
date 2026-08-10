// Remembering what a market actually asked.
//
// The program stores `question_hash: [u8; 32]` and nothing else — the text is
// hashed client-side and never sent, so it cannot be read back from chain at
// any price. That is a deliberate cost decision, but it leaves the UI with
// nothing to show: every market renders as its own address, and one base58
// string looks like any other. A user cannot tell the market they just created
// from a seeded one, which is worse than it sounds, because the two route to
// different venues.
//
// Upstream filled this from the indexer (`indexerMarket?.name`). With
// `VITE_USE_INDEXER=false` that is always null.
//
// So: remember locally what this browser submitted. Deliberately narrow —
//
//   - It only covers markets created in THIS browser. Someone else's market
//     still shows an address, and so does yours on another device. There is no
//     way around that client-side; the durable fix is to emit the question in
//     `MarketCreated` and read it back off the creation transaction, the same
//     way `readBookHistory` reads events, or to run an indexer.
//   - It is a display cache, never a source of truth. Nothing routes, prices
//     or settles on it. The worst a corrupted entry can do is show a wrong
//     title next to a correct address.
//
// localStorage rather than sessionStorage on purpose: a market outlives the
// tab that created it, and the previous side channel lost everything the
// moment the tab closed.

const KEY = "__soothMarketQuestions";

type QuestionMap = Record<string, string>;

/**
 * One key shape, whatever the caller holds.
 *
 * The same market appears as three strings in this codebase: a bare base58
 * PDA from the SDK, a `sol:`-prefixed ref from the bridge, and a synthetic
 * `0x<base58>` from the EVM-shaped shim (`marketRefToEvmAddr` just prepends
 * "0x" — it is not hex). Keying on the raw string would store under one form
 * and look up under another, and the lookup would silently miss.
 */
function normalize(market: string): string {
  return market.replace(/^sol:/, "").replace(/^0x/, "");
}

function read(): QuestionMap {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Anything unexpected is treated as absent rather than trusted: this is
    // user-writable storage, and a bad shape must not throw on a render path.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as QuestionMap;
  } catch {
    return {};
  }
}

/** Remember the question for a market PDA. No-ops if either is missing. */
export function rememberMarketQuestion(
  marketPda: string | undefined,
  question: string | undefined,
): void {
  if (!marketPda || !question || !question.trim()) return;
  try {
    if (typeof localStorage === "undefined") return;
    const map = read();
    map[normalize(marketPda)] = question.trim();
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage disabled or full. A missing title is a cosmetic loss, and
    // throwing here would take down the market-creation flow with it.
  }
}

/**
 * The remembered question for a market, if this browser created it.
 *
 * Accepts any of the three forms the codebase uses — bare base58, `sol:`-
 * prefixed, or the shim's synthetic `0x` — see `normalize`.
 */
export function lookupMarketQuestion(
  market: string | undefined,
): string | undefined {
  if (!market) return undefined;
  const hit = read()[normalize(market)];
  return typeof hit === "string" && hit.trim() ? hit : undefined;
}
