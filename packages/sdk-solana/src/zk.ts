// Client-side helpers for zkTLS-adjudicated markets.
//
// Two jobs: compute the `rule_hash` a market commits to at registration, and
// reshape a Primus SDK `Attestation` into the arguments `attest_outcome_zk`
// takes. Both mirror logic in `programs/sooth-core/src/zk/`, and the program
// re-derives everything it verifies — nothing here is trusted on chain.

/** `ZkComparator` discriminants, as the program numbers them. */
export const ZK_COMPARATOR = {
  /** Not zk-enabled. Rejected by `register_zk_adjudicator`. */
  None: 0,
  Gt: 1,
  Gte: 2,
  Lt: 3,
  Lte: 4,
  Eq: 5,
} as const;

export type ZkComparatorName = Exclude<keyof typeof ZK_COMPARATOR, "None">;

/** Largest `valueScale` the program accepts. */
export const MAX_ZK_VALUE_SCALE = 18;

/**
 * The commitment stored on the `AdjudicatorEntry`, binding a market to one
 * endpoint and one field of its response.
 *
 * ```text
 * sha256( u32_le(url.length) ‖ url ‖ u32_le(parsePath.length) ‖ parsePath )
 * ```
 *
 * Length-prefixed rather than separated, so no pair of `(url, parsePath)`
 * values can be re-cut into a different pair with the same hash. Lengths are
 * UTF-8 BYTE lengths, not JS string lengths — the two differ for any
 * non-ASCII url, and the program hashes bytes.
 *
 * Must match `sooth_core::zk::compute_rule_hash` exactly; a mismatch makes
 * every attestation for the market fail with `ZkRuleHashMismatch`.
 */
export async function computeRuleHash(
  url: string,
  parsePath: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const urlBytes = enc.encode(url);
  const pathBytes = enc.encode(parsePath);

  const out = new Uint8Array(8 + urlBytes.length + pathBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, urlBytes.length, true);
  out.set(urlBytes, 4);
  view.setUint32(4 + urlBytes.length, pathBytes.length, true);
  out.set(pathBytes, 8 + urlBytes.length);

  const digest = await globalThis.crypto.subtle.digest("SHA-256", out);
  return new Uint8Array(digest);
}

/** A Primus `Attestation`, as the Primus SDK hands it back. */
export interface PrimusAttestation {
  recipient: string;
  request: { url: string; header: string; method: string; body: string };
  /** Primus' own spelling of the field. */
  reponseResolve: Array<{
    keyName: string;
    parseType: string;
    parsePath: string;
  }>;
  data: string;
  attConditions: string;
  /** Milliseconds, as Primus mints them. */
  timestamp: number | string | bigint;
  additionParams: string;
  attestors: Array<{ attestorAddr: string; url: string }>;
  signatures: string[];
}

/** The `ZkAttestation` argument shape, ready for `.attestOutcomeZk(...)`. */
export interface ZkAttestationArg {
  recipient: number[];
  request: { url: string; header: string; method: string; body: string };
  responseResolve: Array<{
    keyName: string;
    parseType: string;
    parsePath: string;
  }>;
  data: string;
  attConditions: string;
  timestamp: bigint;
  additionParams: string;
  attestorAddr: number[];
  attestorUrl: string;
  signature: number[];
}

/**
 * Reshapes a Primus attestation into the instruction argument.
 *
 * Structural only — it never re-signs or re-encodes. The program recomputes
 * the digest from these same fields and recovers the signer itself, so a
 * mistake here surfaces as a verification failure on chain rather than as a
 * forged outcome.
 *
 * Throws when the attestation is not the single-signature, single-resolve
 * shape the program accepts, so the failure names the problem instead of
 * arriving as an opaque `ZkResponseResolveCountInvalid` after a round trip.
 */
export function toZkAttestationArg(
  attestation: PrimusAttestation,
): ZkAttestationArg {
  if (attestation.signatures.length !== 1) {
    throw new Error(
      `toZkAttestationArg: expected exactly 1 signature, got ${attestation.signatures.length}`,
    );
  }
  if (attestation.reponseResolve.length !== 1) {
    throw new Error(
      `toZkAttestationArg: expected exactly 1 responseResolve entry, got ${attestation.reponseResolve.length}`,
    );
  }

  const signature = hexToBytes(attestation.signatures[0]!, 65);
  const v = signature[64]!;
  if (v !== 27 && v !== 28) {
    throw new Error(
      `toZkAttestationArg: signature v must be 27 or 28, got ${v}`,
    );
  }

  // The `Attestor[]` member sits outside the signed digest, so this address
  // is only an assertion the program cross-checks against the recovered
  // signer. An empty array is legal input; the zero address then fails on
  // chain rather than silently passing.
  const attestorAddr = attestation.attestors[0]?.attestorAddr;

  return {
    recipient: [...hexToBytes(attestation.recipient, 20)],
    request: { ...attestation.request },
    responseResolve: attestation.reponseResolve.map((r) => ({
      keyName: r.keyName,
      parseType: r.parseType,
      parsePath: r.parsePath,
    })),
    data: attestation.data,
    attConditions: attestation.attConditions,
    timestamp: BigInt(attestation.timestamp),
    additionParams: attestation.additionParams,
    attestorAddr: attestorAddr
      ? [...hexToBytes(attestorAddr, 20)]
      : new Array<number>(20).fill(0),
    attestorUrl: attestation.attestors[0]?.url ?? "",
    signature: [...signature],
  };
}

/** Parses `0x`-prefixed or bare hex into exactly `expectedLen` bytes. */
export function hexToBytes(hex: string, expectedLen: number): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length !== expectedLen * 2 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(
      `hexToBytes: expected ${expectedLen} bytes of hex, got "${hex}"`,
    );
  }
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
