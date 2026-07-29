//! Account types owned by `sooth_core`.

pub mod adjudicator;
pub mod amm_state;
pub mod book_side;
pub mod legacy_fee_drain_marker;
pub mod lifecycle;
pub mod lock_entry;
pub mod lp_position;
pub mod market;
pub mod market_book;
pub mod market_fee_pool;
pub mod order_id;
pub mod orderbook_position;
pub mod position;
pub mod protocol_config;

pub use adjudicator::{AdjudicatorEntry, ADJUDICATOR_ENTRY_SEED};
pub use amm_state::AmmState;
pub use book_side::{BookSide, InlineOrder, MAX_ORDERS_PER_TICK, SIDE_AGAINST, SIDE_FOR};
pub use book_side::{BOOK_SIDE_HEADER_SPACE, INLINE_ORDER_SPACE};
pub use legacy_fee_drain_marker::LegacyFeeDrainMarker;
pub use lifecycle::MarketLifecycle;
pub use lock_entry::LockEntry;
pub use lp_position::LpPosition;
pub use market::Market;
pub use market::OUTCOME_INVALID;
pub use market::OUTCOME_NO;
pub use market::OUTCOME_YES;
pub use market_book::MarketBook;
pub use order_id::{encode_order_id, require_order_id_matches};
pub use orderbook_position::OrderbookPosition;
pub use position::Position;
pub use protocol_config::{
    require_not_paused, ProtocolConfig, MAX_FEE_BPS, PROTOCOL_CONFIG_SEED,
};
