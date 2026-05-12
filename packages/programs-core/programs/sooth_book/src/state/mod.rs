pub mod book_side;
pub mod market_book;
pub mod order_id;

pub use book_side::*;
pub use market_book::*;
pub use order_id::*;

pub const SIDE_AGAINST: u8 = 0;
pub const SIDE_FOR: u8 = 1;
