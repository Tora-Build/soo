use anchor_lang::prelude::*;

#[account]
pub struct LegacyFeeDrainMarker {
    /// Unix seconds when the legacy global fee pool was drained.
    /// `0` means the one-shot drain has not executed.
    pub drained_at: i64,
    pub bump: u8,
}

impl LegacyFeeDrainMarker {
    pub const SPACE: usize = 8 + 8 + 1;
}
