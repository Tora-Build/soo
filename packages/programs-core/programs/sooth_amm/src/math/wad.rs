//! WAD (1e18) fixed-point primitives, ported from `_spikes/lmsr-cu/src/math.rs`.
//!
//! Two operations carry a 256-bit intermediate via paired u128 limbs (the
//! spike's hand-roll, kept verbatim — no `ethnum` dep). See spike's module
//! comment for the precision rationale.

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
/// 64-bit limbs; rounding toward zero. Lifted verbatim from the spike.
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
    let (mid, carry1) = lh.overflowing_add(hl);
    let prod_lo_hi = ll >> 64;
    let mid_lo = mid & ((1u128 << 64) - 1);
    let mid_hi = mid >> 64;
    let (sum, carry2) = prod_lo_hi.overflowing_add(mid_lo << 64);
    let _ = sum;
    let prod_hi = hh
        .wrapping_add(mid_hi)
        .wrapping_add((carry1 as u128) << 64)
        .wrapping_add(carry2 as u128);

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

/// Divide two WAD numbers: (a * WAD) / b. Spike's verbatim port.
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
/// the vault rather than the trader. The mirror op `wad_to_usdc_floor` (used
/// at redemption) lives in `sooth_market` once that program exists.
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
