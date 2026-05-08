//! `seed_lp` — bootstrap LP-mint hook.
//!
//! EVM analogue: `LaunchpadEngine._mintLPTokens` (private, called from
//! `createMarket` post deposit transfer). On Solana the LP-mint step is its
//! own ix because the `LpMint` PDA needs `init` codegen which would push
//! `create_market`'s `try_accounts` frame past the SBF 4 KB ceiling — same
//! constraint that fragmented `sooth_market::initialize_market` into three
//! legs (see that module's comment).
//!
//! ## Status: REAL handler (Wave 5C — `todo!()` cleared).
//!
//! ## Bootstrap-only scope
//!
//! This ix is the **one-shot** initial seed: it creates the per-market
//! `LpMint`, the creator's `LpPosition` PDA, the creator's LP ATA, and
//! mints `args.lp_amount` LP units to that ATA. Pre-graduation LP
//! minting on subsequent buys (architecture §4.2) is **out of scope**
//! for this commit — see `sooth_amm::trade_positions` follow-up note.
//!
//! ## Hand-rolled inits (BPF stack-frame discipline)
//!
//! Anchor's `init` constraint codegen overflows the SBF 4 KB stack
//! frame for this Accounts struct (Wave 1C measurement). Three accounts
//! that would otherwise carry `init` are demoted to `UncheckedAccount`
//! and the handler hand-rolls each via `solana_program::system_instruction::
//! create_account` + the SPL token / launchpad post-init step:
//!
//!   1. `lp_mint`        — `create_account` (owner = SPL token program,
//!                          space = `Mint::LEN`) + `token::initialize_mint`
//!                          with `lp_mint_authority` PDA as the mint
//!                          authority.
//!   2. `creator_lp_ata` — `associated_token::create` (idempotent variant)
//!                          for the creator's LP-token ATA.
//!   3. `lp_position`    — `create_account` (owner = `sooth_launchpad`,
//!                          space = `LpPosition::SPACE`) + write
//!                          discriminator + Borsh body via
//!                          `position.serialize` into the data slice.
//!
//! Then a PDA-signed `token::mint_to` seeds `args.lp_amount` LP units to
//! `creator_lp_ata`, signed by `lp_mint_authority`.
//!
//! ## LP-mint authority PDA scheme
//!
//! `lp_mint_authority` PDA seeds = `[b"lp_mint_authority", market_id]` —
//! per-market, isolated. Mirrors the per-market `vault_authority` /
//! `lock_authority` PDAs from `sooth_market`, so each market's LP-mint
//! authority is independent and cannot be cross-signed by another
//! market's flow. Decision documented in this module comment +
//! architecture §1 row 7 (LP token mint authority).
//!
//! ## Initial LP allocation formula
//!
//! 1:1 with the creator's seed deposit, mirroring EVM
//! `LaunchpadEngine._mintLPTokens`:
//!
//!   creator's initial LP units = `args.lp_amount`
//!   bookkeeping              = `args.seed_deposit_wad` (recorded on
//!                                `LpPosition` for the dismiss/refund flow)
//!
//! The SDK passes `lp_amount = total_initial_b` (the creator's deposit
//! in LP base units). Decimals = 6, matching USDC for clean
//! down-the-line "1 LP ≡ 1 deposited USDC at seed time" mental model.
//!
//! ## Single-shot guarantee
//!
//! `lp_mint` and `lp_position` PDAs are deterministic per `market_id`
//! (and per `creator` for `lp_position`). A second call collides on
//! the `system_instruction::create_account` step and the runtime
//! returns `account already in use` (0x0 / `SystemError::AccountAlreadyInUse`),
//! same shape as Anchor's `init` constraint produces. We don't gate
//! manually — let the runtime do it.
//!
//! ## Out of scope follow-ups
//!
//! - `trade_positions` LP-mint-on-buy (architecture §4.2): on every
//!   pre-graduation buy, mint additional LP units in proportion to
//!   the deposit. Tracked as a separate ix-level enhancement; this
//!   commit only ships the bootstrap.
//! - `create_market` composing `seed_lp` as a 5th CPI leg. Hoisted to
//!   its own user-facing ix here because Wave 1C measured the unified
//!   `try_accounts` frame past the 4 KB ceiling. Re-evaluate once the
//!   remaining `Box<…>` accounts in `create_market` are demoted to
//!   `UncheckedAccount`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, InitializeMint, Mint, MintTo, Token};

use sooth_amm::state::AmmState;
use sooth_market::state::Market;

use crate::error::SoothLaunchpadError;
use crate::events::LpSeeded;
use crate::state::{LpPosition, ProtocolConfig};

/// Decimals for the per-market LP mint. Matches USDC so the
/// "1 LP ≡ 1 deposited USDC base unit" mental model is direct. Must
/// stay in lock-step with whatever `total_initial_b` units the SDK
/// passes as `lp_amount`.
const LP_MINT_DECIMALS: u8 = 6;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SeedLpArgs {
    /// LP-token base units to mint to `creator_lp_ata`. Pre-graduation 1:1
    /// with the creator's USDC seed deposit (EVM convention; revisit when we
    /// land an explicit LP price model).
    pub lp_amount: u64,
    /// Creator's seed deposit in WAD, recorded on `LpPosition` for the
    /// dismiss/refund flow (architecture §9).
    pub seed_deposit_wad: u128,
}

#[derive(Accounts)]
#[instruction(args: SeedLpArgs)]
pub struct SeedLp<'info> {
    #[account(
        seeds = [b"protocol_config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    /// Market PDA — owned by `sooth_market`. Read-only.
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
        has_one = creator,
    )]
    pub market: Box<Account<'info, Market>>,

    /// AmmState PDA — read `is_graduated` only.
    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        seeds::program = sooth_amm::ID,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// LP token mint owned by the launchpad. CHECK: PDA derived via seeds;
    /// init'd by the handler body via manual `create_account` +
    /// `initialize_mint` (Anchor's `init` constraint codegen overflows the
    /// SBF 4 KB stack frame for this Accounts struct — see module comment).
    #[account(
        mut,
        seeds = [b"lp", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint: UncheckedAccount<'info>,

    /// Per-market signer-only PDA. The mint authority on `lp_mint`. Seeds
    /// `[b"lp_mint_authority", market_id]` keep the authority isolated
    /// per market — same pattern as `sooth_market::vault_authority` /
    /// `lock_authority`. CHECK: derived via seeds; signs the `mint_to`
    /// CPI in the handler body.
    #[account(
        seeds = [b"lp_mint_authority", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint_authority: UncheckedAccount<'info>,

    /// Creator's LP-token ATA — destination of the `mint_to` CPI. CHECK:
    /// derived via the standard spl-associated-token derivation; init'd
    /// manually in the body.
    #[account(mut)]
    pub creator_lp_ata: UncheckedAccount<'info>,

    /// Per-(creator, market) LP position record. CHECK: PDA derived via
    /// seeds; init'd manually in the body for the same SBF-stack reason as
    /// `lp_mint`.
    #[account(
        mut,
        seeds = [b"lp_position", market.market_id.as_ref(), creator.key().as_ref()],
        bump,
    )]
    pub lp_position: UncheckedAccount<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<SeedLp>, args: SeedLpArgs) -> Result<()> {
    // ── 1. Pre-graduation guard ─────────────────────────────────────────
    //
    // Mirrors EVM `LaunchpadEngine._mintLPTokens`'s `whenNotGraduated`
    // check. Post-graduation LP shares are fixed at the snapshot taken
    // by the (future) graduation ix; minting more would dilute existing
    // holders.
    require!(
        !ctx.accounts.amm_state.is_graduated,
        SoothLaunchpadError::AlreadyGraduated
    );

    // Snapshot bumps + keys before any CPI so we can build signer-seed
    // arrays without retaining `ctx.bumps` borrows across the calls.
    let market_id = ctx.accounts.market.market_id;
    let lp_mint_bump = ctx.bumps.lp_mint;
    let lp_mint_authority_bump = ctx.bumps.lp_mint_authority;
    let lp_position_bump = ctx.bumps.lp_position;

    let creator_key = ctx.accounts.creator.key();
    let market_key = ctx.accounts.market.key();
    let lp_mint_key = ctx.accounts.lp_mint.key();

    // ── 2. Hand-rolled `create_account` for `lp_mint` ───────────────────
    //
    // PDA-signed: the LP mint pubkey IS the PDA, so the launchpad signs
    // for it via `[b"lp", market_id, &[lp_mint_bump]]`. Owner = SPL
    // token program; space = `Mint::LEN`; lamports = rent-exempt for
    // that size.
    {
        let rent = &ctx.accounts.rent;
        let mint_space = Mint::LEN;
        let lamports = rent.minimum_balance(mint_space);

        let create_ix = system_instruction::create_account(
            &creator_key,
            &lp_mint_key,
            lamports,
            mint_space as u64,
            &token::ID,
        );
        let signer_seeds: &[&[&[u8]]] = &[&[b"lp", market_id.as_ref(), &[lp_mint_bump]]];
        invoke_signed(
            &create_ix,
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.lp_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;
    }

    // ── 3. Hand-rolled `token::initialize_mint` for `lp_mint` ───────────
    //
    // Mint authority = `lp_mint_authority` PDA. No freeze authority —
    // matches EVM `LaunchpadLPToken` which has no admin lock-out path.
    // `initialize_mint` is a write-the-data step, not an account-create
    // step, so no PDA signing needed here (the create_account above
    // already established ownership; the SPL token program owns the
    // account and lets us populate its data).
    {
        let lp_mint_authority_key = ctx.accounts.lp_mint_authority.key();
        token::initialize_mint(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                InitializeMint {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            LP_MINT_DECIMALS,
            &lp_mint_authority_key,
            None,
        )?;
    }

    // ── 4. Hand-rolled ATA create for `creator_lp_ata` ──────────────────
    //
    // `associated_token::create` invokes the SPL ATA program which
    // internally does the rent-exempt allocate + InitializeAccount in
    // one shot. We use the non-idempotent variant: a double-call is a
    // bug (the bootstrap is one-shot per market), not a benign retry.
    {
        let cpi_accounts = Create {
            payer: ctx.accounts.creator.to_account_info(),
            associated_token: ctx.accounts.creator_lp_ata.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
            mint: ctx.accounts.lp_mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            cpi_accounts,
        ))?;
    }

    // ── 5. Hand-rolled `create_account` for `lp_position` ───────────────
    //
    // PDA-signed: owner = sooth_launchpad (this program). Space =
    // `LpPosition::SPACE` (incl. 8-byte discriminator). After alloc,
    // we populate the discriminator + Borsh body manually — mirrors
    // what Anchor's `init` codegen does internally.
    {
        let rent = &ctx.accounts.rent;
        let space = LpPosition::SPACE;
        let lamports = rent.minimum_balance(space);

        let create_ix = system_instruction::create_account(
            &creator_key,
            &ctx.accounts.lp_position.key(),
            lamports,
            space as u64,
            &crate::ID,
        );
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"lp_position",
            market_id.as_ref(),
            creator_key.as_ref(),
            &[lp_position_bump],
        ]];
        invoke_signed(
            &create_ix,
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.lp_position.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Populate discriminator + body. `LpPosition` is `#[account]`
        // so it implements `Discriminator` (8-byte tag) + Borsh; we
        // write the tag at [0..8] then Borsh-serialize the struct
        // into [8..]. Subsequent `Account<'info, LpPosition>` reads
        // (e.g. by the dismiss/refund ix once it lands) decode this
        // identically to an Anchor-`init`-allocated account.
        let position = LpPosition {
            market: market_key,
            creator: creator_key,
            lp_mint: lp_mint_key,
            seed_deposit_wad: args.seed_deposit_wad,
            graduated_at: 0,
            bump: lp_position_bump,
        };
        let mut data = ctx.accounts.lp_position.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&LpPosition::DISCRIMINATOR);
        let mut writer = &mut data[8..];
        position.serialize(&mut writer)?;
    }

    // ── 6. PDA-signed `mint_to` seeding the creator's LP allocation ─────
    //
    // Authority = `lp_mint_authority` PDA, signed via
    // `[b"lp_mint_authority", market_id, &[bump]]`. EVM analogue:
    // `LaunchpadLPToken.mint(creator, depositWad)` from
    // `_mintLPTokens` (`LaunchpadEngine.sol:443`).
    {
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"lp_mint_authority",
            market_id.as_ref(),
            &[lp_mint_authority_bump],
        ]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.creator_lp_ata.to_account_info(),
                    authority: ctx.accounts.lp_mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            args.lp_amount,
        )?;
    }

    // ── 7. Emit ─────────────────────────────────────────────────────────
    let now = Clock::get()?.unix_timestamp;
    emit!(LpSeeded {
        market: market_key,
        creator: creator_key,
        lp_mint: lp_mint_key,
        creator_lp_ata: ctx.accounts.creator_lp_ata.key(),
        lp_amount: args.lp_amount,
        seed_deposit_wad: args.seed_deposit_wad,
        ts: now,
    });

    Ok(())
}
