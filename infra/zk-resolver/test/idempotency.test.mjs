// The decision procedure, with `already attested -> skip` as the property
// that matters most: it is what stops the service from double-submitting
// across restarts, duplicate cron ticks, or two operators running it at once.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ACTION, decideAction, outcomeName } from "../src/resolve.mjs";
import { Journal } from "../src/state.mjs";

const DEADLINE = 1_700_000_000;

/** A market that is due and ready to attest, unless overridden. */
const state = ({ market = {}, entry = {} } = {}) => ({
  exists: true,
  market: { deadline: DEADLINE, lifecycle: "locked", question: "q", ...market },
  entry: {
    comparator: 1,
    valueScale: 6,
    threshold: 64_000_000_000n,
    attestedOutcome: null,
    attestedAt: null,
    disputed: false,
    ...entry,
  },
});

const ok = { ok: true, detail: null };
const now = DEADLINE + 60;

test("a locked, un-attested, due market with a verified rule is attested", () => {
  const d = decideAction({ chainState: state(), ruleCheck: ok, now, canLock: false });
  assert.equal(d.action, ACTION.ATTEST);
});

// ── Idempotency ───────────────────────────────────────────────────────────

test("an already-attested market is skipped, never re-submitted", () => {
  for (const outcome of [0, 1, 2]) {
    const d = decideAction({
      chainState: state({ entry: { attestedOutcome: outcome, attestedAt: now } }),
      ruleCheck: ok,
      now,
      canLock: true,
    });
    assert.equal(d.action, ACTION.SKIP, `outcome ${outcome} must not re-attest`);
    assert.equal(d.alreadyAttested, true);
    assert.match(d.reason, new RegExp(outcomeName(outcome)));
  }
});

// Outcome 0 is NO, which is falsy. A truthiness check here would re-submit
// every market that resolved NO — the exact bug this asserts against.
test("outcome 0 (NO) counts as attested, despite being falsy", () => {
  const d = decideAction({
    chainState: state({ entry: { attestedOutcome: 0, attestedAt: now } }),
    ruleCheck: ok,
    now,
    canLock: true,
  });
  assert.equal(d.action, ACTION.SKIP);
  assert.equal(d.alreadyAttested, true);
});

// The already-attested check must come BEFORE the rule check, so a resolved
// market with a since-edited registry entry is skipped quietly rather than
// refused as a configuration error. It is finished either way.
test("an attested market is skipped even when the registry rule no longer matches", () => {
  const d = decideAction({
    chainState: state({ entry: { attestedOutcome: 1, attestedAt: now } }),
    ruleCheck: { ok: false, detail: "mismatch" },
    now,
    canLock: true,
  });
  assert.equal(d.action, ACTION.SKIP);
  assert.equal(d.alreadyAttested, true);
});

// ── The other guards ──────────────────────────────────────────────────────

test("a market before its deadline is skipped and reports the wait", () => {
  const d = decideAction({ chainState: state(), ruleCheck: ok, now: DEADLINE - 30, canLock: true });
  assert.equal(d.action, ACTION.SKIP);
  assert.equal(d.dueIn, 30);
});

test("a timestamp exactly at the deadline is due", () => {
  const d = decideAction({ chainState: state(), ruleCheck: ok, now: DEADLINE, canLock: false });
  assert.equal(d.action, ACTION.ATTEST);
});

// A zeroed reserved region reads as comparator None, which is every entry the
// manual register_adjudicator path writes. Those must stay out of this loop.
test("a non-zk adjudicator entry is skipped", () => {
  const d = decideAction({ chainState: state({ entry: { comparator: 0 } }), ruleCheck: ok, now, canLock: true });
  assert.equal(d.action, ACTION.SKIP);
  assert.match(d.reason, /not zk-enabled/);
});

test("a disputed entry is skipped — the guardian veto decides it", () => {
  const d = decideAction({ chainState: state({ entry: { disputed: true } }), ruleCheck: ok, now, canLock: true });
  assert.equal(d.action, ACTION.SKIP);
  assert.match(d.reason, /disputed/);
});

test("a rule-hash mismatch is REFUSED, not silently skipped", () => {
  const d = decideAction({
    chainState: state(),
    ruleCheck: { ok: false, detail: "registry describes a different endpoint" },
    now,
    canLock: true,
  });
  assert.equal(d.action, ACTION.REFUSE);
  assert.match(d.reason, /different endpoint/);
});

test("a missing market or adjudicator entry is skipped with the chain's reason", () => {
  const d = decideAction({
    chainState: { exists: false, reason: "no AdjudicatorEntry" },
    ruleCheck: null,
    now,
    canLock: true,
  });
  assert.equal(d.action, ACTION.SKIP);
  assert.match(d.reason, /no AdjudicatorEntry/);
});

// `request_lock` is signer-gated on the entry's authority, unlike attestation.
test("an Open market past its deadline locks only when the resolver holds the authority", () => {
  const open = state({ market: { lifecycle: "open" } });
  assert.equal(decideAction({ chainState: open, ruleCheck: ok, now, canLock: true }).action, ACTION.LOCK);

  const cannot = decideAction({ chainState: open, ruleCheck: ok, now, canLock: false });
  assert.equal(cannot.action, ACTION.SKIP);
  assert.equal(cannot.blocked, true);
  assert.match(cannot.reason, /signer-gated/);
});

test("settled and initializing markets are skipped", () => {
  for (const lifecycle of ["settled", "initializing"]) {
    const d = decideAction({ chainState: state({ market: { lifecycle } }), ruleCheck: ok, now, canLock: true });
    assert.equal(d.action, ACTION.SKIP, lifecycle);
  }
});

// ── The journal ───────────────────────────────────────────────────────────

test("the journal survives a restart and backs off after failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "zk-resolver-"));
  const path = join(dir, "resolver.json");
  try {
    const j = new Journal(path);
    const t = 1_000_000;

    assert.equal(j.inBackoff("m", t), false);
    j.recordFailure("m", { error: "boom", at: t });
    assert.equal(j.inBackoff("m", t + 30), true, "60s backoff after one failure");
    assert.equal(j.inBackoff("m", t + 61), false);

    // A fresh instance reads the same file — this is the restart case.
    const reopened = new Journal(path);
    assert.equal(reopened.get("m").failures, 1);
    assert.equal(reopened.inBackoff("m", t + 30), true);

    reopened.recordSuccess("m", { signature: "sig", outcome: 1, value: "5", at: t + 100 });
    assert.equal(new Journal(path).get("m").resolvedSignature, "sig");
    // A resolved market never backs off; the chain now skips it outright.
    assert.equal(new Journal(path).inBackoff("m", t + 101), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The chain is the authority on idempotency, so a lost or corrupt journal must
// never stop the service from working correctly.
test("a corrupt journal is discarded rather than fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "zk-resolver-"));
  const path = join(dir, "resolver.json");
  try {
    writeFileSync(path, "{not json");
    const j = new Journal(path);
    assert.equal(j.get("m"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
