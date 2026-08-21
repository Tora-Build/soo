//! Book math — the WAD↔base-unit conversion the AMM's settlement paths share.

use anchor_lang::prelude::*;

use crate::error::SoothCoreError;

/// One USDC base unit (6 decimals) expressed in WAD (1e18).
pub const BASE_UNIT_WAD: u128 = 1_000_000_000_000;

/// Truncate a WAD quantity to whole USDC base units. Floors, so a conversion
/// never hands out a unit the WAD amount did not cover.
pub fn wad_to_base(wad: u128) -> Result<u64> {
    (wad / BASE_UNIT_WAD)
        .try_into()
        .map_err(|_| error!(SoothCoreError::MathOverflow))
}
