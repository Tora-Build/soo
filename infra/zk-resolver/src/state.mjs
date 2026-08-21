// The local journal.
//
// IMPORTANT: this is NOT what makes the resolver idempotent. The chain is.
// `decideAction` skips any market whose `AdjudicatorEntry` already carries an
// `attested_outcome`, and `attest_outcome_zk` independently rejects a second
// attestation with `AlreadyAttested`. Both hold with an empty journal, across
// a restart, a redeploy, a duplicated cron tick, or two operators running the
// service at once.
//
// What the journal adds is operational memory: the signature that resolved
// each market, when it happened, and a backoff after a failure so a market
// that fails for a structural reason is not retried every five minutes
// forever. Deleting the file costs nothing but that history.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Retry backoff after a failed attempt, in seconds, by consecutive failures. */
const BACKOFF_SECONDS = [0, 60, 300, 900, 3600];

export class Journal {
  #path;
  #data;

  constructor(path) {
    this.#path = path;
    this.#data = { version: 1, markets: {} };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && parsed.markets) {
          this.#data = parsed;
        }
      } catch {
        // A corrupt journal is not a reason to stop resolving — the chain
        // still holds the authoritative state. Start fresh.
      }
    }
  }

  get(market) {
    return this.#data.markets[market] ?? null;
  }

  /**
   * Whether a market is in backoff after recent failures.
   *
   * Only failures back off. A success is terminal (the chain now says
   * attested, so `decideAction` skips it) and a skip records nothing.
   */
  inBackoff(market, now) {
    const rec = this.get(market);
    if (!rec?.lastFailureAt || rec.resolvedSignature) return false;
    const fails = Math.min(rec.failures ?? 1, BACKOFF_SECONDS.length - 1);
    return now < rec.lastFailureAt + BACKOFF_SECONDS[fails];
  }

  retryAt(market) {
    const rec = this.get(market);
    if (!rec?.lastFailureAt) return null;
    const fails = Math.min(rec.failures ?? 1, BACKOFF_SECONDS.length - 1);
    return rec.lastFailureAt + BACKOFF_SECONDS[fails];
  }

  recordSuccess(market, { signature, outcome, value, at }) {
    this.#data.markets[market] = {
      resolvedSignature: signature,
      outcome,
      value: value == null ? null : String(value),
      resolvedAt: at,
      failures: 0,
    };
    this.#flush();
  }

  recordFailure(market, { error, at }) {
    const prev = this.get(market) ?? {};
    this.#data.markets[market] = {
      ...prev,
      lastError: String(error).slice(0, 500),
      lastFailureAt: at,
      failures: (prev.failures ?? 0) + 1,
    };
    this.#flush();
  }

  /** Write via a temp file and rename, so a crash mid-write cannot truncate it. */
  #flush() {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`);
    renameSync(tmp, this.#path);
  }
}
