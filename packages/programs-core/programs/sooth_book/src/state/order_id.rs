use anchor_lang::prelude::*;

use crate::error::CoreError;
use crate::math::{MAX_TICK, MIN_TICK};

const SEQ_BITS: u64 = 40;
const SEQ_MASK: u64 = (1u64 << SEQ_BITS) - 1;

pub fn encode_order_id(side: u8, tick: u16, seq: u64) -> u64 {
    debug_assert!(seq < (1u64 << SEQ_BITS));
    debug_assert!((MIN_TICK..=MAX_TICK).contains(&tick));
    debug_assert!(side <= 1);
    (seq & SEQ_MASK) | ((tick as u64) << 40) | ((side as u64) << 56)
}

pub fn decode_order_id(id: u64) -> Result<(u8, u16, u64)> {
    let seq = id & SEQ_MASK;
    let tick = ((id >> 40) & 0xFFFF) as u16;
    let side = ((id >> 56) & 0xFF) as u8;
    require!(side <= 1, CoreError::InvalidOrderId);
    require!(
        (MIN_TICK..=MAX_TICK).contains(&tick),
        CoreError::InvalidOrderId
    );
    Ok((side, tick, seq))
}

pub fn require_order_id_matches(order_id: u64, side: u8, tick: u16) -> Result<()> {
    let (decoded_side, decoded_tick, _seq) = decode_order_id(order_id)?;
    require!(
        decoded_side == side && decoded_tick == tick,
        CoreError::OrderIdSeedMismatch
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{SIDE_AGAINST, SIDE_FOR};

    #[test]
    fn order_id_round_trips_valid_side_tick_and_seq_cases() {
        let seqs = [0, 1, 1u64 << 20, 1u64 << 39, (1u64 << 40) - 1];

        for side in [SIDE_AGAINST, SIDE_FOR] {
            for tick in MIN_TICK..=MAX_TICK {
                for seq in seqs {
                    let id = encode_order_id(side, tick, seq);
                    assert_eq!(decode_order_id(id).unwrap(), (side, tick, seq));
                }
            }
        }
    }

    #[test]
    fn order_id_rejects_invalid_tick_and_side() {
        let tick_zero = 0u64;
        let tick_too_high = (1000u64 << 40) | 1;
        let side_too_high = (2u64 << 56) | (1u64 << 40);

        assert!(decode_order_id(tick_zero).is_err());
        assert!(decode_order_id(tick_too_high).is_err());
        assert!(decode_order_id(side_too_high).is_err());
    }

    #[cfg(debug_assertions)]
    #[test]
    #[should_panic]
    fn encode_order_id_debug_asserts_on_sequence_overflow() {
        encode_order_id(SIDE_FOR, MIN_TICK, 1u64 << 40);
    }
}
