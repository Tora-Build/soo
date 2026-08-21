// Reading the data source.
//
// Note what this is NOT for: the program never evaluates a parsePath and never
// fetches anything. On chain, `parsePath` is only hashed into the rule
// commitment, and the value comes out of the attestation's signed `data`
// field. So everything here serves the resolver's own bookkeeping —
// pre-flighting that the endpoint is alive and the field is present, logging
// what the operator would expect, and supplying the value the FIXTURE source
// signs in dry-run mode.
//
// In `primus` mode the number that decides the market is the one PRIMUS
// observed inside the attested TLS session, not the one fetched here. The two
// are compared and a divergence is logged, but the attested value is the one
// that counts — it is the only one carrying a signature.

/**
 * Evaluates the JSONPath subset that makes sense as a rule commitment:
 * `$.a.b`, `$.a[0].b`, `$['a']['b']`.
 *
 * Deliberately not a full JSONPath engine. Wildcards, filters and recursive
 * descent can select more than one node, and a rule that can resolve to
 * several values is not a rule — it is an ambiguity the chain has no way to
 * arbitrate. Anything outside this subset is rejected by name.
 */
export function evaluateParsePath(body, parsePath) {
  if (!parsePath.startsWith("$")) {
    throw new Error(`parsePath must start with "$": ${parsePath}`);
  }
  if (/[*?]|\.\./.test(parsePath)) {
    throw new Error(
      `parsePath ${parsePath} uses wildcard or recursive syntax, which can select ` +
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
      throw new Error(
        `parsePath ${parsePath} does not resolve: nothing at $.${walked.join(".")}`,
      );
    }
    node = node[token];
  }
  return node;
}

/**
 * Fetches the endpoint and reads the committed field.
 *
 * The value is required to be a string or a number and is returned as its
 * decimal STRING form, because that is what an attestation's `data` carries
 * and what `parse_fixed_point` reads on chain. Going through JS numbers would
 * lose precision the chain would then reject.
 */
export async function fetchFeedValue(entry, { timeoutMs = 15_000 } = {}) {
  const headers = { accept: "application/json" };
  try {
    Object.assign(headers, JSON.parse(entry.header || "{}"));
  } catch {
    // `header` is a free-form string inside the signed digest; if it is not
    // JSON it is not usable as request headers, and the default stands.
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(entry.url, {
      method: entry.method,
      headers,
      body: entry.method === "GET" || entry.method === "HEAD" ? undefined : entry.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`${entry.url} returned HTTP ${res.status}`);
  }
  const body = await res.json();
  const raw = evaluateParsePath(body, entry.parsePath);
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error(
      `${entry.url} ${entry.parsePath} is ${JSON.stringify(raw)}, expected a string or number`,
    );
  }
  return { raw: String(raw), body };
}

/**
 * A decimal string to fixed point at `10^scale`, rejecting excess precision
 * rather than truncating.
 *
 * Same rule `parse_fixed_point` applies on chain, so a value accepted here is
 * a value the program accepts. Truncating instead would let the resolver
 * predict an outcome the chain then computes differently.
 */
export function toFixedPoint(decimal, scale) {
  const [intPart, fracPart = ""] = String(decimal).split(".");
  const negative = intPart.startsWith("-");
  const digits = negative ? intPart.slice(1) : intPart;
  if (!/^\d+$/.test(digits) || (fracPart && !/^\d+$/.test(fracPart))) {
    throw new Error(`not a decimal value: ${JSON.stringify(decimal)}`);
  }
  if (fracPart.length > scale) {
    throw new Error(
      `value ${decimal} carries ${fracPart.length} decimals, more than the market's scale ${scale}`,
    );
  }
  const magnitude = BigInt(digits + fracPart.padEnd(scale, "0"));
  return negative ? -magnitude : magnitude;
}

/** Renders a fixed-point value for logs. */
export function fromFixedPoint(value, scale) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${int}${frac}`;
}

/** The comparator discriminants, by name, mirroring `ZK_COMPARATOR`. */
export const COMPARATOR_NAMES = {
  0: "None",
  1: "Gt",
  2: "Gte",
  3: "Lt",
  4: "Lte",
  5: "Eq",
};

export const COMPARATOR_SYMBOLS = {
  1: ">",
  2: ">=",
  3: "<",
  4: "<=",
  5: "==",
};

/**
 * The outcome the on-chain comparator implies. Used ONLY to log what the
 * resolver expects and to sanity-check afterwards — the program recomputes it
 * from the signed value and its own stored rule, and that result is the one
 * that binds.
 */
export function predictOutcome(value, comparator, threshold) {
  switch (comparator) {
    case 1:
      return value > threshold ? 1 : 0;
    case 2:
      return value >= threshold ? 1 : 0;
    case 3:
      return value < threshold ? 1 : 0;
    case 4:
      return value <= threshold ? 1 : 0;
    case 5:
      return value === threshold ? 1 : 0;
    default:
      return null;
  }
}
