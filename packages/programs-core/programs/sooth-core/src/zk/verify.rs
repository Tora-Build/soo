//! The whole trust decision for a zkTLS-adjudicated market, as a pure
//! function.
//!
//! Everything that decides an outcome lives here rather than in the
//! instruction handler, so it is reachable from unit tests with no validator
//! and no accounts: the handler is left holding only account plumbing and the
//! state write.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;
use crate::state::{OUTCOME_NO, OUTCOME_YES};
use crate::zk::primus::{EvmAddress, ZkAttestation};
use crate::zk::value::{compute_rule_hash, parse_attested_value, ZkComparator};

/// Above this, a `uint64` timestamp cannot be unix seconds: seconds do not
/// reach 10^12 until the year 33658, while milliseconds passed it in 2001.
/// Primus mints timestamps with JavaScript's millisecond clock, so this
/// normalizes rather than guesses — both readings are accepted and exactly
/// one of them is possible for any given value.
const MILLISECOND_TIMESTAMP_FLOOR: u64 = 1_000_000_000_000;

/// What a market committed to at registration. The `AdjudicatorEntry`'s zk
/// fields, typed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZkRule {
    pub attestor_evm: EvmAddress,
    pub rule_hash: [u8; 32],
    pub comparator: ZkComparator,
    /// In `10^value_scale` units, same as the parsed value.
    pub threshold: i128,
    pub value_scale: u8,
}

/// The outcome plus the evidence behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZkVerdict {
    /// 0=NO, 1=YES. A zk rule is a predicate, so it never yields INVALID —
    /// an attestation that cannot be trusted is an error, not an outcome.
    pub winning_outcome: u8,
    /// Recovered from the signature, not taken from the payload.
    pub attestor_evm: EvmAddress,
    pub value: i128,
    /// Normalized to unix seconds.
    pub attestation_ts: i64,
}

/// Verifies `att` against `rule` and resolves it to an outcome.
///
/// `min_timestamp` is the earliest observation time the market accepts, in
/// unix seconds — the market's deadline. It stops a reading taken while the
/// market was still trading from resolving it.
///
/// Three independent checks gate the verdict, and none is sufficient alone:
/// the signature proves an attestor saw these exact bytes; `rule_hash` proves
/// the bytes came from the endpoint and field the market committed to; the
/// timestamp proves the observation is recent enough to be about the
/// question. Drop the second and any attestation the same attestor ever
/// signed would resolve this market.
pub fn verify_attestation(
    att: &ZkAttestation,
    rule: &ZkRule,
    min_timestamp: i64,
) -> Result<ZkVerdict> {
    att.check_field_sizes()?;

    require!(
        rule.comparator != ZkComparator::None,
        SoothCoreError::ZkNotEnabled
    );

    // Exactly one resolve entry. More than one would leave both the
    // `rule_hash` commitment and the value extraction ambiguous about which
    // field of the response actually decides the market.
    require!(
        att.response_resolve.len() == 1,
        SoothCoreError::ZkResponseResolveCountInvalid
    );
    let resolve = &att.response_resolve[0];

    require!(
        compute_rule_hash(&att.request.url, &resolve.parse_path) == rule.rule_hash,
        SoothCoreError::ZkRuleHashMismatch
    );

    let attestation_ts = normalize_timestamp(att.timestamp);
    require!(
        attestation_ts >= min_timestamp,
        SoothCoreError::ZkAttestationTimestampInvalid
    );

    let value = parse_attested_value(&att.data, &resolve.key_name, rule.value_scale)?;

    // Recovery is the most expensive check, so it runs once everything cheap
    // has already passed.
    let attestor_evm = att.recover_attestor()?;
    require!(
        attestor_evm == rule.attestor_evm,
        SoothCoreError::ZkAttestorMismatch
    );
    // The Solidity `Attestor[]` member sits outside the signed digest, so the
    // submitted address is an assertion to cross-check, never a trust input.
    require!(
        att.attestor_addr == attestor_evm,
        SoothCoreError::ZkAttestorMismatch
    );

    let winning_outcome = if rule.comparator.holds(value, rule.threshold) {
        OUTCOME_YES
    } else {
        OUTCOME_NO
    };

    Ok(ZkVerdict {
        winning_outcome,
        attestor_evm,
        value,
        attestation_ts,
    })
}

/// Reads a Primus `uint64` timestamp as unix seconds, accepting the
/// millisecond clock it is actually minted with.
pub fn normalize_timestamp(timestamp: u64) -> i64 {
    if timestamp >= MILLISECOND_TIMESTAMP_FLOOR {
        (timestamp / 1000) as i64
    } else {
        timestamp as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zk::primus::test_support::*;
    use crate::zk::primus::{ZkNetworkRequest, ZkResponseResolve};

    /// Locally generated attestor key. Nothing here contacts Primus.
    const ATTESTOR_KEY: [u8; 32] = [0x11; 32];
    /// A key the market never registered.
    const IMPOSTOR_KEY: [u8; 32] = [0x22; 32];

    const URL: &str = "https://api.example.com/v1/price?symbol=BTCUSDT";
    const PARSE_PATH: &str = "$.data.price";
    const SCALE: u8 = 6;
    /// 64000.0 in 1e6 units.
    const THRESHOLD: i128 = 64_000_000_000;
    const DEADLINE: i64 = 1_700_000_000;

    fn rule(comparator: ZkComparator) -> ZkRule {
        ZkRule {
            attestor_evm: address_for(&ATTESTOR_KEY),
            rule_hash: compute_rule_hash(URL, PARSE_PATH),
            comparator,
            threshold: THRESHOLD,
            value_scale: SCALE,
        }
    }

    /// An attestation reporting `price`, signed by `key`.
    fn attestation(price: &str, key: &[u8; 32]) -> ZkAttestation {
        let mut att = ZkAttestation {
            recipient: [0xaa; 20],
            request: ZkNetworkRequest {
                url: URL.into(),
                header: r#"{"accept":"application/json"}"#.into(),
                method: "GET".into(),
                body: String::new(),
            },
            response_resolve: vec![ZkResponseResolve {
                key_name: "price".into(),
                parse_type: "string".into(),
                parse_path: PARSE_PATH.into(),
            }],
            data: format!(r#"{{"price":"{price}"}}"#),
            att_conditions: String::new(),
            // Milliseconds, as Primus mints them, and after the deadline.
            timestamp: (DEADLINE as u64 + 60) * 1000,
            addition_params: String::new(),
            attestor_addr: [0; 20],
            attestor_url: "https://attestor.primus.test".into(),
            signature: [0; 65],
        };
        sign_attestation(&mut att, key);
        att
    }

    fn err_code(res: Result<ZkVerdict>) -> u32 {
        match res.unwrap_err() {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("expected an AnchorError, got {other:?}"),
        }
    }

    fn is(res: Result<ZkVerdict>, expected: SoothCoreError) -> bool {
        err_code(res) == expected as u32 + anchor_lang::error::ERROR_CODE_OFFSET
    }

    #[test]
    fn a_value_above_the_threshold_with_gt_resolves_yes() {
        let att = attestation("64000.5", &ATTESTOR_KEY);
        let v = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE).unwrap();
        assert_eq!(v.winning_outcome, OUTCOME_YES);
        assert_eq!(v.value, 64_000_500_000);
        assert_eq!(v.attestor_evm, address_for(&ATTESTOR_KEY));
        assert_eq!(v.attestation_ts, DEADLINE + 60);
    }

    #[test]
    fn a_value_below_the_threshold_with_gt_resolves_no() {
        let att = attestation("63999.5", &ATTESTOR_KEY);
        let v = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE).unwrap();
        assert_eq!(v.winning_outcome, OUTCOME_NO);
        assert_eq!(v.value, 63_999_500_000);
    }

    /// A rule is a predicate, so a failed predicate is NO — never INVALID.
    /// INVALID stays reachable only through the manual path and `dispute`.
    #[test]
    fn every_comparator_resolves_to_yes_or_no_only() {
        for c in [
            ZkComparator::Gt,
            ZkComparator::Gte,
            ZkComparator::Lt,
            ZkComparator::Lte,
            ZkComparator::Eq,
        ] {
            for price in ["63999", "64000", "64001"] {
                let att = attestation(price, &ATTESTOR_KEY);
                let v = verify_attestation(&att, &rule(c), DEADLINE).unwrap();
                assert!(v.winning_outcome == OUTCOME_YES || v.winning_outcome == OUTCOME_NO);
            }
        }
    }

    #[test]
    fn the_boundary_separates_gt_from_gte() {
        let att = attestation("64000", &ATTESTOR_KEY);
        assert_eq!(
            verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE)
                .unwrap()
                .winning_outcome,
            OUTCOME_NO
        );
        assert_eq!(
            verify_attestation(&att, &rule(ZkComparator::Gte), DEADLINE)
                .unwrap()
                .winning_outcome,
            OUTCOME_YES
        );
    }

    /// The core property: only the registered attestor can resolve the
    /// market. The impostor's signature is perfectly valid — it just belongs
    /// to a key this market never committed to.
    #[test]
    fn a_signature_from_a_different_key_is_rejected() {
        let att = attestation("64000.5", &IMPOSTOR_KEY);
        let res = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE);
        assert!(is(res, SoothCoreError::ZkAttestorMismatch));
    }

    /// A genuine signature over tampered fields must not verify — this is
    /// what re-encoding on-chain buys, versus trusting a supplied digest.
    #[test]
    fn a_tampered_payload_under_a_genuine_signature_is_rejected() {
        let mut att = attestation("63999.5", &ATTESTOR_KEY);
        // Signature stays; the value it covers is swapped for a winning one.
        att.data = r#"{"price":"99999"}"#.into();
        let res = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE);
        assert!(is(res, SoothCoreError::ZkAttestorMismatch));
    }

    /// An attestation the same attestor genuinely signed, for a different
    /// endpoint. Without `rule_hash` this would resolve the market.
    #[test]
    fn an_attestation_for_a_different_url_is_rejected() {
        let mut att = attestation("64000.5", &ATTESTOR_KEY);
        att.request.url = "https://evil.example.com/v1/price".into();
        sign_attestation(&mut att, &ATTESTOR_KEY);
        let res = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE);
        assert!(is(res, SoothCoreError::ZkRuleHashMismatch));
    }

    /// Same endpoint, different field of the response.
    #[test]
    fn an_attestation_for_a_different_parse_path_is_rejected() {
        let mut att = attestation("64000.5", &ATTESTOR_KEY);
        att.response_resolve[0].parse_path = "$.data.volume".into();
        sign_attestation(&mut att, &ATTESTOR_KEY);
        let res = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE);
        assert!(is(res, SoothCoreError::ZkRuleHashMismatch));
    }

    #[test]
    fn unparseable_data_fails_with_the_named_error() {
        for bad in [
            r#"{"price":"not-a-number"}"#,
            r#"{"price":{"usd":"1"}}"#,
            r#"{"volume":"1"}"#,
            "",
        ] {
            let mut att = attestation("0", &ATTESTOR_KEY);
            att.data = bad.into();
            sign_attestation(&mut att, &ATTESTOR_KEY);
            let res = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE);
            assert!(
                is(res, SoothCoreError::ZkDataUnparseable),
                "wrong error for {bad:?}"
            );
        }
    }

    #[test]
    fn excess_precision_fails_with_its_own_error() {
        let att = attestation("64000.1234567", &ATTESTOR_KEY);
        let res = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE);
        assert!(is(res, SoothCoreError::ZkValuePrecisionTooHigh));
    }

    /// An entry left un-configured — which is every entry the manual
    /// `register_adjudicator` path writes — must not resolve through here.
    #[test]
    fn a_rule_with_no_comparator_is_not_zk_enabled() {
        let att = attestation("64000.5", &ATTESTOR_KEY);
        let res = verify_attestation(&att, &rule(ZkComparator::None), DEADLINE);
        assert!(is(res, SoothCoreError::ZkNotEnabled));
    }

    /// A reading taken while the market was still trading cannot resolve it.
    #[test]
    fn an_observation_from_before_the_deadline_is_rejected() {
        let mut att = attestation("64000.5", &ATTESTOR_KEY);
        att.timestamp = (DEADLINE as u64 - 1) * 1000;
        sign_attestation(&mut att, &ATTESTOR_KEY);
        let res = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE);
        assert!(is(res, SoothCoreError::ZkAttestationTimestampInvalid));
    }

    #[test]
    fn a_timestamp_exactly_at_the_deadline_is_accepted() {
        let mut att = attestation("64000.5", &ATTESTOR_KEY);
        att.timestamp = DEADLINE as u64 * 1000;
        sign_attestation(&mut att, &ATTESTOR_KEY);
        assert!(verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE).is_ok());
    }

    /// Seconds and milliseconds are distinguishable by magnitude, so both
    /// read correctly and neither is a guess.
    #[test]
    fn seconds_and_millisecond_timestamps_both_normalize() {
        assert_eq!(normalize_timestamp(DEADLINE as u64), DEADLINE);
        assert_eq!(normalize_timestamp(DEADLINE as u64 * 1000), DEADLINE);
        assert_eq!(normalize_timestamp(0), 0);
    }

    #[test]
    fn a_resolve_list_that_is_not_exactly_one_entry_is_rejected() {
        let mut none = attestation("64000.5", &ATTESTOR_KEY);
        none.response_resolve.clear();
        sign_attestation(&mut none, &ATTESTOR_KEY);
        assert!(is(
            verify_attestation(&none, &rule(ZkComparator::Gt), DEADLINE),
            SoothCoreError::ZkResponseResolveCountInvalid
        ));

        let mut two = attestation("64000.5", &ATTESTOR_KEY);
        let extra = two.response_resolve[0].clone();
        two.response_resolve.push(extra);
        sign_attestation(&mut two, &ATTESTOR_KEY);
        assert!(is(
            verify_attestation(&two, &rule(ZkComparator::Gt), DEADLINE),
            SoothCoreError::ZkResponseResolveCountInvalid
        ));
    }

    /// `attestor_addr` is outside the digest, so a payload can claim one
    /// address while the signature recovers another. The cross-check makes
    /// that a hard failure rather than a silent inconsistency.
    #[test]
    fn a_mismatched_self_declared_attestor_is_rejected() {
        let mut att = attestation("64000.5", &ATTESTOR_KEY);
        att.attestor_addr = address_for(&IMPOSTOR_KEY);
        let res = verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE);
        assert!(is(res, SoothCoreError::ZkAttestorMismatch));
    }

    #[test]
    fn a_malformed_signature_fails_recovery_rather_than_panicking() {
        let mut att = attestation("64000.5", &ATTESTOR_KEY);
        att.signature[64] = 30;
        assert!(is(
            verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE),
            SoothCoreError::ZkInvalidSignatureV
        ));

        let mut zeroed = attestation("64000.5", &ATTESTOR_KEY);
        zeroed.signature = [0; 65];
        assert!(verify_attestation(&zeroed, &rule(ZkComparator::Gt), DEADLINE).is_err());
    }

    #[test]
    fn oversized_fields_are_rejected_before_any_crypto_runs() {
        let mut att = attestation("64000.5", &ATTESTOR_KEY);
        att.request.header = "x".repeat(2_000);
        assert!(is(
            verify_attestation(&att, &rule(ZkComparator::Gt), DEADLINE),
            SoothCoreError::ZkAttestationFieldTooLong
        ));
    }
}
