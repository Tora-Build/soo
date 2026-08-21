//! Extracting a number from an attestation's `data`, and comparing it to the
//! registered threshold.
//!
//! Scope is deliberately narrow. `data` is attestor-signed but otherwise
//! arbitrary JSON, and a lenient parser on-chain is an attack surface: every
//! shape it silently accepts is a shape an operator did not intend to resolve
//! against. So exactly two forms parse, and everything else is an error
//! rather than a guess.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::error::SoothCoreError;

/// Largest `value_scale` an entry may register. Beyond this, `10^scale`
/// no longer leaves room to scale a realistic feed value inside an `i128`.
pub const MAX_ZK_VALUE_SCALE: u8 = 18;

/// How the attested value is tested against the registered threshold.
///
/// `None` is the discriminant zero on purpose: it doubles as the "this entry
/// is not zk-enabled" flag, so an `AdjudicatorEntry` written by the manual
/// `register_adjudicator` path — which zeroes the whole reserved region — is
/// automatically not zk-enabled, with no extra byte spent on a boolean.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ZkComparator {
    None = 0,
    Gt = 1,
    Gte = 2,
    Lt = 3,
    Lte = 4,
    Eq = 5,
}

impl ZkComparator {
    pub fn from_u8(raw: u8) -> Result<Self> {
        Ok(match raw {
            0 => ZkComparator::None,
            1 => ZkComparator::Gt,
            2 => ZkComparator::Gte,
            3 => ZkComparator::Lt,
            4 => ZkComparator::Lte,
            5 => ZkComparator::Eq,
            _ => return Err(error!(SoothCoreError::ZkInvalidComparator)),
        })
    }

    /// True iff `value <op> threshold` holds. Both operands are already in
    /// the same fixed-point scale.
    ///
    /// `None` never holds: a disabled entry resolves nothing.
    pub fn holds(self, value: i128, threshold: i128) -> bool {
        match self {
            ZkComparator::None => false,
            ZkComparator::Gt => value > threshold,
            ZkComparator::Gte => value >= threshold,
            ZkComparator::Lt => value < threshold,
            ZkComparator::Lte => value <= threshold,
            ZkComparator::Eq => value == threshold,
        }
    }
}

/// The commitment an entry stores so an attestation for a different endpoint
/// or a different field of the same endpoint cannot be substituted.
///
/// ```text
/// rule_hash = sha256( u32_le(url.len) ‖ url ‖ u32_le(parse_path.len) ‖ parse_path )
/// ```
///
/// Length prefixes rather than a separator byte: they make the split point
/// unambiguous, so no pair of `(url, parse_path)` values can be re-cut into a
/// different pair with the same preimage.
pub fn compute_rule_hash(url: &str, parse_path: &str) -> [u8; 32] {
    let url_len = (url.len() as u32).to_le_bytes();
    let path_len = (parse_path.len() as u32).to_le_bytes();
    hashv(&[&url_len, url.as_bytes(), &path_len, parse_path.as_bytes()]).to_bytes()
}

/// Reads the resolved value out of `data` and returns it scaled by
/// `10^scale`.
///
/// Two accepted forms, and only these two:
///
/// - a bare decimal literal — `"1234"`, `"-0.5"`
/// - a single-key JSON object whose key is `key_name` and whose value is a
///   decimal literal, quoted or not — `{"price":"64000.5"}`, `{"price":64000}`
///
/// A second key, a nested object, an array, a non-numeric value, or more
/// fractional digits than `scale` can hold are all rejected. Rejecting excess
/// precision rather than truncating is the point: silent truncation would
/// move the value across the threshold in the operator's blind spot.
pub fn parse_attested_value(data: &str, key_name: &str, scale: u8) -> Result<i128> {
    require!(
        scale <= MAX_ZK_VALUE_SCALE,
        SoothCoreError::ZkInvalidValueScale
    );
    let token = extract_value_token(data, key_name)?;
    parse_fixed_point(token, scale)
}

/// Narrows `data` to the single numeric token, without interpreting it.
fn extract_value_token<'a>(data: &'a str, key_name: &str) -> Result<&'a str> {
    let body = data.trim();
    if !body.starts_with('{') {
        return Ok(body);
    }

    let inner = body
        .strip_prefix('{')
        .and_then(|s| s.strip_suffix('}'))
        .ok_or(error!(SoothCoreError::ZkDataUnparseable))?
        .trim();

    // The key must be present, quoted, and first.
    let after_key = inner
        .strip_prefix('"')
        .and_then(|s| s.strip_prefix(key_name))
        .and_then(|s| s.strip_prefix('"'))
        .ok_or(error!(SoothCoreError::ZkDataUnparseable))?;

    let value = after_key
        .trim_start()
        .strip_prefix(':')
        .ok_or(error!(SoothCoreError::ZkDataUnparseable))?
        .trim();

    // Anything left after the value means a second key, so the object is not
    // the single-field shape this path is scoped to.
    let value = match value.strip_prefix('"') {
        Some(rest) => rest
            .strip_suffix('"')
            .ok_or(error!(SoothCoreError::ZkDataUnparseable))?,
        None => value,
    };
    require!(
        !value.contains(',') && !value.contains('{') && !value.contains('['),
        SoothCoreError::ZkDataUnparseable
    );

    Ok(value)
}

/// Parses a plain decimal literal into fixed point at `10^scale`.
///
/// No exponents, no leading `+`, no thousands separators, no hex, no `NaN` —
/// a sign, digits, and at most one `.`.
fn parse_fixed_point(token: &str, scale: u8) -> Result<i128> {
    let (negative, digits) = match token.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, token),
    };
    require!(!digits.is_empty(), SoothCoreError::ZkDataUnparseable);

    let mut parts = digits.split('.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next().unwrap_or("");
    require!(parts.next().is_none(), SoothCoreError::ZkDataUnparseable);

    // `.5` and `5.` are both spellings a feed might emit; at least one side
    // must carry a digit, and every character present must be one.
    require!(
        !(int_part.is_empty() && frac_part.is_empty()),
        SoothCoreError::ZkDataUnparseable
    );
    require!(
        int_part.bytes().all(|b| b.is_ascii_digit())
            && frac_part.bytes().all(|b| b.is_ascii_digit()),
        SoothCoreError::ZkDataUnparseable
    );
    require!(
        frac_part.len() <= scale as usize,
        SoothCoreError::ZkValuePrecisionTooHigh
    );

    let mut value: i128 = 0;
    for b in int_part.bytes().chain(frac_part.bytes()) {
        value = value
            .checked_mul(10)
            .and_then(|v| v.checked_add((b - b'0') as i128))
            .ok_or(error!(SoothCoreError::ZkValueOutOfRange))?;
    }
    // Digits consumed so far already carry `frac_part.len()` decimal places.
    for _ in 0..(scale as usize - frac_part.len()) {
        value = value
            .checked_mul(10)
            .ok_or(error!(SoothCoreError::ZkValueOutOfRange))?;
    }

    Ok(if negative { -value } else { value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comparators_resolve_around_the_threshold() {
        assert!(ZkComparator::Gt.holds(11, 10));
        assert!(!ZkComparator::Gt.holds(10, 10));
        assert!(ZkComparator::Gte.holds(10, 10));
        assert!(ZkComparator::Lt.holds(9, 10));
        assert!(!ZkComparator::Lt.holds(10, 10));
        assert!(ZkComparator::Lte.holds(10, 10));
        assert!(ZkComparator::Eq.holds(10, 10));
        assert!(!ZkComparator::Eq.holds(11, 10));
    }

    /// `None` doubles as the not-zk-enabled flag, so it must never resolve —
    /// if it returned true for anything, a manually registered entry read
    /// through the zk path would answer YES.
    #[test]
    fn the_none_comparator_never_holds() {
        for (v, t) in [(0i128, 0i128), (1, 0), (-1, 0), (i128::MAX, i128::MIN)] {
            assert!(!ZkComparator::None.holds(v, t));
        }
    }

    #[test]
    fn unknown_comparator_discriminants_are_rejected() {
        assert_eq!(ZkComparator::from_u8(0).unwrap(), ZkComparator::None);
        assert_eq!(ZkComparator::from_u8(5).unwrap(), ZkComparator::Eq);
        for raw in [6u8, 7, 128, 255] {
            assert!(ZkComparator::from_u8(raw).is_err());
        }
    }

    /// Length prefixes exist so no `(url, parse_path)` pair can be re-cut
    /// into a different pair with the same hash. Plain concatenation would
    /// collide on this exact case.
    #[test]
    fn rule_hash_cannot_be_re_cut_across_the_url_path_boundary() {
        let a = compute_rule_hash("https://x.test/ab", "c");
        let b = compute_rule_hash("https://x.test/a", "bc");
        assert_ne!(a, b);
    }

    #[test]
    fn rule_hash_is_deterministic_and_endpoint_specific() {
        let base = compute_rule_hash("https://api.test/price", "$.data.price");
        assert_eq!(
            base,
            compute_rule_hash("https://api.test/price", "$.data.price")
        );
        assert_ne!(
            base,
            compute_rule_hash("https://evil.test/price", "$.data.price")
        );
        assert_ne!(
            base,
            compute_rule_hash("https://api.test/price", "$.data.volume")
        );
    }

    #[test]
    fn a_single_key_object_parses_quoted_or_bare() {
        assert_eq!(
            parse_attested_value(r#"{"price":"64000.5"}"#, "price", 6).unwrap(),
            64_000_500_000
        );
        assert_eq!(
            parse_attested_value(r#"{"price":64000.5}"#, "price", 6).unwrap(),
            64_000_500_000
        );
    }

    #[test]
    fn a_bare_decimal_parses() {
        assert_eq!(parse_attested_value("42", "price", 0).unwrap(), 42);
        assert_eq!(parse_attested_value("42", "price", 2).unwrap(), 4_200);
        assert_eq!(parse_attested_value("-0.5", "price", 2).unwrap(), -50);
        assert_eq!(parse_attested_value(" 7 ", "price", 0).unwrap(), 7);
    }

    #[test]
    fn whitespace_inside_the_object_is_tolerated() {
        assert_eq!(
            parse_attested_value(r#" { "price" : "1.25" } "#, "price", 2).unwrap(),
            125
        );
    }

    /// A different key must not resolve: the market committed to one field.
    #[test]
    fn the_wrong_key_is_rejected() {
        assert!(parse_attested_value(r#"{"volume":"5"}"#, "price", 0).is_err());
    }

    /// The parser is scoped to a single-field object on purpose. A multi-key
    /// payload means the attestation resolved more than the market committed
    /// to, and picking one silently would be a guess.
    #[test]
    fn multi_key_objects_and_nesting_are_rejected() {
        for bad in [
            r#"{"price":"1","volume":"2"}"#,
            r#"{"price":{"usd":"1"}}"#,
            r#"{"price":["1"]}"#,
            r#"{"volume":"2","price":"1"}"#,
        ] {
            assert!(
                parse_attested_value(bad, "price", 0).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn non_numeric_values_are_rejected_not_coerced() {
        for bad in [
            r#"{"price":"abc"}"#,
            r#"{"price":""}"#,
            r#"{"price":"1.2.3"}"#,
            r#"{"price":"1e9"}"#,
            r#"{"price":"+1"}"#,
            r#"{"price":"0x10"}"#,
            r#"{"price":"1,000"}"#,
            r#"{"price":"NaN"}"#,
            r#"{"price":"-"}"#,
            r#"{"price":null}"#,
            r#"{"price":true}"#,
            "",
            "{",
            r#"{"price""#,
        ] {
            assert!(
                parse_attested_value(bad, "price", 6).is_err(),
                "accepted {bad:?}"
            );
        }
    }

    /// Truncating excess precision would move a value across the threshold
    /// silently, so it is an error instead.
    #[test]
    fn excess_precision_is_rejected_rather_than_truncated() {
        assert!(parse_attested_value(r#"{"price":"1.234"}"#, "price", 2).is_err());
        assert_eq!(
            parse_attested_value(r#"{"price":"1.23"}"#, "price", 2).unwrap(),
            123
        );
    }

    #[test]
    fn a_scale_above_the_maximum_is_rejected() {
        assert!(parse_attested_value("1", "price", MAX_ZK_VALUE_SCALE).is_ok());
        assert!(parse_attested_value("1", "price", MAX_ZK_VALUE_SCALE + 1).is_err());
    }

    #[test]
    fn an_unrepresentable_value_errors_instead_of_wrapping() {
        let huge = "9".repeat(64);
        assert!(parse_attested_value(&huge, "price", 18).is_err());
    }

    /// The full path a market takes: signed decimal string in, YES/NO out.
    #[test]
    fn parsed_values_compare_against_a_same_scale_threshold() {
        let scale = 6;
        let threshold = 64_000_000_000i128; // 64000.0 at 1e6
        let above = parse_attested_value(r#"{"price":"64000.5"}"#, "price", scale).unwrap();
        let below = parse_attested_value(r#"{"price":"63999.5"}"#, "price", scale).unwrap();
        assert!(ZkComparator::Gt.holds(above, threshold));
        assert!(!ZkComparator::Gt.holds(below, threshold));
    }
}

#[cfg(test)]
mod cross_language_parity {
    use super::*;

    /// The `rule_hash` an integrator computes off-chain must equal the one
    /// this program derives, or every attestation for the market fails with
    /// `ZkRuleHashMismatch`. `sdk-solana/tests/zk-attestation.test.ts` asserts
    /// `computeRuleHash` reproduces this exact value from the same inputs, so
    /// the two implementations are pinned to each other rather than each to
    /// itself.
    #[test]
    fn rule_hash_matches_the_sdk_vector() {
        let hash = compute_rule_hash(
            "https://api.example.com/v1/price?symbol=BTCUSDT",
            "$.data.price",
        );
        let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "722ef544c226c7bf48ce02a0d30020e487cd784b0e1da4989d477310779b8c50"
        );
    }
}
