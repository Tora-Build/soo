//! Primus zkTLS attestation encoding and attestor recovery.
//!
//! # The digest is reproduced, never accepted
//!
//! Everything here operates on the attestation's STRUCTURED fields. The
//! program never accepts a caller-supplied digest or pre-encoded byte blob:
//! doing so would let a caller obtain a signature over one payload and then
//! present a different `data` / `url` alongside it. Re-encoding on-chain is
//! what binds the signature to the values the handler then acts on.
//!
//! # Encoding
//!
//! Byte-for-byte reproduction of `PrimusZKTLS.encodeAttestation`
//! (`primus-labs/zktls-contracts`, `src/PrimusZKTLS.sol`), cross-checked
//! against the TypeScript `encodeAttestation` in `@primuslabs/zktls-core-sdk`
//! (`src/utils.ts`), which the Primus SDK itself uses to verify. Both are
//! `abi.encodePacked` — no length prefixes, no 32-byte padding, no offsets:
//!
//! ```text
//! request_hash  = keccak256(url ‖ header ‖ method ‖ body)
//! response_hash = keccak256( for each resolve: key_name ‖ parse_type ‖ parse_path )
//! digest        = keccak256(
//!                     recipient          (20 raw bytes)
//!                   ‖ request_hash       (32 bytes)
//!                   ‖ response_hash      (32 bytes)
//!                   ‖ data               (raw UTF-8)
//!                   ‖ att_conditions     (raw UTF-8)
//!                   ‖ timestamp          (uint64, 8 bytes BIG-endian)
//!                   ‖ addition_params    (raw UTF-8)
//!                 )
//! ```
//!
//! Two consequences of `abi.encodePacked` that the field caps below rely on:
//! the `Attestor[]` and `signatures[]` members of the Solidity struct are NOT
//! part of the digest, and adjacent dynamic strings are concatenated with no
//! separator (Primus' own ambiguity, faithfully reproduced — `rule_hash`
//! is what actually pins the endpoint).
//!
//! # Signature
//!
//! The digest is signed RAW — there is no EIP-191 `\x19Ethereum Signed
//! Message:` prefix. `PrimusZKTLS.verifyAttestation` calls
//! `ecrecover(encodeAttestation(att), v, r, s)` directly, and the SDK calls
//! `ethers.utils.recoverAddress(encodeData, signature)`. Prefixing here would
//! reject every genuine attestation.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::secp256k1_recover::secp256k1_recover;

use crate::error::SoothCoreError;

/// Per-field byte ceilings. These bound heap and hashing work for an
/// instruction whose entire input is caller-controlled, and they are checked
/// before any hashing happens.
pub const MAX_ZK_URL_LEN: usize = 512;
pub const MAX_ZK_HEADER_LEN: usize = 1024;
pub const MAX_ZK_METHOD_LEN: usize = 16;
pub const MAX_ZK_BODY_LEN: usize = 1024;
pub const MAX_ZK_DATA_LEN: usize = 512;
pub const MAX_ZK_ATT_CONDITIONS_LEN: usize = 1024;
pub const MAX_ZK_ADDITION_PARAMS_LEN: usize = 512;
pub const MAX_ZK_KEY_NAME_LEN: usize = 128;
pub const MAX_ZK_PARSE_TYPE_LEN: usize = 32;
pub const MAX_ZK_PARSE_PATH_LEN: usize = 256;
pub const MAX_ZK_ATTESTOR_URL_LEN: usize = 256;

/// An EVM account address: the low 20 bytes of `keccak256(pubkey)`.
pub type EvmAddress = [u8; 20];

/// `AttNetworkRequest` from `IPrimusZKTLS.sol`. Field order is load-bearing —
/// it is the packed-encoding order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ZkNetworkRequest {
    pub url: String,
    pub header: String,
    pub method: String,
    pub body: String,
}

/// `AttNetworkResponseResolve` from `IPrimusZKTLS.sol`. Field order is the
/// packed-encoding order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ZkResponseResolve {
    pub key_name: String,
    pub parse_type: String,
    pub parse_path: String,
}

/// A Primus `Attestation`, carried as structured fields.
///
/// `attestor_addr` and `attestor_url` mirror the Solidity `Attestor[]` entry,
/// but note that array is OUTSIDE the signed digest. `attestor_addr` is
/// therefore treated as an assertion the handler checks against the recovered
/// signer, never as a trust input; `attestor_url` is carried for fidelity and
/// is not interpreted at all.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ZkAttestation {
    pub recipient: EvmAddress,
    pub request: ZkNetworkRequest,
    pub response_resolve: Vec<ZkResponseResolve>,
    pub data: String,
    pub att_conditions: String,
    /// Solidity `uint64`, encoded big-endian by `abi.encodePacked`.
    pub timestamp: u64,
    pub addition_params: String,
    pub attestor_addr: EvmAddress,
    pub attestor_url: String,
    /// `r ‖ s ‖ v`, with EVM's `v ∈ {27, 28}`.
    pub signature: [u8; 65],
}

/// Hand-written because `[u8; 65]` has no `Default` — arrays only derive it
/// up to 32 elements.
impl Default for ZkAttestation {
    fn default() -> Self {
        Self {
            recipient: [0u8; 20],
            request: ZkNetworkRequest::default(),
            response_resolve: Vec::new(),
            data: String::new(),
            att_conditions: String::new(),
            timestamp: 0,
            addition_params: String::new(),
            attestor_addr: [0u8; 20],
            attestor_url: String::new(),
            signature: [0u8; 65],
        }
    }
}

impl ZkAttestation {
    /// Rejects oversized fields before anything is hashed, so a malformed
    /// payload cannot buy unbounded work.
    pub fn check_field_sizes(&self) -> Result<()> {
        let ok = self.request.url.len() <= MAX_ZK_URL_LEN
            && self.request.header.len() <= MAX_ZK_HEADER_LEN
            && self.request.method.len() <= MAX_ZK_METHOD_LEN
            && self.request.body.len() <= MAX_ZK_BODY_LEN
            && self.data.len() <= MAX_ZK_DATA_LEN
            && self.att_conditions.len() <= MAX_ZK_ATT_CONDITIONS_LEN
            && self.addition_params.len() <= MAX_ZK_ADDITION_PARAMS_LEN
            && self.attestor_url.len() <= MAX_ZK_ATTESTOR_URL_LEN
            && self.response_resolve.iter().all(|r| {
                r.key_name.len() <= MAX_ZK_KEY_NAME_LEN
                    && r.parse_type.len() <= MAX_ZK_PARSE_TYPE_LEN
                    && r.parse_path.len() <= MAX_ZK_PARSE_PATH_LEN
            });
        require!(ok, SoothCoreError::ZkAttestationFieldTooLong);
        Ok(())
    }

    /// `keccak256(url ‖ header ‖ method ‖ body)` — `PrimusZKTLS.encodeRequest`.
    pub fn encode_request(&self) -> [u8; 32] {
        let mut h = keccak::Hasher::default();
        h.hash(self.request.url.as_bytes());
        h.hash(self.request.header.as_bytes());
        h.hash(self.request.method.as_bytes());
        h.hash(self.request.body.as_bytes());
        h.result().to_bytes()
    }

    /// `PrimusZKTLS.encodeResponse`. The Solidity accumulator starts as an
    /// empty `bytes` and each iteration re-packs it with the next three
    /// strings, which flattens to one concatenation — an empty array hashes
    /// the empty string.
    pub fn encode_response(&self) -> [u8; 32] {
        let mut h = keccak::Hasher::default();
        for r in &self.response_resolve {
            h.hash(r.key_name.as_bytes());
            h.hash(r.parse_type.as_bytes());
            h.hash(r.parse_path.as_bytes());
        }
        h.result().to_bytes()
    }

    /// `PrimusZKTLS.encodeAttestation` — the 32 bytes the attestor signs.
    pub fn encode(&self) -> [u8; 32] {
        let request_hash = self.encode_request();
        let response_hash = self.encode_response();
        let mut h = keccak::Hasher::default();
        h.hash(&self.recipient);
        h.hash(&request_hash);
        h.hash(&response_hash);
        h.hash(self.data.as_bytes());
        h.hash(self.att_conditions.as_bytes());
        h.hash(&self.timestamp.to_be_bytes());
        h.hash(self.addition_params.as_bytes());
        h.result().to_bytes()
    }

    /// Re-encodes, recovers, and returns the signer's EVM address.
    pub fn recover_attestor(&self) -> Result<EvmAddress> {
        recover_evm_signer(&self.encode(), &self.signature)
    }
}

/// `secp256k1n / 2`. Signatures above this are the malleable twin of a valid
/// one: negating `s` yields a second signature over the same digest under the
/// same key. The BPF `sol_secp256k1_recover` syscall rejects them but the
/// host-side `libsecp256k1` fallback does not, so this check is explicit —
/// unit tests and the deployed program then agree byte for byte.
const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// Recovers the 20-byte EVM address that produced `signature` over `digest`.
///
/// `signature` is EVM layout `r ‖ s ‖ v`. The syscall wants a recovery id of
/// 0 or 1 while EVM carries `v = recovery_id + 27`, so the two encodings are
/// converted here rather than at any call site.
pub fn recover_evm_signer(digest: &[u8; 32], signature: &[u8; 65]) -> Result<EvmAddress> {
    let v = signature[64];
    require!(v == 27 || v == 28, SoothCoreError::ZkInvalidSignatureV);
    let recovery_id = v - 27;

    let mut s = [0u8; 32];
    s.copy_from_slice(&signature[32..64]);
    require!(
        s <= SECP256K1_HALF_ORDER,
        SoothCoreError::ZkMalleableSignature
    );

    let pubkey = secp256k1_recover(digest, recovery_id, &signature[..64])
        .map_err(|_| error!(SoothCoreError::ZkSignatureRecoveryFailed))?;

    Ok(evm_address_from_pubkey(&pubkey.to_bytes()))
}

/// The low 20 bytes of `keccak256` over the 64-byte uncompressed public key,
/// with the `0x04` SEC1 tag already stripped — which is how Ethereum derives
/// an account address, and what `secp256k1_recover` hands back.
pub fn evm_address_from_pubkey(pubkey: &[u8; 64]) -> EvmAddress {
    let digest = keccak::hash(pubkey).to_bytes();
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&digest[12..32]);
    addr
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Signing helpers shared by the encoding tests and the handler-level
    //! tests. Keys are generated locally — nothing here touches the Primus
    //! network.

    use super::*;

    /// The EVM address for a 32-byte secp256k1 secret key.
    pub fn address_for(secret: &[u8; 32]) -> EvmAddress {
        let sk = libsecp256k1::SecretKey::parse(secret).expect("valid secret key");
        let pk = libsecp256k1::PublicKey::from_secret_key(&sk);
        // `serialize()` is SEC1 uncompressed: a 0x04 tag then X ‖ Y.
        let mut uncompressed = [0u8; 64];
        uncompressed.copy_from_slice(&pk.serialize()[1..65]);
        evm_address_from_pubkey(&uncompressed)
    }

    /// Signs `digest` in EVM wire layout `r ‖ s ‖ v` with `v = rec_id + 27`.
    pub fn sign_digest(secret: &[u8; 32], digest: &[u8; 32]) -> [u8; 65] {
        let sk = libsecp256k1::SecretKey::parse(secret).expect("valid secret key");
        let msg = libsecp256k1::Message::parse(digest);
        let (sig, rec) = libsecp256k1::sign(&msg, &sk);
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&sig.serialize());
        out[64] = rec.serialize() + 27;
        out
    }

    /// Signs an attestation in place and records the signer in the
    /// `attestor_addr` field the handler cross-checks.
    pub fn sign_attestation(att: &mut ZkAttestation, secret: &[u8; 32]) {
        att.signature = sign_digest(secret, &att.encode());
        att.attestor_addr = address_for(secret);
    }

    /// The attestation behind the ethers-generated golden vector in
    /// `tests::encoding_matches_the_primus_reference_vector`.
    pub fn golden_attestation() -> ZkAttestation {
        ZkAttestation {
            recipient: hex20("00000000000000000000000000000000000000aa"),
            request: ZkNetworkRequest {
                url: "https://api.example.com/v1/price?symbol=BTCUSDT".into(),
                header: r#"{"accept":"application/json"}"#.into(),
                method: "GET".into(),
                body: String::new(),
            },
            response_resolve: vec![ZkResponseResolve {
                key_name: "price".into(),
                parse_type: "string".into(),
                parse_path: "$.data.price".into(),
            }],
            data: r#"{"price":"64000.5"}"#.into(),
            att_conditions: r#"[{"op":">","value":"0"}]"#.into(),
            timestamp: 1_755_000_000_000,
            addition_params: String::new(),
            attestor_addr: hex20("19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"),
            attestor_url: String::new(),
            signature: hex65(
                "d14f64647879cfe5fbc39bda3efc561b85ed3a55b21dda7266531127715bd18b\
                 4edc850c5c54247cd167b19ba58a0c6ec1e0a9ad8e0d7a2500fde6646fd80661\
                 1c",
            ),
        }
    }

    fn decode_hex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }

    pub fn hex20(s: &str) -> EvmAddress {
        let mut out = [0u8; 20];
        out.copy_from_slice(&decode_hex(s));
        out
    }

    pub fn hex32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&decode_hex(s));
        out
    }

    pub fn hex65(s: &str) -> [u8; 65] {
        let mut out = [0u8; 65];
        out.copy_from_slice(&decode_hex(s));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    const ATTESTOR_KEY: [u8; 32] = [0x11; 32];
    const IMPOSTOR_KEY: [u8; 32] = [0x22; 32];

    /// The one test that decides whether any of this works.
    ///
    /// Expected values come from running Primus' own `encodeAttestation` /
    /// `encodeRequest` / `encodeResponse` (`@primuslabs/zktls-core-sdk`,
    /// `src/utils.ts`) under ethers v5, over the fixture in
    /// `test_support::golden_attestation`. That TypeScript is in turn the
    /// mirror of `PrimusZKTLS.sol`'s Solidity, which is what an EVM verifier
    /// runs. If this ever fails, the on-chain encoding has drifted from the
    /// bytes attestors actually sign and NOTHING will verify.
    #[test]
    fn encoding_matches_the_primus_reference_vector() {
        let att = golden_attestation();
        assert_eq!(
            att.encode_request(),
            hex32("6c44191f364426300b7f6280cb65e2876effa0ebe4c34dc6f7da18cd589053b7"),
            "encodeRequest drifted"
        );
        assert_eq!(
            att.encode_response(),
            hex32("a4a1c887f1ff38b59273eafc9fc5d71fad49af857712877954a155f54247a3e4"),
            "encodeResponse drifted"
        );
        assert_eq!(
            att.encode(),
            hex32("c68a3dba3e6ea0454ad3cc9e08d70d47a1ad2054a0f0799416f832a320ce439a"),
            "encodeAttestation drifted"
        );
    }

    /// The golden signature was produced by `ethers.utils.SigningKey.signDigest`
    /// over the digest with NO EIP-191 prefix, exactly as
    /// `PrimusZKTLS.verifyAttestation` recovers it.
    #[test]
    fn the_reference_signature_recovers_the_reference_attestor() {
        let att = golden_attestation();
        assert_eq!(
            att.recover_attestor().unwrap(),
            hex20("19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A")
        );
    }

    /// Cross-check on the address derivation: ethers derived
    /// `0x19E7…ff2A` from private key `0x1111…11`, and so must this.
    #[test]
    fn evm_address_derivation_matches_ethers() {
        assert_eq!(
            address_for(&ATTESTOR_KEY),
            hex20("19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A")
        );
    }

    #[test]
    fn a_locally_signed_attestation_recovers_its_own_signer() {
        let mut att = golden_attestation();
        att.data = r#"{"price":"1"}"#.into();
        sign_attestation(&mut att, &ATTESTOR_KEY);
        assert_eq!(att.recover_attestor().unwrap(), address_for(&ATTESTOR_KEY));
    }

    #[test]
    fn a_different_key_recovers_to_a_different_address() {
        let mut att = golden_attestation();
        sign_attestation(&mut att, &IMPOSTOR_KEY);
        let recovered = att.recover_attestor().unwrap();
        assert_eq!(recovered, address_for(&IMPOSTOR_KEY));
        assert_ne!(recovered, address_for(&ATTESTOR_KEY));
    }

    /// Every field is inside the digest, so touching any one of them must
    /// break recovery. This is what stops a caller from taking a genuine
    /// signature and presenting it beside different values.
    #[test]
    fn mutating_any_signed_field_breaks_recovery() {
        let mut base = golden_attestation();
        sign_attestation(&mut base, &ATTESTOR_KEY);
        let signer = address_for(&ATTESTOR_KEY);

        // Named because the tuple is otherwise a `type_complexity` violation:
        // each entry is a label plus the single-field mutation it applies.
        type Mutation = (&'static str, Box<dyn Fn(&mut ZkAttestation)>);
        let mutations: Vec<Mutation> = vec![
            (
                "recipient",
                Box::new(|a: &mut ZkAttestation| a.recipient[0] ^= 1),
            ),
            (
                "url",
                Box::new(|a: &mut ZkAttestation| a.request.url.push('x')),
            ),
            (
                "header",
                Box::new(|a: &mut ZkAttestation| a.request.header.push('x')),
            ),
            (
                "method",
                Box::new(|a: &mut ZkAttestation| a.request.method = "POST".into()),
            ),
            (
                "body",
                Box::new(|a: &mut ZkAttestation| a.request.body.push('x')),
            ),
            (
                "key_name",
                Box::new(|a: &mut ZkAttestation| a.response_resolve[0].key_name.push('x')),
            ),
            (
                "parse_type",
                Box::new(|a: &mut ZkAttestation| a.response_resolve[0].parse_type.push('x')),
            ),
            (
                "parse_path",
                Box::new(|a: &mut ZkAttestation| a.response_resolve[0].parse_path.push('x')),
            ),
            (
                "data",
                Box::new(|a: &mut ZkAttestation| a.data = r#"{"price":"1"}"#.into()),
            ),
            (
                "att_conditions",
                Box::new(|a: &mut ZkAttestation| a.att_conditions.push('x')),
            ),
            (
                "timestamp",
                Box::new(|a: &mut ZkAttestation| a.timestamp += 1),
            ),
            (
                "addition_params",
                Box::new(|a: &mut ZkAttestation| a.addition_params.push('x')),
            ),
        ];

        for (name, mutate) in mutations {
            let mut att = base.clone();
            mutate(&mut att);
            let recovered = att.recover_attestor().ok();
            assert_ne!(
                recovered,
                Some(signer),
                "mutating `{name}` left the signature valid — that field is outside the digest"
            );
        }
    }

    /// `attestor_addr` and `attestor_url` mirror the Solidity `Attestor[]`,
    /// which `encodeAttestation` does NOT cover. Pinning that here documents
    /// why the handler cannot trust `attestor_addr` on its own.
    #[test]
    fn the_attestor_array_is_outside_the_digest() {
        let base = golden_attestation();
        let mut altered = base.clone();
        altered.attestor_addr = [0xff; 20];
        altered.attestor_url = "https://somewhere.else".into();
        assert_eq!(altered.encode(), base.encode());
    }

    #[test]
    fn only_v_27_and_28_are_accepted() {
        let mut att = golden_attestation();
        sign_attestation(&mut att, &ATTESTOR_KEY);
        for bad_v in [0u8, 1, 26, 29, 255] {
            let mut sig = att.signature;
            sig[64] = bad_v;
            assert!(
                recover_evm_signer(&att.encode(), &sig).is_err(),
                "v={bad_v}"
            );
        }
    }

    /// The BPF syscall rejects high-`s` signatures but the host fallback does
    /// not, so the explicit check is what keeps unit tests honest about what
    /// the deployed program does.
    #[test]
    fn a_high_s_signature_is_rejected_as_malleable() {
        let mut att = golden_attestation();
        sign_attestation(&mut att, &ATTESTOR_KEY);
        let mut sig = att.signature;
        // s = n - s is the malleable twin; 0xFF.. is simply above n/2, which
        // is all this check looks at.
        sig[32..64].copy_from_slice(&[0xff; 32]);
        assert!(recover_evm_signer(&att.encode(), &sig).is_err());
    }

    #[test]
    fn oversized_fields_are_rejected_before_hashing() {
        let mut att = golden_attestation();
        assert!(att.check_field_sizes().is_ok());
        att.request.url = "a".repeat(MAX_ZK_URL_LEN + 1);
        assert!(att.check_field_sizes().is_err());
    }

    /// `abi.encodePacked` concatenates adjacent strings with no separator, so
    /// this collision is real and reproduced faithfully. It is exactly why
    /// `rule_hash` is length-prefixed rather than relying on the digest to
    /// pin the endpoint.
    #[test]
    fn packed_encoding_is_ambiguous_across_adjacent_strings() {
        let mut a = golden_attestation();
        a.request.url = "https://x.test/ab".into();
        a.request.header = "cd".into();
        let mut b = a.clone();
        b.request.url = "https://x.test/a".into();
        b.request.header = "bcd".into();
        assert_eq!(a.encode_request(), b.encode_request());
    }

    #[test]
    fn an_empty_resolve_list_hashes_the_empty_string() {
        let mut att = golden_attestation();
        att.response_resolve.clear();
        assert_eq!(
            att.encode_response(),
            anchor_lang::solana_program::keccak::hash(&[]).to_bytes()
        );
    }
}
