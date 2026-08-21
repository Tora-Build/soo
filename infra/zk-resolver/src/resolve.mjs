// The decision procedure: given what the chain says about a market and what
// the registry claims about it, what should the resolver do?
//
// Pure — no network, no clock, no keys. Every input is a parameter, so the
// whole policy is unit-testable without a validator, and the effectful loop in
// `index.mjs` is left holding only the "do it" half.

/** Actions `decideAction` can return. */
export const ACTION = {
  /** Nothing to do, for a benign reason. */
  SKIP: "skip",
  /** Deadline passed but the market is still Open; lock it first. */
  LOCK: "lock",
  /** Locked, un-attested, rule verified: get an attestation and submit. */
  ATTEST: "attest",
  /** Configuration is wrong in a way that must not be papered over. */
  REFUSE: "refuse",
};

/**
 * Decides what to do with one market.
 *
 * The order of these checks is deliberate. Cheap and definitive facts first
 * (does it exist, is it zk-enabled, is it already done), because the expensive
 * step this all guards is a Primus attestation that can take a minute and a
 * transaction that costs a fee.
 *
 * IDEMPOTENCY lives in the `alreadyAttested` branch, and it is checked against
 * the CHAIN rather than any local journal. That is what makes the service
 * safe across restarts, redeploys, duplicate cron ticks and two operators
 * running it at once: the chain is the only authority on whether a market has
 * been resolved, and `attest_outcome_zk` independently rejects a second
 * attestation with `AlreadyAttested` even if two processes race past this
 * check simultaneously.
 */
export function decideAction({ chainState, ruleCheck, now, canLock }) {
  if (!chainState.exists) {
    return { action: ACTION.SKIP, reason: chainState.reason };
  }

  const { market, entry } = chainState;

  // A zeroed reserved region reads as `None`, which is every entry the manual
  // `register_adjudicator` path writes. Those markets resolve by signature,
  // not by attestation, and are not this service's business.
  if (entry.comparator === 0) {
    return {
      action: ACTION.SKIP,
      reason: "adjudicator entry is not zk-enabled (comparator None) — this market resolves manually",
    };
  }

  if (entry.attestedOutcome !== null && entry.attestedOutcome !== undefined) {
    return {
      action: ACTION.SKIP,
      reason: `already attested: outcome=${outcomeName(entry.attestedOutcome)} at ${entry.attestedAt}`,
      alreadyAttested: true,
    };
  }

  if (entry.disputed) {
    return {
      action: ACTION.SKIP,
      reason: "entry has been disputed — the guardian veto decides this market, not an attestation",
    };
  }

  if (now < market.deadline) {
    return {
      action: ACTION.SKIP,
      reason: `deadline not passed (${market.deadline - now}s remaining)`,
      dueIn: market.deadline - now,
    };
  }

  // Settled or Resolved markets are finished; Cancelled ones never resolve.
  if (market.lifecycle !== "open" && market.lifecycle !== "locked") {
    return {
      action: ACTION.SKIP,
      reason: `lifecycle is ${market.lifecycle} — nothing to attest`,
    };
  }

  // The rule check gates everything that costs money or takes time. A
  // mismatch means the operator's belief about this market's question has
  // diverged from what the market committed to, so it is refused rather than
  // attempted — the transaction would fail with `ZkRuleHashMismatch` anyway,
  // but the point is to surface the configuration bug.
  if (ruleCheck && !ruleCheck.ok) {
    return { action: ACTION.REFUSE, reason: ruleCheck.detail };
  }

  if (market.lifecycle === "open") {
    return canLock
      ? { action: ACTION.LOCK, reason: "deadline passed, market still Open" }
      : {
          action: ACTION.SKIP,
          reason:
            "market is Open past its deadline but the resolver key is not this entry's " +
            "authority — `request_lock` is signer-gated, so someone holding that key must lock it",
          blocked: true,
        };
  }

  return { action: ACTION.ATTEST, reason: "locked, un-attested, rule verified" };
}

export function outcomeName(outcome) {
  if (outcome === 1) return "YES";
  if (outcome === 0) return "NO";
  if (outcome === 2) return "INVALID";
  return String(outcome);
}
