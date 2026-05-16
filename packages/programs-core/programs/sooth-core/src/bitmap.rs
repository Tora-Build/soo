//! `TickBitmap` — 1000-tick bitset for the CLOB orderbook.
//!
//! Pure math, no program dependencies.

use crate::math::book::{MAX_TICK, MIN_TICK};

#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TickBitmap([u64; 16]);

impl TickBitmap {
    pub fn from_words(words: &[u64; 16]) -> &Self {
        // `TickBitmap` is repr(transparent) over the exact same array type.
        unsafe { &*(words as *const [u64; 16] as *const Self) }
    }

    pub fn from_words_mut(words: &mut [u64; 16]) -> &mut Self {
        // `TickBitmap` is repr(transparent) over the exact same array type.
        unsafe { &mut *(words as *mut [u64; 16] as *mut Self) }
    }

    pub fn set_bit(&mut self, tick: u16) {
        assert_valid_tick(tick);
        let (word_index, bit_index) = word_and_bit(tick);
        self.0[word_index] |= 1u64 << bit_index;
    }

    pub fn clear_bit(&mut self, tick: u16) {
        assert_valid_tick(tick);
        let (word_index, bit_index) = word_and_bit(tick);
        self.0[word_index] &= !(1u64 << bit_index);
    }

    pub fn is_set(&self, tick: u16) -> bool {
        assert_valid_tick(tick);
        let (word_index, bit_index) = word_and_bit(tick);
        (self.0[word_index] & (1u64 << bit_index)) != 0
    }

    pub fn find_next_down(&self, start: u16) -> u16 {
        if start <= MIN_TICK {
            return 0;
        }

        let search_tick = start.saturating_sub(1).min(MAX_TICK);
        let (word_index, bit_index) = word_and_bit(search_tick);
        let mut word = self.0[word_index] & mask_lte(bit_index);

        if word != 0 {
            return tick_from_word_bit(word_index, most_significant_bit(word));
        }

        for previous_word_index in (0..word_index).rev() {
            word = self.0[previous_word_index];
            if word != 0 {
                let tick = tick_from_word_bit(previous_word_index, most_significant_bit(word));
                if tick >= MIN_TICK {
                    return tick;
                }
            }
        }

        0
    }

    pub fn find_next_up(&self, start: u16) -> u16 {
        if start >= MAX_TICK {
            return MAX_TICK + 1;
        }

        let search_tick = start + 1;
        let (word_index, bit_index) = word_and_bit(search_tick);
        let mut word = self.0[word_index] & mask_gte(bit_index);

        if word != 0 {
            let tick = tick_from_word_bit(word_index, least_significant_bit(word));
            return if tick <= MAX_TICK { tick } else { MAX_TICK + 1 };
        }

        for next_word_index in (word_index + 1)..16 {
            word = self.0[next_word_index];
            if word != 0 {
                let tick = tick_from_word_bit(next_word_index, least_significant_bit(word));
                return if tick <= MAX_TICK { tick } else { MAX_TICK + 1 };
            }
        }

        MAX_TICK + 1
    }
}

fn assert_valid_tick(tick: u16) {
    assert!((MIN_TICK..=MAX_TICK).contains(&tick));
}

fn word_and_bit(tick: u16) -> (usize, u32) {
    ((tick / 64) as usize, (tick % 64) as u32)
}

fn tick_from_word_bit(word_index: usize, bit_index: u32) -> u16 {
    (word_index as u16) * 64 + bit_index as u16
}

fn mask_lte(bit_index: u32) -> u64 {
    if bit_index == 63 {
        u64::MAX
    } else {
        (1u64 << (bit_index + 1)) - 1
    }
}

fn mask_gte(bit_index: u32) -> u64 {
    !((1u64 << bit_index) - 1)
}

fn most_significant_bit(word: u64) -> u32 {
    63 - word.leading_zeros()
}

fn least_significant_bit(word: u64) -> u32 {
    word.trailing_zeros()
}
