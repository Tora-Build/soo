// The FIXTURE attestation source: a locally-signed attestation.
//
// Same construction `apps/demo/scripts/zk-attest-devnet.mjs` uses to prove the
// deployed program verifies attestations. It exists so the entire resolution
// loop — deadline check, rule-hash verification, submission, idempotency —
// can be exercised against real devnet without Primus credentials.
//
// What it does NOT do is weaken anything. The market must be registered to
// THIS key's EVM address for the program to accept its signature, so a fixture
// attestation resolves only markets deliberately created for a dry run. A real
// market registered to the Primus attestor rejects it with `ZkAttestorMismatch`
// exactly as it rejects any other unregistered signer.

import { encodeAttestation, evmAddress, hex, signDigest } from "../evm.mjs";
import { fetchFeedValue, fromFixedPoint, toFixedPoint } from "../feed.mjs";

/**
 * An attestation source backed by a local secp256k1 key.
 *
 * `privKey` is 32 bytes. The caller owns it; in the dry-run script it is
 * generated per run and thrown away, which is the point — the program accepts
 * a signature it can recover to the address the market registered, and no
 * particular key is special.
 */
export function fixtureSource({ privKey }) {
  return {
    name: "fixture",
    /** The address markets must be registered to for this source to resolve them. */
    attestorEvm: `0x${hex(evmAddress(privKey))}`,

    /**
     * Fetches the endpoint and signs what it read.
     *
     * The timestamp is `Date.now()` in milliseconds, the clock Primus mints
     * with; the program normalizes it to unix seconds and requires it to be at
     * or after the market's deadline. Since this runs after the deadline has
     * already passed, that holds by construction.
     */
    async attest({ entry, market }) {
      const { raw } = await fetchFeedValue(entry);
      const scaled = toFixedPoint(raw, market.entry.valueScale);
      const timestampMs = Date.now();

      const att = {
        // Not interpreted on chain, but inside the signed digest. Binding it
        // to the market makes the payload visibly specific to this market.
        recipient: `0x${hex(market.marketPk.toBytes().slice(0, 20))}`,
        request: {
          url: entry.url,
          header: entry.header,
          method: entry.method,
          body: entry.body,
        },
        reponseResolve: [
          {
            keyName: entry.keyName,
            parseType: entry.parseType,
            parsePath: entry.parsePath,
          },
        ],
        // The single-key object form `zk/value.rs` accepts, keyed by `keyName`.
        data: `{"${entry.keyName}":"${raw}"}`,
        attConditions: JSON.stringify([
          {
            op: ">",
            value: fromFixedPoint(market.entry.threshold, market.entry.valueScale),
          },
        ]),
        timestamp: BigInt(timestampMs),
        additionParams: "",
      };

      const signature = signDigest(privKey, encodeAttestation(att));
      return {
        attestation: {
          ...att,
          attestors: [
            {
              attestorAddr: `0x${hex(evmAddress(privKey))}`,
              url: "https://attestor.fixture.local",
            },
          ],
          signatures: [`0x${hex(signature)}`],
        },
        observed: { raw, scaled, at: timestampMs },
      };
    },
  };
}
