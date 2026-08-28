//! Bonded optimistic resolution — state.
//!
//! The trust model in one sentence: anyone may assert the outcome by posting
//! a bond; silence for a challenge window makes the assertion final; a
//! matching counter-bond escalates to the market's designated adjudicator,
//! and the loser's bond pays the winner. Being wrong costs money, which is
//! the correctness signal no unbonded adjudication can produce.
//!
//! Eligibility is structural, not flagged: proposals are only accepted while
//! the market has NO `AdjudicatorEntry` account. A market whose creator
//! registered themselves (Adjudicated mode) or committed a zkTLS rule
//! (Automatic mode) owns its resolution path from birth, and an optimistic
//! proposer must not be able to race it. That absence-check is what lets
//! this feature ship without adding a byte to `Market` — the append-only ABI
//! stays intact.
//!
//! One proposal per market, one challenge per proposal. The EVM design's
//! round-ids and re-proposal loops are deliberately out of scope: a wrong
//! unchallenged assertion is the challenge window's failure, and the window
//! is the parameter to tune, not the round count.

use anchor_lang::prelude::*;

pub const OPT_PROPOSAL_SEED: &[u8] = b"opt_proposal";
pub const OPT_BOND_VAULT_SEED: &[u8] = b"opt_vault";
pub const OPT_BOND_AUTHORITY_SEED: &[u8] = b"opt_auth";

/// Devnet-sized so a demo can live through a full cycle; a mainnet
/// deployment tunes this the way `veto_period_secs` is tuned — but as a
/// compile-time constant it is per-deployment, not per-config-account,
/// because `ProtocolConfig` is a fixed-size account and appending to it
/// would strand every deployed instance.
pub const OPT_CHALLENGE_WINDOW_SECS: i64 = 600;

/// 1 USDC (base units). Enough that spam costs real faucet effort, small
/// enough that devnet wallets can play both sides.
pub const OPT_MIN_BOND: u64 = 1_000_000;

#[account]
pub struct OptimisticProposal {
    pub market: Pubkey,
    pub proposer: Pubkey,
    /// 0=NO, 1=YES, 2=INVALID — same vocabulary as `Market.winning_outcome`.
    pub outcome: u8,
    /// Per-side bond in base units. The challenger must match it exactly:
    /// equal stakes make the arbiter's ruling zero-sum and keep the payout
    /// arithmetic below overflow-trivial.
    pub bond: u64,
    pub proposed_at: i64,
    /// `Pubkey::default()` until a challenge lands.
    pub challenger: Pubkey,
    pub challenged_at: i64,
    /// Set once bonds have left the vault (finalized or arbitrated). The
    /// terminal flag is on the PROPOSAL, not inferred from the market,
    /// because a market can settle through another path while a bond is
    /// still owed back.
    pub resolved: bool,
    pub bump: u8,
    pub vault_bump: u8,
    pub auth_bump: u8,
}

impl OptimisticProposal {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 8 + 8 + 32 + 8 + 1 + 1 + 1 + 1;

    pub fn is_challenged(&self) -> bool {
        self.challenger != Pubkey::default()
    }
}
