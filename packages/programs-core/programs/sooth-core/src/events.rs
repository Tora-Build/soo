//! Events emitted by `sooth_core`.
//!
//! Solana logs are best-effort (architecture §3); indexers must subscribe
//! live or rely on the Geyser/webhook pipeline.

use anchor_lang::prelude::*;

/// Emitted on the LIVE → RESOLVING transition: trading halts pending the
/// adjudicator outcome. Counterpart of EVM `TruthMarket.MarketResolved`.
/// See `state/lifecycle.rs`.
#[event]
pub struct MarketLocked {
    pub market: Pubkey,
    pub ts: i64,
}

/// Mirror of EVM `TruthMarket.MarketSettled` (`TruthMarket.sol:130`).
#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    /// 0=NO, 1=YES, 2=INVALID per protocol-wide OUTCOME encoding.
    pub winning_outcome: u8,
    pub ts: i64,
}

/// Mirror of EVM `OrderEngine.PositionSettled` (`OrderEngine.sol:430`).
/// Emitted by `redeem` after a successful post-settlement burn-and-pay.
#[event]
pub struct Redeemed {
    pub user: Pubkey,
    pub market: Pubkey,
    /// Resolved outcome at the time of redeem, copied from
    /// `Market::winning_outcome`. 0=NO, 1=YES, 2=INVALID.
    pub outcome: u8,
    /// YES outcome-token base units burned (0 if user held none, or if
    /// outcome=NO).
    pub yes_burned: u64,
    /// NO outcome-token base units burned (0 if user held none, or if
    /// outcome=YES).
    pub no_burned: u64,
    /// USDC base units transferred from vault to user.
    pub usdc_paid: u64,
    pub ts: i64,
}

#[event]
pub struct RefundClaimed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub amount_usdc: u64,
}

// ── AMM ──────────────────────────────────────────────────────────────────────

#[event]
pub struct PositionTraded {
    pub market: Pubkey,
    pub user: Pubkey,
    /// 0 = NO, 1 = YES (matches protocol-wide OUTCOME encoding).
    pub outcome: u8,
    /// Signed share delta in WAD. Positive = buy; negative = sell.
    pub delta_shares: i128,
    /// Signed cost in WAD. Positive = paid; negative = proceeds (sell).
    pub cost_wad: i128,
    /// Unix timestamp from `Clock`.
    pub ts: i64,
}

#[event]
pub struct MarketGraduated {
    pub market: Pubkey,
    pub fees_accumulated_wad: u128,
    pub threshold_wad: u128,
}

#[event]
pub struct MarketDismissed {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub dismissed_at: i64,
}

/// Emitted on the sell branch of `trade_positions` after the proceeds have
/// been moved into the per-sell `LockEntry` PDA. Mirrors the EVM
/// `ProceedsLocked` event (`AMMEngine.sol:1011-1013`).
#[event]
pub struct PositionSold {
    pub market: Pubkey,
    pub user: Pubkey,
    /// 0 = NO, 1 = YES.
    pub outcome: u8,
    /// Absolute share count sold (positive). Matches `|delta_shares|`.
    pub shares_sold: u128,
    /// Lock account that escrows the USDC proceeds. The corresponding
    /// `claim_unlocked` ix takes this pubkey as input.
    pub lock_entry: Pubkey,
    /// USDC base units escrowed (matches `lock_entry.amount_usdc`).
    pub amount_usdc: u64,
    /// Unix timestamp at which `claim_unlocked` becomes callable.
    pub unlock_at: i64,
}

/// Emitted by `claim_unlocked` after a successful payout. Mirrors the EVM
/// `LocksProcessed`/`LockEntryRemoved` event family
/// (`AMMEngine.sol:392-407`).
#[event]
pub struct LockClaimed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub lock_entry: Pubkey,
    pub amount_usdc: u64,
    pub ts: i64,
}

// ── Market creation / LP ─────────────────────────────────────────────────────

/// Mirror of EVM `LaunchpadEngine.MarketCreated`. Emitted by `create_market`
/// after the four instruction legs land (architecture §4.1).
#[event]
pub struct MarketCreated {
    /// The question in full — the ONLY place it exists on chain.
    ///
    /// `Market` stores just `question_hash`, so without this a client has no
    /// way to render what a market asked short of running an indexer that
    /// captured it off-chain at creation time. `create_market` proves this
    /// text hashes to the stored hash before emitting.
    pub question: String,
    pub market: Pubkey,
    pub creator: Pubkey,
    pub adjudicator: Pubkey,
    pub vault_book: Pubkey,
    pub vault_amm: Pubkey,
    /// Initial LMSR liquidity `b` in WAD. Stored on `AmmState` after ix4.
    pub initial_b: u128,
    pub start_time: i64,
    pub deadline: i64,
    pub ts: i64,
}

/// Per-market fee distribution event emitted by `distribute_fees(market)`.
#[event]
pub struct MarketFeesDistributed {
    pub market: Pubkey,
    pub market_id: [u8; 16],
    pub total_usdc: u64,
    pub to_b_base: u64,
    pub to_lp_yield: u64,
    pub to_adjudicator: u64,
    pub to_protocol: u64,
    pub ts: i64,
}

/// Emitted once per protocol deploy by `initialize_protocol`. Indexers can
/// pin the cluster's authority + treasury without re-reading the PDA.
#[event]
pub struct ProtocolInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub amm_fee_bps: u16,
    pub book_fee_bps: u16,
    pub ts: i64,
}

/// Emitted by `seed_lp` after the per-market `LpMint` + creator
/// `LpPosition` PDA + creator's LP ATA are bootstrapped and seeded
/// with the initial `lp_amount` allocation.
#[event]
pub struct LpSeeded {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub lp_mint: Pubkey,
    pub creator_lp_ata: Pubkey,
    pub lp_amount: u64,
    pub seed_deposit_wad: u128,
    pub ts: i64,
}

#[event]
pub struct LpRedeemed {
    pub user: Pubkey,
    pub lp_burned: u64,
    /// AMM-venue yield paid, in the AMM token.
    pub usdc_paid: u64,
    /// Book-venue yield paid, in the book's token (USDC).
    pub book_paid: u64,
}

// ── Adjudicator / resolution ─────────────────────────────────────────────────

/// Emitted by `register_adjudicator` when a new per-market `AdjudicatorEntry`
/// PDA is created. Mirrors EVM `AdjudicatorBase.MarketConfigured`.
#[event]
pub struct AdjudicatorRegistered {
    pub market: Pubkey,
    pub adjudicator_entry: Pubkey,
    pub authority: Pubkey,
    pub ts: i64,
}

/// Emitted by `attest_outcome` when the per-market authority signs the
/// resolution. Mirrors EVM `AdjudicatorBase.OutcomeAttested`.
#[event]
pub struct OutcomeAttested {
    pub market: Pubkey,
    pub adjudicator_entry: Pubkey,
    /// 0=NO, 1=YES, 2=INVALID per protocol-wide OUTCOME encoding.
    pub winning_outcome: u8,
    pub ts: i64,
}

/// Emitted by `dispute` when the `dispute_authority` overrides an attested
/// outcome. Mirrors EVM `AdjudicatorBase.MarketDisputed`.
#[event]
pub struct DisputeRaised {
    pub market: Pubkey,
    pub adjudicator_entry: Pubkey,
    pub disputer: Pubkey,
    pub previous_outcome: u8,
    pub new_outcome: u8,
    pub ts: i64,
}

/// Emitted by `register_zk_adjudicator`. Carries the full zk configuration so
/// an indexer can reproduce the verification off-chain without re-reading the
/// account.
#[event]
pub struct ZkAdjudicatorRegistered {
    pub market: Pubkey,
    pub adjudicator_entry: Pubkey,
    pub authority: Pubkey,
    pub attestor_evm: [u8; 20],
    pub rule_hash: [u8; 32],
    pub comparator: u8,
    pub threshold: i64,
    pub value_scale: u8,
    pub ts: i64,
}

/// Emitted by `attest_outcome_zk` alongside `OutcomeAttested`.
///
/// `OutcomeAttested` is still emitted, so consumers that only track outcomes
/// need no change; this carries the evidence — the recovered signer and the
/// value that was compared — for anyone auditing why the outcome is what it
/// is during the veto window.
#[event]
pub struct ZkOutcomeAttested {
    pub market: Pubkey,
    pub adjudicator_entry: Pubkey,
    /// The EVM address recovered from the signature, not the one supplied.
    pub attestor_evm: [u8; 20],
    /// Attested value in `10^value_scale` units.
    pub value: i128,
    pub threshold: i64,
    pub comparator: u8,
    /// 0=NO, 1=YES.
    pub winning_outcome: u8,
    /// The attestation's own timestamp, normalized to unix seconds.
    pub attestation_ts: i64,
    pub ts: i64,
}

// ── Protocol / circuit-breaker ───────────────────────────────────────────────

/// Emitted by `pause` and `unpause`. `paused = true` means the protocol was
/// just paused; `paused = false` means it was just unpaused.
#[event]
pub struct ProtocolPausedEvent {
    pub authority: Pubkey,
    pub paused: bool,
    pub ts: i64,
}

// ── Versioned book events ────────────────────────────────────────────────
//
// Every one carries a `version` as its FIRST field. `sooth-data`'s decoder
// throws on trailing bytes, so an unversioned layout change either takes an
// endpoint down with a 500 or — worse, for a renamed event — returns an empty
// list with HTTP 200, which is silent data loss. A version byte lets a
// consumer branch instead of guess.
//
// These are emitted with `emit_cpi!` rather than `emit!`, so the payload lands
// in an inner instruction rather than a program log. Program logs are truncated
// and not reliably retrievable from every RPC; an inner instruction is real
// transaction data.

/// Bump when any book event's layout changes. Consumers should reject a
/// version they do not know rather than mis-parse it.
pub const BOOK_EVENT_VERSION: u8 = 1;

#[event]
pub struct BookOrderPlaced {
    pub version: u8,
    pub market: Pubkey,
    /// Monotonic per-market sequence — the id `book_cancel` takes.
    pub seq: u64,
    pub trader: Pubkey,
    /// 0 = bid (buy YES), 1 = ask (sell YES, i.e. buy NO at 1 - p).
    pub side: u8,
    pub price_tick: u16,
    /// Resting size in USDC base units.
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct BookOrderCancelled {
    pub version: u8,
    pub market: Pubkey,
    pub seq: u64,
    pub trader: Pubkey,
    /// Escrow returned to the owner's seat credit.
    pub refund: u64,
    pub ts: i64,
}

/// One fill inside a [`BookFilled`] batch.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BookFill {
    pub maker: Pubkey,
    pub maker_seq: u64,
    /// Execution price — the MAKER's tick, not the taker's limit. The
    /// difference is the taker's price improvement.
    pub price_tick: u16,
    pub amount: u64,
}

/// All fills from one `book_place`, batched into a single event.
///
/// Batched rather than emitted per fill because a 20-fill cross would otherwise
/// produce 20 inner instructions, and per-event overhead would dominate the
/// marginal cost of a fill.
#[event]
pub struct BookFilled {
    pub version: u8,
    pub market: Pubkey,
    pub taker: Pubkey,
    pub taker_side: u8,
    pub fills: Vec<BookFill>,
    /// Total protocol fee paid by the taker, USDC base units.
    pub fee: u64,
    pub ts: i64,
}

#[event]
pub struct ResidualSwept {
    pub market: Pubkey,
    pub market_id: [u8; 16],
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct MarketClosed {
    pub market: Pubkey,
    pub market_id: [u8; 16],
    pub creator: Pubkey,
    pub market_rent_reclaimed: u64,
    pub book_rent_reclaimed: u64,
    pub ts: i64,
}

// ── T* voiding ───────────────────────────────────────────────────────────────

/// Emitted by `publish_resolution_commitment`. Carries every field an
/// observer needs to reproduce the commitment from the market's public event
/// tape and compare roots inside the veto window — which is the mechanism's
/// entire enforcement. See `docs/design/t-star-voiding.md`.
#[event]
pub struct ResolutionCommitmentPublished {
    pub market: Pubkey,
    pub publisher: Pubkey,
    /// Root over one leaf per wallet.
    pub merkle_root: [u8; 32],
    /// The moment the market's event became public knowledge.
    pub t_star: i64,
    pub leaf_count: u32,
    /// Ceiling on the USDC the AMM void path may pay across every leaf.
    pub total_void_refund_usdc: u64,
    /// The same ceiling for the book venue.
    pub total_book_void_refund_usdc: u64,
    pub ts: i64,
}

/// Emitted by `revoke_resolution_commitment`. The market redeems as if the
/// commitment had never been published.
#[event]
pub struct ResolutionCommitmentRevoked {
    pub market: Pubkey,
    pub dispute_authority: Pubkey,
    /// The root being withdrawn, so the reason for the veto stays legible in
    /// the log after the account is gone.
    pub merkle_root: [u8; 32],
    pub ts: i64,
}

/// Emitted by `redeem_amm_position` when the payout came from a published
/// entitlement rather than from the raw position. `Redeemed` still fires
/// alongside it with the shares burned and the USDC paid, so consumers that
/// only track payouts need no change.
#[event]
pub struct VoidedRedeem {
    pub market: Pubkey,
    pub user: Pubkey,
    /// Shares acquired at or before T* and still held — the part that settled.
    pub valid_yes_wad: u128,
    pub valid_no_wad: u128,
    /// USDC returned at cost for post-T* acquisitions.
    pub void_refund_usdc: u64,
    /// Shares the position held in total. The difference against the two
    /// valid legs is what was voided.
    pub held_yes_wad: u128,
    pub held_no_wad: u128,
    pub ts: i64,
}

/// Emitted by `redeem_book_seat` when the payout came from a published
/// entitlement rather than from the raw seat. `Redeemed` still fires alongside
/// it, so consumers that only track payouts need no change.
#[event]
pub struct VoidedBookRedeem {
    pub market: Pubkey,
    pub user: Pubkey,
    /// Signed net acquired at or before T* — the part that settled.
    pub valid_net: i64,
    /// USDC returned at cost for post-T* fills.
    pub book_void_refund_usdc: u64,
    /// The seat's whole net. The difference against `valid_net` is what was
    /// voided.
    pub held_net: i64,
    pub ts: i64,
}

/// Emitted by `force_invalid_attestation`: a market whose adjudicator never
/// attested has had `INVALID` written onto it by a stranger, so that it can
/// settle at all. The ordinary veto window runs from `ts`, and the outcome is
/// still overridable inside it — by the authority attesting over it, or by the
/// dispute authority correcting it.
#[event]
pub struct InvalidAttestationForced {
    pub market: Pubkey,
    pub adjudicator_entry: Pubkey,
    /// Whoever cranked it. Unprivileged by construction.
    pub cranker: Pubkey,
    /// The deadline the timeout was measured from, so the log carries the
    /// whole justification without a second account read.
    pub deadline: i64,
    pub ts: i64,
}

/// Emitted by `sweep_lp_yield`. The LP supply that would have claimed this
/// yield no longer exists, so the remainder went to the treasury and the
/// market can reach the all-zero balances `close_market` requires.
#[event]
pub struct LpYieldSwept {
    pub market: Pubkey,
    pub market_id: [u8; 16],
    /// AMM-token remainder moved out of `lp_yield_amm`.
    pub amm_amount: u64,
    /// Book-token remainder moved out of `lp_yield_book`.
    pub book_amount: u64,
    pub ts: i64,
}

/// Emitted by `update_protocol_config`. Carries the WHOLE resulting config
/// rather than the fields that moved: the instruction is sparse, so a log of
/// only the deltas cannot be read without also knowing what was there before,
/// and an audit trail that needs a second source is not one.
#[event]
pub struct ProtocolConfigUpdated {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub amm_fee_bps: u16,
    pub book_fee_bps: u16,
    pub graduation_bps: u16,
    pub b_base_share_bps: u16,
    pub lp_yield_share_bps: u16,
    pub adjudicator_share_bps: u16,
    pub protocol_share_bps: u16,
    pub default_trial_period: i64,
    pub veto_period_secs: i64,
    pub permissionless_adjudicators: bool,
    pub ts: i64,
}

/// Emitted by `transfer_authority`: a handover has been NOMINATED and nothing
/// has moved yet. `pending_authority` is the default pubkey when the call
/// withdrew a nomination instead of making one.
#[event]
pub struct AuthorityTransferStarted {
    /// The outgoing authority, which still holds the seat at this point.
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub ts: i64,
}

/// Emitted by `accept_authority`: the nominee signed and the seat has moved.
#[event]
pub struct AuthorityTransferAccepted {
    pub previous_authority: Pubkey,
    pub authority: Pubkey,
    pub ts: i64,
}

/// Emitted by `force_invalid_attestation` when the market had NO
/// `AdjudicatorEntry` at all and the hatch created one to write into.
///
/// Separate from `InvalidAttestationForced`, which still fires alongside it:
/// the forced outcome means the same thing either way, and this says only
/// that the market was orphaned rather than merely abandoned. The created
/// entry's `authority` and `dispute_authority` are both the default pubkey —
/// nobody gains a resolution right from it.
#[event]
pub struct AdjudicatorEntryForceCreated {
    pub market: Pubkey,
    pub adjudicator_entry: Pubkey,
    /// Whoever cranked it, and paid the entry's rent. Unprivileged by
    /// construction — the entry it created names no authority.
    pub cranker: Pubkey,
    pub ts: i64,
}

/// Emitted by `opt_propose` — a bonded assertion of the outcome.
#[event]
pub struct OutcomeProposed {
    pub market: Pubkey,
    pub proposer: Pubkey,
    pub outcome: u8,
    pub bond: u64,
    pub ts: i64,
}

/// Emitted by `opt_challenge` — a matching counter-bond, escalating to the
/// market's designated adjudicator.
#[event]
pub struct ProposalChallenged {
    pub market: Pubkey,
    pub challenger: Pubkey,
    pub bond: u64,
    pub ts: i64,
}

/// Emitted by `opt_finalize` — the unchallenged assertion settled the market
/// and the bond went home.
#[event]
pub struct ProposalFinalized {
    pub market: Pubkey,
    pub outcome: u8,
    pub ts: i64,
}

/// Emitted by `opt_arbitrate` — the ruling, and who took the pot. The loser
/// is recoverable from the proposal account; the WINNER is what reputation
/// and history readers need without a second fetch.
#[event]
pub struct ChallengeArbitrated {
    pub market: Pubkey,
    pub arbiter: Pubkey,
    pub outcome: u8,
    pub winner: Pubkey,
    pub pot: u64,
    pub ts: i64,
}
