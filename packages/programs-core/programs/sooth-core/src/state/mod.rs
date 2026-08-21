//! Account types owned by `sooth_core`.

pub mod adjudicator;
pub mod amm_state;
pub mod lifecycle;
pub mod lock_entry;
pub mod lp_position;
pub mod market;
pub mod market_fee_pool;
pub mod position;
pub mod protocol_config;

pub use adjudicator::{AdjudicatorEntry, ADJUDICATOR_ENTRY_SEED};
pub use amm_state::AmmState;
pub use lifecycle::MarketLifecycle;
pub use lock_entry::LockEntry;
pub use lp_position::LpPosition;
pub use market::Market;
pub use market::OUTCOME_INVALID;
pub use market::OUTCOME_NO;
pub use market::OUTCOME_YES;
pub use position::Position;
pub use protocol_config::{require_not_paused, ProtocolConfig, MAX_FEE_BPS, PROTOCOL_CONFIG_SEED};
