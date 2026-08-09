//! Events emitted by `sooth_core`.
//!
//! Solana logs are best-effort (architecture §3); indexers must subscribe
//! live or rely on the Geyser/webhook pipeline.

use anchor_lang::prelude::*;

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
/// 32 KB heap. Emitted with `emit_cpi!` (a self-CPI), not `emit!` —
/// see that program's docs for why. Consumers must verify this arrives as a
/// direct inner instruction of a successful `sooth_core::buy`; the event
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
    /// Unfilled amount at the moment of cancellation. An indexer cannot
    /// reconstruct this after the fact: `cancel` zeroes the order in place, so
    /// the size that was withdrawn is gone from state. Ported from main
    /// (a1f3964).
    pub remaining: u128,
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

// ── Redesigned orderbook events ──────────────────────────────────────────
//
// Every one carries a `version` as its FIRST field. The existing book's events
// have none, and the consequences are live: `sooth-data`'s decoder throws on
// trailing bytes, so adding a single field to `FillRecord` takes down
// `GET /v12/fills` with a 500 — while a *renamed* event returns an empty list
// with HTTP 200, which is silent data loss. A version byte lets a consumer
// branch instead of guess.
//
// These are emitted with `emit_cpi!` rather than `emit!`, so the payload lands
// in an inner instruction rather than a program log. Program logs are truncated
// and not reliably retrievable from every RPC; an inner instruction is real
// transaction data. That is what the now-deleted `sooth_log` provided —
// see `book_place` for why it is no longer needed.

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
/// produce 20 inner instructions, and the per-event overhead would show up in
/// exactly the marginal cost this redesign exists to shrink.
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
