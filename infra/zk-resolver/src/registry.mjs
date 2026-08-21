// The market registry: which markets this resolver watches, and the rule
// material the chain cannot give it back.
//
// # Why a local file is necessary, and why it is not a trust hole
//
// The on-chain `AdjudicatorEntry` stores the attestor address, comparator,
// threshold, value scale — and `rule_hash`, which is a COMMITMENT to the url
// and parsePath, not the values themselves:
//
//     rule_hash = sha256( u32_le(len(url)) ‖ url ‖ u32_le(len(parsePath)) ‖ parsePath )
//
// A hash cannot be inverted, so the resolver cannot learn the endpoint from
// the chain; it has to be told. That is all this file supplies. Everything
// else — attestor, comparator, threshold, scale — is read from the chain and
// never taken from here, so a wrong entry in this file cannot change what a
// market resolves to.
//
// The preimage is checked against the on-chain commitment before any
// attestation is requested (`verifyRule`). A mismatch is refused loudly rather
// than attempted: submitting it would burn a fee and come back
// `ZkRuleHashMismatch`, and — more to the point — it means the operator's
// belief about what this market asks has diverged from what the market
// committed to. That is a configuration bug worth stopping on.

import { existsSync, readFileSync } from "node:fs";

/** A registry entry, after validation. */
const REQUIRED_FIELDS = ["market", "url", "parsePath", "keyName"];

/**
 * Loads and validates the registry file.
 *
 * Accepts either a bare array of entries or `{ markets: [...] }`, because both
 * shapes are the obvious thing to write and neither is ambiguous.
 */
export function loadRegistry(path) {
  if (!existsSync(path)) {
    throw new Error(`registry not found at ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`registry ${path} is not valid JSON: ${err.message}`);
  }
  const raw = Array.isArray(parsed) ? parsed : parsed?.markets;
  if (!Array.isArray(raw)) {
    throw new Error(
      `registry ${path} must be an array of entries, or an object with a "markets" array`,
    );
  }
  return raw.map((entry, i) => validateEntry(entry, i, path));
}

export function validateEntry(entry, index, path = "<registry>") {
  const where = `${path}[${index}]`;
  if (!entry || typeof entry !== "object") {
    throw new Error(`${where} is not an object`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`${where} is missing a non-empty "${field}"`);
    }
  }
  try {
    new URL(entry.url);
  } catch {
    throw new Error(`${where}.url is not a valid URL: ${entry.url}`);
  }

  return {
    market: entry.market.trim(),
    url: entry.url.trim(),
    parsePath: entry.parsePath.trim(),
    keyName: entry.keyName.trim(),
    // These describe the REQUEST handed to Primus, not the attestation. Primus
    // rewrites both on the way back: a real attestation carries `header: ""`
    // and `parseType: ""` regardless of what was asked for (`assemblyParams`
    // drops the header into its own transport map, and the resolve entry comes
    // back with only `keyName` and `parsePath` populated). The resolver submits
    // the ATTESTATION's fields, never these, so a wrong value here cannot break
    // the digest — it only changes what Primus was asked to fetch.
    parseType: entry.parseType?.trim() || "string",
    method: (entry.method?.trim() || "GET").toUpperCase(),
    header: entry.header ?? '{"accept":"application/json"}',
    body: entry.body ?? "",
    /** Skipped without being deleted. Useful for parking a market. */
    enabled: entry.enabled !== false,
    /** Free-text, for humans reading logs. Never interpreted. */
    label: entry.label?.trim() || entry.market.trim().slice(0, 8),
    note: entry.note ?? null,
  };
}

/**
 * Checks a registry entry's `(url, parsePath)` against the market's on-chain
 * `rule_hash`.
 *
 * This is the one place local configuration is reconciled with the chain's
 * commitment, and it gates everything downstream: no attestation is requested
 * and no transaction is built for a market that fails it.
 *
 * `computeRuleHash` is the SDK's, which is the same derivation
 * `sooth_core::zk::compute_rule_hash` performs on chain — so agreement here
 * means agreement there.
 */
export async function verifyRule(entry, onChainRuleHash, computeRuleHash) {
  const expected = await computeRuleHash(entry.url, entry.parsePath);
  const actual = Uint8Array.from(onChainRuleHash);
  const ok =
    expected.length === actual.length &&
    expected.every((b, i) => b === actual[i]);
  return {
    ok,
    expected,
    actual,
    detail: ok
      ? null
      : `registry (url, parsePath) hashes to 0x${Buffer.from(expected).toString("hex")} ` +
        `but the market committed to 0x${Buffer.from(actual).toString("hex")} — ` +
        `the registry entry describes a different endpoint or field than this market asks about`,
  };
}
