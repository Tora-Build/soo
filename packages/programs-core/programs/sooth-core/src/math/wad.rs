//! WAD (1e18) fixed-point primitives.
//!
//! Two operations carry a 256-bit intermediate via paired u128 limbs
//! (hand-rolled, no `ethnum` dep) to preserve precision.

use core::convert::TryInto;

/// 1e18 — matches EVM's WAD scalar from `LMSRMath.sol`.
pub const WAD: i128 = 1_000_000_000_000_000_000;
pub const WAD_U: u128 = 1_000_000_000_000_000_000;

/// ln(2) in WAD.
pub const LN2_WAD: i128 = 693_147_180_559_945_309;

/// USDC has 6 decimals on Solana mainnet (matches EVM). WAD has 18.
/// Scalar = 10^(18-6) = 1e12.
pub const WAD_TO_USDC_SCALAR: u128 = 1_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    /// `exp` input outside the saturated domain, `ln` of a non-positive value,
    /// or an intermediate u128/i128 overflow.
    Overflow,
}

/// Multiply two WAD numbers, returning a WAD number. 256-bit intermediate via
/// 64-bit limbs; rounding toward zero.
#[inline(always)]
pub fn wad_mul(a: i128, b: i128) -> Result<i128, MathError> {
    let neg = (a < 0) ^ (b < 0);
    let au = a.unsigned_abs();
    let bu = b.unsigned_abs();
    let prod_lo = au.wrapping_mul(bu);
    let a_hi = au >> 64;
    let a_lo = au & ((1u128 << 64) - 1);
    let b_hi = bu >> 64;
    let b_lo = bu & ((1u128 << 64) - 1);
    let ll = a_lo.wrapping_mul(b_lo);
    let lh = a_lo.wrapping_mul(b_hi);
    let hl = a_hi.wrapping_mul(b_lo);
    let hh = a_hi.wrapping_mul(b_hi);

    // Schoolbook carry into the high word.
    //
    // `mid` sums the three 64-bit-weighted contributions: the top half of the
    // low partial product, plus the low halves of the two cross terms. Each is
    // < 2^64, so `mid` < 3·2^64 and cannot overflow u128 — which is what makes
    // `mid >> 64` the exact carry.
    //
    // The earlier version derived that carry from whether
    // `(ll >> 64) + (mid_lo << 64)` overflowed u128. That is a different
    // question: the real carry is whether `(ll >> 64) + mid_lo` crosses 2^64,
    // and the two disagree exactly when the top limb is large. When they
    // disagreed, `prod_hi` came out one short, the 256-bit division silently
    // dropped 2^128, and `wad_mul` returned a number ~340.28e18 BELOW the true
    // product instead of reporting an overflow.
    //
    // `lmsr_cost` ends in `wad_mul(b, m + ln_sum)`, so the wrap fired for any
    // market whose cost exceeded that threshold — `max(q) + b·ln(2) > ~340`.
    // `cost_delta` differences two costs, so while both endpoints wrapped the
    // same number of times the error cancelled and the market looked healthy.
    // A trade that straddled a wrap boundary did not cancel: it returned a
    // large NEGATIVE cost for a buy — the program paying the trader to take
    // shares. Reachable at b=50 with ~340 shares outstanding.
    let mid = (ll >> 64)
        .wrapping_add(lh & ((1u128 << 64) - 1))
        .wrapping_add(hl & ((1u128 << 64) - 1));
    let prod_hi = hh
        .wrapping_add(lh >> 64)
        .wrapping_add(hl >> 64)
        .wrapping_add(mid >> 64);

    if prod_hi == 0 {
        let q = prod_lo / WAD_U;
        let qi: i128 = q.try_into().map_err(|_| MathError::Overflow)?;
        return Ok(if neg { -qi } else { qi });
    }
    let q_hi = prod_hi / WAD_U;
    let rem_hi = prod_hi % WAD_U;
    let mut rem = rem_hi;
    let mut q_lo: u128 = 0;
    for chunk_idx in (0..4).rev() {
        let chunk = (prod_lo >> (chunk_idx * 32)) & 0xFFFF_FFFF;
        rem = (rem << 32) | chunk;
        let q_chunk = rem / WAD_U;
        rem %= WAD_U;
        q_lo = (q_lo << 32) | q_chunk;
    }
    if q_hi != 0 {
        return Err(MathError::Overflow);
    }
    let qi: i128 = q_lo.try_into().map_err(|_| MathError::Overflow)?;
    Ok(if neg { -qi } else { qi })
}

/// Divide two WAD numbers: (a * WAD) / b.
#[inline(always)]
pub fn wad_div(a: i128, b: i128) -> Result<i128, MathError> {
    if b == 0 {
        return Err(MathError::Overflow);
    }
    let neg = (a < 0) ^ (b < 0);
    let au = a.unsigned_abs();
    let bu = b.unsigned_abs();
    let a_hi = au >> 64;
    let a_lo = au & ((1u128 << 64) - 1);
    let w = WAD_U;
    let lo = a_lo.wrapping_mul(w);
    let hi = a_hi.wrapping_mul(w);
    let num_lo_low = lo & ((1u128 << 64) - 1);
    let num_lo_high = lo >> 64;
    let (num_mid, carry) = (hi).overflowing_add(num_lo_high);
    let _ = carry;
    let num_hi = num_mid >> 64;
    let num_mid_low = num_mid & ((1u128 << 64) - 1);
    let num_low = (num_mid_low << 64) | num_lo_low;
    let mut rem: u128 = num_hi;
    if rem >= bu {
        return Err(MathError::Overflow);
    }
    let mut q: u128 = 0;
    for chunk_idx in (0..4).rev() {
        let chunk = (num_low >> (chunk_idx * 32)) & 0xFFFF_FFFF;
        rem = (rem << 32) | chunk;
        let qc = rem / bu;
        rem %= bu;
        q = (q << 32) | qc;
    }
    let qi: i128 = q.try_into().map_err(|_| MathError::Overflow)?;
    Ok(if neg { -qi } else { qi })
}

/// Convert a non-negative WAD amount to USDC base units, rounding **up**.
///
/// Used at trade entry (cost charged to the user) per architecture §4.2 line
/// 168. The protocol always charges the user the ceiling so dust accrues to
/// the vault rather than the trader. The mirror op `wad_to_usdc_floor` is
/// used at redemption.
#[inline(always)]
pub fn wad_to_usdc_ceil(wad: u128) -> Result<u64, MathError> {
    // ceil(wad / 1e12) without overflowing: (wad + scalar - 1) / scalar.
    // wad < 2^128 - 1e12 always for our domain (USDC supply ≪ 2^128).
    let s = WAD_TO_USDC_SCALAR;
    let num = wad.checked_add(s - 1).ok_or(MathError::Overflow)?;
    let q = num / s;
    q.try_into().map_err(|_| MathError::Overflow)
}

/// Convert a non-negative WAD amount to USDC base units, rounding **down**.
///
/// The mirror of `wad_to_usdc_ceil`, used on outflow paths (sell proceeds,
/// redemption payouts) per architecture §4.3. Floor — not ceil — because:
///
///   1. The vault must never pay out more than its rounded-up intake; if we
///      ceil'd outflows the AMM would slowly drain by 1 base unit per trade
///      until the vault dry-ups stranded later sellers (the EVM contract
///      enforces the same direction via `_wadToBaseToken` in
///      `AMMEngine.sol:1136-1149` which returns `wad / 1e12`).
///   2. Floor on outflow paired with ceil on inflow guarantees the vault's
///      base-token balance is a strict lower bound on its WAD-denominated
///      liability — i.e. the rounding always favours the protocol.
///
/// The dust difference is at most 10⁻¹² USDC = sub-picodollar per trade; any
/// accumulated floor residue stays in the vault and is reclaimable by future
/// sellers / redeemers (or written off at market settlement).
#[inline(always)]
pub fn wad_to_usdc_floor(wad: u128) -> Result<u64, MathError> {
    let q = wad / WAD_TO_USDC_SCALAR;
    q.try_into().map_err(|_| MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wad_to_usdc_ceil_basic() {
        // 1 USDC = 1e6 base units = 1e18 WAD
        assert_eq!(wad_to_usdc_ceil(WAD_U).unwrap(), 1_000_000);
        // half a USDC
        assert_eq!(wad_to_usdc_ceil(WAD_U / 2).unwrap(), 500_000);
        // exact 1 USDC base unit (1e12 WAD)
        assert_eq!(wad_to_usdc_ceil(WAD_TO_USDC_SCALAR).unwrap(), 1);
        // sub-base-unit: 1 WAD → 1 USDC base unit (ceil)
        assert_eq!(wad_to_usdc_ceil(1).unwrap(), 1);
        // zero
        assert_eq!(wad_to_usdc_ceil(0).unwrap(), 0);
        // exact multiple, no rounding
        assert_eq!(wad_to_usdc_ceil(2 * WAD_TO_USDC_SCALAR).unwrap(), 2);
    }

    #[test]
    fn wad_to_usdc_floor_basic() {
        // 1 USDC = 1e6 base units = 1e18 WAD
        assert_eq!(wad_to_usdc_floor(WAD_U).unwrap(), 1_000_000);
        // half a USDC
        assert_eq!(wad_to_usdc_floor(WAD_U / 2).unwrap(), 500_000);
        // exact 1 USDC base unit (1e12 WAD)
        assert_eq!(wad_to_usdc_floor(WAD_TO_USDC_SCALAR).unwrap(), 1);
        // sub-base-unit: 1 WAD floors to 0 (the inverse of ceil's behavior)
        assert_eq!(wad_to_usdc_floor(1).unwrap(), 0);
        // 1 USDC + 1 WAD floors back to 1 (ceil would give 2)
        assert_eq!(wad_to_usdc_floor(WAD_TO_USDC_SCALAR + 1).unwrap(), 1);
        // zero
        assert_eq!(wad_to_usdc_floor(0).unwrap(), 0);
        // floor and ceil agree on exact multiples
        assert_eq!(
            wad_to_usdc_floor(2 * WAD_TO_USDC_SCALAR).unwrap(),
            wad_to_usdc_ceil(2 * WAD_TO_USDC_SCALAR).unwrap()
        );
    }

    #[test]
    fn wad_to_usdc_floor_le_ceil() {
        // Invariant: floor(x) ≤ ceil(x) for any x; this is the property that
        // makes the vault solvent under round-trip trades. Spot-check across
        // a small grid.
        for &x in &[
            0u128,
            1,
            42,
            WAD_TO_USDC_SCALAR - 1,
            WAD_TO_USDC_SCALAR,
            WAD_TO_USDC_SCALAR + 1,
            7 * WAD_TO_USDC_SCALAR,
            7 * WAD_TO_USDC_SCALAR + 12345,
        ] {
            let f = wad_to_usdc_floor(x).unwrap();
            let c = wad_to_usdc_ceil(x).unwrap();
            assert!(f <= c, "floor({x})={f} > ceil={c}");
        }
    }

    #[test]
    fn wad_mul_identity() {
        assert_eq!(wad_mul(WAD, WAD).unwrap(), WAD);
        assert_eq!(wad_mul(WAD, 0).unwrap(), 0);
        assert_eq!(wad_mul(2 * WAD, 3 * WAD).unwrap(), 6 * WAD);
    }

    #[test]
    fn wad_div_identity() {
        assert_eq!(wad_div(WAD, WAD).unwrap(), WAD);
        assert_eq!(wad_div(2 * WAD, WAD).unwrap(), 2 * WAD);
        // 1/2 in WAD
        assert_eq!(wad_div(WAD, 2 * WAD).unwrap(), WAD / 2);
    }
}

#[cfg(test)]
mod wide_mul_regression {
    use super::*;

    /// `wad_mul` against exact 256-bit arithmetic.
    ///
    /// Every expected value here was computed in unbounded integer arithmetic
    /// outside Rust, so this checks the limb code against the real answer
    /// rather than against itself.
    ///
    /// The cases that matter are the ones whose 256-bit product exceeds
    /// `u128::MAX` — that is where the carry into the high word was computed
    /// wrongly. The old code returned a value ~340.28e18 BELOW the truth
    /// instead of erroring, which is how `lmsr_cost` came to report 5.37 for a
    /// market whose real cost was 345.65, and how `cost_delta` came to return
    /// a NEGATIVE cost for a buy.
    const CASES: &[(i128, i128, Option<i128>)] = &[
        (50000000000000000000i128, 6000000000000000000i128, Some(300000000000000000000)),
        (50000000000000000000i128, 6794000000000000000i128, Some(339700000000000000000)),
        (50000000000000000000i128, 6913015252399953000i128, Some(345650762619997650000)),
        (1000000000000000000000i128, 693147180559945309i128, Some(693147180559945309000)),
        (340000000000000000000i128, 1000000000000000000i128, Some(340000000000000000000)),
        (341000000000000000000i128, 1000000000000000000i128, Some(341000000000000000000)),
        (9223372036854775808i128, 9223372036854775808i128, Some(85070591730234615865)),
        (340282366920938463463i128, 1000000000000000000i128, Some(340282366920938463463)),
        (183505726384713937977i128, 67347853917828622095i128, Some(12358716853642743736150)),
        (642339135128645349172i128, 689275300611517638674i128, Some(442748500460339272785903)),
        (607076888410727187574i128, 92925393275891119565i128, Some(56412858604271091726770)),
        (81500891058152892251i128, 647309402353816049445i128, Some(52756293082156419208008)),
        (960321088193274137127i128, 749502757839938400346i128, Some(719763304012709673269071)),
        (72822376571655375090i128, 471969934648895407312i128, Some(34369972311501439358864)),
        (276263145136825950877i128, 484957694340233674414i128, Some(133975937896736452591737)),
        (139101102706615248549i128, 651326527868963874393i128, Some(90600238248643842902940)),
        (215494914043210999856i128, 674811416020804295651i128, Some(145418428090780719902644)),
        (427740722418364175688i128, 840207585234866222547i128, Some(359390999489750971409256)),
        (65750989692839587896i128, 575648334017700784562i128, Some(37849447676698124604870)),
        (507870597250376708437i128, 540750570594768549657i128, Some(274631315251447096342072)),
        (551990064978929869266i128, 282230886201776187737i128, Some(155788645213579399314954)),
        (814972850484755067944i128, 96736506339188206113i128, Some(78837626317184790725417)),
        (614281173101062221488i128, 403525062943035093511i128, Some(247877849040327568709209)),
        (340320922844352277793i128, 91868010949655182589i128, Some(31264606266261711622420)),
        (489058839889633185553i128, 401348410590161990869i128, Some(196282988074772793106280)),
        (589064862982749058390i128, 886875560631283495377i128, Some(522427230606015767206627)),
        (932907666524625309051i128, 384030836146294444120i128, Some(358265311222740280511120)),
        (418654305316653646403i128, 691691563534093164494i128, Some(289579651024755773365749)),
        (82202479323338841310i128, 820402309883385003394i128, Some(67439103915008380476151)),
        (56539270209784373531i128, 363428381242310869520i128, Some(20547975448963544958029)),
        (531670670213447520052i128, 455941307313910661296i128, Some(242410620437582322946808)),
        (418162835230683370121i128, 552307481536635514632i128, Some(230954462398477814344114)),
    ];

    #[test]
    fn matches_exact_arithmetic() {
        for &(a, b, want) in CASES {
            let got = wad_mul(a, b).ok();
            assert_eq!(got, want, "wad_mul({a}, {b})");
        }
    }

    #[test]
    fn is_sign_symmetric_across_the_boundary() {
        // The sign is applied after the magnitude, so a wrap in the magnitude
        // shows up identically on both signs. Pinning this keeps a future
        // "fix" from special-casing negatives.
        for &(a, b, want) in CASES {
            assert_eq!(wad_mul(-a, b).ok(), want.map(|v| -v), "wad_mul(-{a}, {b})");
            assert_eq!(wad_mul(-a, -b).ok(), want, "wad_mul(-{a}, -{b})");
        }
    }

    #[test]
    fn agrees_with_naive_multiplication_when_it_cannot_overflow() {
        // Below the boundary the schoolbook path and a plain i128 multiply
        // must agree exactly. This is the half of the domain the old code got
        // right, so it guards the fix against regressing the easy cases.
        for a in [1i128, 7, 1_000, WAD, 3 * WAD, 999_999] {
            for b in [1i128, 2, WAD, WAD / 3, 12_345_678] {
                assert_eq!(wad_mul(a, b).unwrap(), a * b / WAD, "wad_mul({a}, {b})");
            }
        }
    }

    #[test]
    fn reports_overflow_instead_of_wrapping() {
        // A quotient that genuinely exceeds i128 must be an error. Before the
        // fix the same input class silently wrapped, which is strictly worse
        // than failing: the caller cannot tell.
        assert_eq!(wad_mul(i128::MAX, i128::MAX), Err(MathError::Overflow));
        assert_eq!(wad_mul(i128::MAX, 2 * WAD), Err(MathError::Overflow));
    }
}
