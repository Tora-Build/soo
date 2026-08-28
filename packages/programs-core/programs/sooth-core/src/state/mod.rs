//! Account types owned by `sooth_core`.

pub mod adjudicator;
pub mod amm_state;
pub mod lifecycle;
pub mod lock_entry;
pub mod lp_position;
pub mod market;
pub mod market_fee_pool;
mod attestors;
mod guardians;
mod optimistic;
pub mod position;
pub mod protocol_config;
pub mod resolution;

pub use adjudicator::{AdjudicatorEntry, ADJUDICATOR_ENTRY_SEED};
pub use amm_state::{require_seeded, AmmState};
pub use lifecycle::MarketLifecycle;
pub use lock_entry::LockEntry;
pub use lp_position::LpPosition;
pub use market::Market;
pub use market::OUTCOME_INVALID;
pub use market::OUTCOME_NO;
pub use market::OUTCOME_YES;
pub use attestors::{AttestorSet, AttestorSetError, ATTESTOR_SET_SEED, MAX_ATTESTORS, NO_VOTE};
pub use guardians::{GuardianSet, GuardianSetError, GUARDIAN_SET_SEED, MAX_GUARDIANS};
pub use optimistic::{
    OptimisticProposal, OPT_BOND_AUTHORITY_SEED, OPT_BOND_VAULT_SEED,
    OPT_CHALLENGE_WINDOW_SECS, OPT_MIN_BOND, OPT_PROPOSAL_SEED,
};
pub use position::Position;
pub use protocol_config::{require_not_paused, ProtocolConfig, MAX_FEE_BPS, PROTOCOL_CONFIG_SEED};
pub use resolution::{voided_leaf, ResolutionCommitment, RESOLUTION_COMMITMENT_SEED};
