//! `sooth_core` — the Sooth Protocol program.
//!
//! A single Anchor program covering market lifecycle, the LMSR AMM, the CLOB,
//! LP/launchpad flows, and adjudication. Subsystems call each other as plain
//! Rust functions, not CPIs. Resolution authority is a per-market
//! `AdjudicatorEntry` PDA.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw");

// ── 256 KB bump allocator ────────────────────────────────────────────────
//
// Solana's default allocator hardcodes a 32 KB heap and never frees, so
// allocations accumulate for the whole instruction. This mirrors
// solana_program's own BumpAllocator (down-bumping, never frees) over a
// 256 KB region, the maximum `request_heap_frame` permits. The default
// allocator is suppressed by the `custom-heap` feature.
//
// ── What actually allocates, measured ───────────────────────────────────
//
// `book_place` is the binding path, and the per-fill cost is what makes it
// so. One fill allocates in three places: `MatchResult.filled_orders` grows
// by a `FilledOrder` (and a `Vec` that doubles never gives the old buffer
// back to this allocator), `book_place` collects that into a second `Vec` of
// `BookFill`, and `emit_cpi!` serializes the batched `BookFilled` event and
// builds the self-invocation for it.
//
// Measured on LiteSVM against the built artifact, by reading the allocator's
// own cursor at the end of the handler (the cursor only moves down, so its
// distance from the top IS the high-water mark):
//
//   fills │ heap used │      CU
//   ──────┼───────────┼───────────
//      0  │   2,568 B │    23,744
//      1  │   4,220 B │    38,466
//      5  │   6,004 B │    49,579
//     20  │  14,854 B │    62,412
//     60  │  30,774 B │   125,388
//    120  │  58,494 B │   263,227
//    200  │ 105,694 B │   508,628
//
// ≈2.5 KB fixed (Anchor's `Box<Account<…>>` deserialization plus the token
// CPIs) and ≈516 bytes per fill.
//
// ── Why 256 KB stays ────────────────────────────────────────────────────
//
// Two OTHER limits bound a fill loop before the heap does, and both were
// measured on the same harness:
//
//   - **204 fills**: `emit_cpi!` exceeds the 10,240-byte instruction-data
//     limit ("Invoked an instruction with data that is too large"). 203 fills
//     is therefore the largest `book_place` that can SUCCEED — ≈107 KB.
//   - **≈400 fills**: the 1.4M CU meter runs out (per-fill CU rises with the
//     seat walk, so this is superlinear) — ≈209 KB had it got that far.
//
// So the frame covers the largest succeeding transaction 2.4× over, and still
// covers the CU-bound ceiling of a transaction that is doomed anyway. Cutting
// it to 128 KB would clear today's 107 KB by only ~19%, and would convert a
// legible "instruction data too large" failure into an allocator abort as
// soon as per-fill allocation grows. It buys nothing to spend: the runtime
// charges 8 CU per additional 32 KB of frame, i.e. 56 CU for this one — under
// 3% of a SINGLE fill.
//
// Other allocating paths are far below this and do not bind: `CreateMarketArgs
// .question` and the `MarketCreated` event carry ≤300 bytes (MAX_QUESTION_LEN),
// and `ZkAttestation`'s Borsh `String`/`Vec` fields are bounded by the 1232-byte
// transaction packet before their own MAX_ZK_*_LEN checks ever run.
//
// ⚠️ CALLER CONTRACT: every transaction must prepend
// `ComputeBudgetInstruction::request_heap_frame(256 * 1024)`. The runtime
// only maps the larger region when asked, and this allocator hands out
// addresses from the TOP of that region — so without the frame the very
// first allocation points outside mapped memory and the program aborts with
// "Access violation in heap section". The mapped size cannot be queried at
// runtime, so this cannot be detected and reported nicely.
//
// Because sooth_core is a single merged program, this applies to EVERY
// instruction, not just multi-fill placements. `SolanaChainAdapter` prepends
// the frame on all paths; hand-rolled callers must do the same.
#[cfg(all(feature = "custom-heap", target_os = "solana"))]
#[global_allocator]
static SOOTH_CORE_ALLOC: BumpAllocator256 = BumpAllocator256;

/// Heap size this program's allocator assumes, and therefore the exact value
/// callers must pass to `request_heap_frame`.
pub const SOOTH_CORE_HEAP_LEN: usize = 256 * 1024;

#[cfg(all(feature = "custom-heap", target_os = "solana"))]
struct BumpAllocator256;

#[cfg(all(feature = "custom-heap", target_os = "solana"))]
unsafe impl core::alloc::GlobalAlloc for BumpAllocator256 {
    #[inline]
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        const HEAP_START: usize = 0x3_0000_0000;
        // The first machine word of the region holds the bump cursor.
        let pos_ptr = HEAP_START as *mut usize;
        let mut pos = *pos_ptr;
        if pos == 0 {
            pos = HEAP_START + SOOTH_CORE_HEAP_LEN;
        }
        pos = pos.saturating_sub(layout.size());
        pos &= !(layout.align().wrapping_sub(1));
        // Refuse to hand back the cursor slot itself.
        if pos < HEAP_START + core::mem::size_of::<*mut u8>() {
            return core::ptr::null_mut();
        }
        *pos_ptr = pos;
        pos as *mut u8
    }

    #[inline]
    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}

pub mod book;
pub mod constants;
pub mod error;
pub mod error_resolution;
pub mod events;
pub mod instructions;
pub mod math;
pub mod merkle;
pub mod pda;
pub mod state;
pub mod zk;

pub use instructions::*;

#[program]
pub mod sooth_core {
    use super::*;
    use crate::instructions::attest_outcome;
    use crate::instructions::attest_outcome_zk;
    use crate::instructions::book_init;
    use crate::instructions::book_ops;
    use crate::instructions::book_place;
    use crate::instructions::claim_refund;
    use crate::instructions::claim_unlocked;
    use crate::instructions::create_market;
    use crate::instructions::dismiss_market;
    use crate::instructions::dispute;
    use crate::instructions::distribute_fees;
    use crate::instructions::distribute_fees_book;
    use crate::instructions::init_market_fee_pool;
    use crate::instructions::lock_for_resolution;
    use crate::instructions::pause;
    use crate::instructions::publish_resolution;
    use crate::instructions::reclaim_subsidy;
    use crate::instructions::redeem_amm_position;
    use crate::instructions::redeem_lp;
    use crate::instructions::register_adjudicator;
    use crate::instructions::register_zk_adjudicator;
    use crate::instructions::request_lock;
    use crate::instructions::seed_lp;
    use crate::instructions::sell_positions;
    use crate::instructions::settle;
    use crate::instructions::trade_positions;
    use crate::instructions::unpause;

    // ── Protocol lifecycle ────────────────────────────────────────────────────

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeProtocolArgs,
    ) -> Result<()> {
        initialize_protocol::handler(ctx, args)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        pause::handler(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        unpause::handler(ctx)
    }

    // ── Market creation ───────────────────────────────────────────────────────

    pub fn create_market(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        create_market::handler(ctx, args)
    }

    // ── Fee infrastructure ────────────────────────────────────────────────────

    pub fn init_market_fee_pool(ctx: Context<InitMarketFeePool>) -> Result<()> {
        init_market_fee_pool::handler(ctx)
    }

    pub fn distribute_fees_amm(ctx: Context<DistributeFeesAmm>) -> Result<()> {
        distribute_fees::handler(ctx)
    }

    pub fn distribute_fees_book(ctx: Context<DistributeFeesBook>) -> Result<()> {
        distribute_fees_book::handler(ctx)
    }

    // ── LP lifecycle ──────────────────────────────────────────────────────────

    pub fn seed_lp(ctx: Context<SeedLp>, args: SeedLpArgs) -> Result<()> {
        seed_lp::handler(ctx, args)
    }

    pub fn redeem_lp(ctx: Context<RedeemLp>, lp_amount: u64) -> Result<()> {
        redeem_lp::handler(ctx, lp_amount)
    }

    // ── Adjudicator ───────────────────────────────────────────────────────────

    pub fn register_adjudicator(
        ctx: Context<RegisterAdjudicator>,
        authority: Pubkey,
    ) -> Result<()> {
        register_adjudicator::handler(ctx, authority)
    }

    /// Register a per-market adjudicator that resolves from a Primus zkTLS
    /// attestation rather than a human signature. Separate from
    /// `register_adjudicator` so the manual path is untouched, and so zk mode
    /// is fixed at creation rather than switchable under a live market.
    pub fn register_zk_adjudicator(
        ctx: Context<RegisterZkAdjudicator>,
        args: RegisterZkAdjudicatorArgs,
    ) -> Result<()> {
        register_zk_adjudicator::handler(ctx, args)
    }

    pub fn request_lock(ctx: Context<RequestLock>) -> Result<()> {
        request_lock::handler(ctx)
    }

    pub fn attest_outcome(ctx: Context<AttestOutcome>, winning_outcome: u8) -> Result<()> {
        attest_outcome::handler(ctx, winning_outcome)
    }

    /// Record an outcome derived from a verified Primus zkTLS attestation.
    /// Permissionless: the attestation carries its own authority. Like
    /// `attest_outcome` it records only — `settle` still finalizes after the
    /// veto window, so `dispute` remains available against a bad attestation.
    pub fn attest_outcome_zk(
        ctx: Context<AttestOutcomeZk>,
        attestation: crate::zk::ZkAttestation,
    ) -> Result<()> {
        attest_outcome_zk::handler(ctx, attestation)
    }

    pub fn dispute(ctx: Context<Dispute>, new_outcome: u8) -> Result<()> {
        dispute::handler(ctx, new_outcome)
    }

    /// Write `INVALID` onto a market whose adjudicator never attested, once
    /// `settle::ABANDONED_MARKET_TIMEOUT_SECS` has passed since its deadline.
    /// Permissionless, and does NOT settle: the ordinary veto window and the
    /// ordinary `settle` still stand between it and a final outcome. See
    /// `instructions/settle.rs`.
    pub fn force_invalid_attestation(ctx: Context<ForceInvalidAttestation>) -> Result<()> {
        settle::force_invalid_handler(ctx)
    }

    /// Finalize an attested market. Permissionless once the veto window has
    /// closed; the outcome comes from the `AdjudicatorEntry`, not the caller.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        settle::handler(ctx)
    }

    // ── AMM ───────────────────────────────────────────────────────────────────

    pub fn trade_positions(
        ctx: Context<TradePositions>,
        outcome: u8,
        delta_shares: i128,
        max_cost_wad: u128,
    ) -> Result<()> {
        trade_positions::handler(ctx, outcome, delta_shares, max_cost_wad)
    }

    pub fn sell_positions(
        ctx: Context<SellPositions>,
        outcome: u8,
        delta_shares: i128,
        min_proceeds_wad: u128,
        lock_nonce: u64,
    ) -> Result<()> {
        sell_positions::handler(ctx, outcome, delta_shares, min_proceeds_wad, lock_nonce)
    }

    pub fn claim_unlocked(ctx: Context<ClaimUnlocked>) -> Result<()> {
        claim_unlocked::handler(ctx)
    }

    pub fn sweep_residual(ctx: Context<SweepResidual>) -> Result<()> {
        instructions::sweep_residual::handler(ctx)
    }

    /// Recover an LP-yield balance that no LP token can claim, so the market
    /// can still reach the all-zero balances `close_market` requires.
    /// Permissionless; destinations pinned by `config.treasury`.
    pub fn sweep_lp_yield(ctx: Context<SweepLpYield>) -> Result<()> {
        instructions::sweep_lp_yield::handler(ctx)
    }

    pub fn close_market(ctx: Context<CloseMarket>, market_id: [u8; 16]) -> Result<()> {
        instructions::close_market::handler(ctx, market_id)
    }

    pub fn dismiss_market(ctx: Context<DismissMarket>) -> Result<()> {
        dismiss_market::handler(ctx)
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        claim_refund::handler(ctx)
    }

    // ── Settlement & redeem ───────────────────────────────────────────────────

    pub fn lock_for_resolution(ctx: Context<LockForResolution>) -> Result<()> {
        lock_for_resolution::handler(ctx)
    }

    /// Return the unspent LMSR subsidy to the creator after settlement.
    /// See `reclaim_subsidy`.
    pub fn reclaim_subsidy(ctx: Context<ReclaimSubsidy>) -> Result<()> {
        reclaim_subsidy::handler(ctx)
    }

    /// Pay out a settled AMM position.
    ///
    /// `voided_claim` is `Some` exactly when the market carries a published
    /// `ResolutionCommitment` — the T\* voiding path. Every other market
    /// passes `None` and is paid precisely as it was before that path existed.
    pub fn redeem_amm_position(
        ctx: Context<RedeemAmmPosition>,
        voided_claim: Option<VoidedClaimArgs>,
    ) -> Result<()> {
        redeem_amm_position::handler(ctx, voided_claim)
    }

    /// Commit to a T\* voiding computation for a market. Adjudicator-signed,
    /// accepted only inside the veto window. See `publish_resolution`.
    pub fn publish_resolution_commitment(
        ctx: Context<PublishResolutionCommitment>,
        args: PublishResolutionCommitmentArgs,
    ) -> Result<()> {
        publish_resolution::publish_handler(ctx, args)
    }

    /// Withdraw a published commitment inside the veto window, restoring the
    /// market's ordinary payout. The dispute authority's veto over the
    /// entitlement tree, mirroring `dispute`'s veto over the outcome.
    pub fn revoke_resolution_commitment(ctx: Context<RevokeResolutionCommitment>) -> Result<()> {
        publish_resolution::revoke_handler(ctx)
    }

    /// Pay out a winning book seat position after settlement. See
    /// `redeem_book_seat`.
    pub fn redeem_book_seat(
        ctx: Context<RedeemBookSeat>,
        voided_claim: Option<VoidedBookClaimArgs>,
    ) -> Result<()> {
        redeem_book_seat::handler(ctx, voided_claim)
    }

    // ── CLOB ──────────────────────────────────────────────────────────────────

    /// Place an order on the book. See `book_place` module docs.
    pub fn book_place(
        ctx: Context<BookPlace>,
        side: u8,
        limit_tick: u16,
        amount: u64,
        match_limit: u32,
        post_remainder: bool,
    ) -> Result<()> {
        book_place::handler(ctx, side, limit_tick, amount, match_limit, post_remainder)
    }

    /// Create the per-market book. See `book_init`.
    pub fn book_init(ctx: Context<BookInit>, initial_capacity: u16) -> Result<()> {
        book_init::init_handler(ctx, initial_capacity)
    }

    /// Extend the book toward `wanted_capacity`, one realloc step per call.
    pub fn book_grow(ctx: Context<BookGrow>, wanted_capacity: u16) -> Result<()> {
        book_init::grow_handler(ctx, wanted_capacity)
    }

    /// Cancel a resting book order; the escrow lands in the owner's seat
    /// credit. See `book_ops`.
    pub fn book_cancel(ctx: Context<BookCancel>, order_seq: u64) -> Result<()> {
        book_ops::cancel_handler(ctx, order_seq)
    }

    /// Move accumulated seat credit into the caller's wallet.
    pub fn book_withdraw(ctx: Context<BookWithdraw>) -> Result<()> {
        book_ops::withdraw_handler(ctx)
    }
}
