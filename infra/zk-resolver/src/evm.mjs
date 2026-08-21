// The EVM-side crypto a Primus attestation is built out of.
//
// Mirrors `programs/sooth-core/src/zk/primus.rs` byte for byte. Two callers
// need it and they need it for opposite reasons:
//
//   - the FIXTURE attestation source signs with it, standing in for Primus;
//   - `verifyLocally` checks a REAL Primus attestation with it before the
//     resolver spends a transaction fee on something the program will reject.
//
// The program re-derives all of this on chain from the structured fields it is
// handed, so nothing here is trusted: a mistake in this file surfaces as a
// rejected transaction, never as a forged outcome. `selfTestEncoding` pins it
// against the same reference vector `zk/primus.rs` uses, so drift is caught at
// startup rather than as an unexplained on-chain rejection.

import { loadCrypto } from "./deps.mjs";

const { secp256k1, keccak_256 } = await loadCrypto();

const enc = new TextEncoder();

/** Lowercase hex, no `0x`. */
export const hex = (bytes) => Buffer.from(bytes).toString("hex");

export function hexToBytesN(s, expectedLen) {
  const body = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (body.length !== expectedLen * 2 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(`expected ${expectedLen} bytes of hex, got "${s}"`);
  }
  return Uint8Array.from(Buffer.from(body, "hex"));
}

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u64be(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

/** The low 20 bytes of `keccak256(uncompressed pubkey without its 0x04 tag)`. */
export function evmAddress(privKey) {
  const pub = secp256k1.getPublicKey(privKey, false).slice(1);
  return keccak_256(pub).slice(12);
}

/**
 * `PrimusZKTLS.encodeAttestation` — the 32 bytes an attestor signs.
 *
 * `abi.encodePacked`: no length prefixes, no padding, no offsets. The
 * `Attestor[]` and `signatures[]` members sit OUTSIDE the digest, which is
 * exactly why the program cross-checks the declared attestor address against
 * the one it recovers. The timestamp is a big-endian `uint64`.
 *
 * Counterpart: `ZkAttestation::encode` in `zk/primus.rs`.
 */
export function encodeAttestation(att) {
  const requestHash = keccak_256(
    concatBytes(
      enc.encode(att.request.url),
      enc.encode(att.request.header),
      enc.encode(att.request.method),
      enc.encode(att.request.body),
    ),
  );
  const responseHash = keccak_256(
    concatBytes(
      ...att.reponseResolve.flatMap((r) => [
        enc.encode(r.keyName),
        enc.encode(r.parseType),
        enc.encode(r.parsePath),
      ]),
    ),
  );
  return keccak_256(
    concatBytes(
      hexToBytesN(att.recipient, 20),
      requestHash,
      responseHash,
      enc.encode(att.data),
      enc.encode(att.attConditions),
      u64be(att.timestamp),
      enc.encode(att.additionParams),
    ),
  );
}

/**
 * Signs a digest RAW — no EIP-191 prefix — in EVM wire layout `r ‖ s ‖ v`
 * with `v = recovery_id + 27`, which is what `recover_evm_signer` in
 * `zk/primus.rs` expects and what Primus' own `verifyAttestation` recovers.
 *
 * noble normalizes `s` into the low half of the curve order, so the program's
 * explicit malleability check never fires on anything produced here.
 */
export function signDigest(privKey, digest) {
  const sig = secp256k1.sign(digest, privKey, { prehash: false });
  const out = new Uint8Array(65);
  out.set(sig.toBytes ? sig.toBytes("compact") : sig.toCompactRawBytes(), 0);
  out[64] = sig.recovery + 27;
  return out;
}

/**
 * Recovers the signer of an attestation, as the program will.
 *
 * Used to check a real Primus attestation locally before submitting it. The
 * answer is the ground truth for "which attestor address must this market be
 * registered to" — see the PADO address note in `sources/primus.mjs`.
 */
export function recoverAttestor(att) {
  const signature = hexToBytesN(att.signatures[0], 65);
  const v = signature[64];
  if (v !== 27 && v !== 28) throw new Error(`signature v must be 27 or 28, got ${v}`);
  const sig = secp256k1.Signature.fromBytes
    ? secp256k1.Signature.fromBytes(signature.slice(0, 64), "compact").addRecoveryBit(v - 27)
    : secp256k1.Signature.fromCompact(signature.slice(0, 64)).addRecoveryBit(v - 27);
  const point = sig.recoverPublicKey(encodeAttestation(att));
  const pub = (point.toBytes ? point.toBytes(false) : point.toRawBytes(false)).slice(1);
  return keccak_256(pub).slice(12);
}

/**
 * Pins this encoder against the reference vector in `zk/primus.rs`'s
 * `test_support::golden_attestation`, itself produced by Primus' own
 * `encodeAttestation` under ethers.
 *
 * Runs before the resolver touches the network. If the encoder had drifted
 * from the program's, every attestation would be rejected on chain for a
 * reason that looks like a key or config problem; failing here instead names
 * the real cause.
 */
export function selfTestEncoding() {
  const key = new Uint8Array(32).fill(0x11);
  const addr = hex(evmAddress(key));
  if (addr !== "19e7e376e7c213b7e7e7e46cc70a5dd086daff2a") {
    throw new Error(`EVM address derivation drifted: got 0x${addr}`);
  }
  const golden = {
    recipient: "0x00000000000000000000000000000000000000aa",
    request: {
      url: "https://api.example.com/v1/price?symbol=BTCUSDT",
      header: '{"accept":"application/json"}',
      method: "GET",
      body: "",
    },
    reponseResolve: [
      { keyName: "price", parseType: "string", parsePath: "$.data.price" },
    ],
    data: '{"price":"64000.5"}',
    attConditions: '[{"op":">","value":"0"}]',
    timestamp: 1_755_000_000_000n,
    additionParams: "",
  };
  const digest = hex(encodeAttestation(golden));
  if (digest !== "c68a3dba3e6ea0454ad3cc9e08d70d47a1ad2054a0f0799416f832a320ce439a") {
    throw new Error(`encodeAttestation drifted from the Primus reference vector: ${digest}`);
  }
  const sig = hex(signDigest(key, encodeAttestation(golden)));
  const expected =
    "d14f64647879cfe5fbc39bda3efc561b85ed3a55b21dda7266531127715bd18b" +
    "4edc850c5c54247cd167b19ba58a0c6ec1e0a9ad8e0d7a2500fde6646fd80661" +
    "1c";
  if (sig !== expected) {
    throw new Error(`signature layout drifted from the reference vector: ${sig}`);
  }
  return { digest, addr };
}
