//! Events emitted by `sooth_core`.
//!
//! Solana logs are best-effort (architecture §3); indexers must subscribe
//! live or rely on the Geyser/webhook pipeline.

use anchor_lang::prelude::*;

/// Mirror of EVM `OrderEngine.Minted` (`OrderEngine.sol:124`).
#[event]
pub struct CompleteSetMinted {
    pub market: Pubkey,
    pub user: Pubkey,
    /// USDC base units pulled from user.
    pub amount_usdc: u64,
    pub ts: i64,
}

/// Mirror of EVM `OrderEngine.Merged` (`OrderEngine.sol:125`).
#[event]
pub struct CompleteSetMerged {
    pub market: Pubkey,
    pub user: Pubkey,
    /// USDC base units returned to user.
    pub amount_usdc: u64,
    pub ts: i64,
}

/// Mirror of EVM `TruthMarket.MarketResolved` (LIVE → RESOLVING). Renamed to
/// "Locked" to match Solana lifecycle names — the semantic intent is the same:
/// trading halts pending adjudicator outcome. See `state/lifecycle.rs`.
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
    pub market: Pubkey,
    pub creator: Pubkey,
    pub adjudicator: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    /// Initial LMSR liquidity `b` in WAD. Stored on `AmmState` after ix4.
    pub initial_b: u128,
    pub start_time: i64,
    pub deadline: i64,
    pub ts: i64,
}

/// Mirror of EVM `FeeRouter.FeesDistributed`. Emitted by `distribute_fees`
/// when the accumulator drains to the four destinations (architecture §8).
#[event]
pub struct FeesCollected {
    pub market: Pubkey,
    /// Total fees moved out of `AmmState.fee_b_base_wad` in this call (WAD).
    pub total_wad: u128,
    /// Slice routed to the bBase LP-yield ATA.
    pub to_b_base: u64,
    pub to_lp_yield: u64,
    pub to_adjudicator: u64,
    pub to_protocol: u64,
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
    pub fee_bps: u16,
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
    pub usdc_paid: u64,
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

// ── Orderbook (CLOB) ─────────────────────────────────────────────────────────

#[event]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub maker: Pubkey,
    pub amount: u128,
    pub escrow: bool,
    pub order_id: u64,
}

/// One maker fill inside a `buy`. Ticks are recorded as (yes, no) rather than
/// (taker, maker) so a consumer never has to know which side the taker was on
/// to price the trade.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct FillRecord {
    pub maker: Pubkey,
    pub maker_order_id: u64,
    pub yes_tick: u16,
    pub no_tick: u16,
    pub amount: u128,
    /// Rebate to the taker when yes_tick + no_tick > NUM_TICKS.
    pub surplus: u128,
    pub ts: i64,
}

/// All fills from one `buy`, batched into a single event.
///
/// Batched deliberately: the P0.1 spike showed per-fill emission OOMs the
/// 32 KB heap. Emitted by `invoke`ing `sooth_log`, not `emit!`/`emit_cpi!` —
/// see that program's docs for why. Consumers must verify this arrives as a
/// direct inner instruction of a successful `sooth_core::buy`; `sooth_log`
/// itself is permissionless.
#[event]
pub struct OrdersFilled {
    pub market: Pubkey,
    pub taker: Pubkey,
    pub taker_side: u8,
    pub fills: Vec<FillRecord>,
}

#[event]
pub struct OrderCancelled {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub maker: Pubkey,
    pub order_id: u64,
}

#[event]
pub struct DustOrderSkipped {
    pub market: Pubkey,
    pub side: u8,
    pub tick: u16,
    pub user: Pubkey,
    pub amount: u128,
    pub escrow: bool,
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
