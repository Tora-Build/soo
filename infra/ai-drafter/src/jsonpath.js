// The JSONPath subset a rule commitment is allowed to name, and the decimal
// arithmetic the chain applies to what it selects.
//
// This mirrors `infra/zk-resolver/src/feed.mjs` on purpose. A rule drafted here
// is later read back by the resolver and re-derived on chain; if the two
// disagreed about what `$.data.amount` means, a market would commit to one
// reading and settle on another. So the same subset, the same rejections.

/**
 * Evaluates `$.a.b`, `$.a[0].b`, `$['a']["b"]` against a parsed body.
 *
 * Wildcards, filters and recursive descent are rejected by name: they can
 * select more than one node, and a rule that resolves to several values is not
 * a rule. The commitment `sha256(len‖url‖len‖parsePath)` is permanent, so an
 * ambiguous path is an unfixable market.
 *
 * Throws with a message written to be fed back to the model verbatim.
 */
export function evaluateParsePath(body, parsePath) {
  if (typeof parsePath !== "string" || !parsePath.startsWith("$")) {
    throw new Error(`parsePath must be a string starting with "$": ${JSON.stringify(parsePath)}`);
  }
  if (/[*?]|\.\./.test(parsePath)) {
    throw new Error(
      `parsePath ${parsePath} uses wildcard, filter or recursive syntax, which can select ` +
        `more than one value — a market rule must name exactly one field`,
    );
  }

  const tokens = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g;
  let consumed = 1;
  let m;
  while ((m = re.exec(parsePath)) !== null) {
    if (m.index !== consumed) break;
    consumed = m.index + m[0].length;
    tokens.push(m[1] ?? m[3] ?? m[4] ?? Number(m[2]));
  }
  if (consumed !== parsePath.length) {
    throw new Error(`parsePath ${parsePath} is not a supported path expression`);
  }

  let node = body;
  const walked = [];
  for (const token of tokens) {
    walked.push(token);
    if (node == null || typeof node !== "object") {
      throw new Error(`parsePath ${parsePath} does not resolve: nothing at $.${walked.join(".")}`);
    }
    node = node[token];
  }
  return node;
}

/** True when `s` is a plain decimal literal — the only threshold form the chain parses. */
export function isDecimalString(s) {
  return typeof s === "string" && /^-?\d+(\.\d+)?$/.test(s.trim());
}

/** How many digits sit after the decimal point. Excess precision is a rejection, not a truncation. */
export function fractionDigits(decimal) {
  const frac = String(decimal).split(".")[1];
  return frac ? frac.length : 0;
}

/**
 * The chain's `parse_fixed_point` rule, applied here so a candidate that
 * validates is a candidate the program accepts.
 *
 * A value carrying more decimals than the market's scale is REJECTED on chain
 * rather than rounded, and attested precision varies between readings — so the
 * scale a candidate proposes must leave headroom above the reading it saw.
 */
export function fitsScale(decimal, scale) {
  return isDecimalString(String(decimal)) && fractionDigits(decimal) <= scale;
}
