//! `seed_lp` — bootstrap LP-mint hook.
//!
//! Adapted from `sooth_launchpad::seed_lp`. Changes:
//!   - `market` and `amm_state` seeds have no `seeds::program`.
//!   - `lp_position` owner check uses `crate::ID` (not `sooth_launchpad::ID`).
//!   - All other logic preserved verbatim.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, InitializeMint, Mint, MintTo, Token};

use crate::error::SoothCoreError;
use crate::events::LpSeeded;
use crate::state::{AmmState, LpPosition, Market, ProtocolConfig};

const LP_MINT_DECIMALS: u8 = 6;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SeedLpArgs {
    pub lp_amount: u64,
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

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        has_one = creator,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: PDA-derived LP mint; hand-rolled init in handler.
    #[account(
        mut,
        seeds = [b"lp", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint: UncheckedAccount<'info>,

    /// CHECK: signer-only PDA; mint authority on `lp_mint`.
    #[account(
        seeds = [b"lp_mint_authority", market.market_id.as_ref()],
        bump,
    )]
    pub lp_mint_authority: UncheckedAccount<'info>,

    /// CHECK: creator's LP-token ATA; hand-rolled create in handler.
    #[account(mut)]
    pub creator_lp_ata: UncheckedAccount<'info>,

    /// CHECK: per-(creator, market) LP position; hand-rolled init in handler.
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
    require!(
        !ctx.accounts.amm_state.is_graduated,
        SoothCoreError::AlreadyGraduated
    );

    let market_id = ctx.accounts.market.market_id;
    let lp_mint_bump = ctx.bumps.lp_mint;
    let lp_mint_authority_bump = ctx.bumps.lp_mint_authority;
    let lp_position_bump = ctx.bumps.lp_position;

    let creator_key = ctx.accounts.creator.key();
    let market_key = ctx.accounts.market.key();
    let lp_mint_key = ctx.accounts.lp_mint.key();

    // ── 2. Hand-rolled create_account for lp_mint ─────────────────────────
    {
        let rent = &ctx.accounts.rent;
        let mint_space = Mint::LEN;
        let lamports = rent.minimum_balance(mint_space);
        let signer_seeds: &[&[&[u8]]] = &[&[b"lp", market_id.as_ref(), &[lp_mint_bump]]];
        invoke_signed(
            &system_instruction::create_account(
                &creator_key,
                &lp_mint_key,
                lamports,
                mint_space as u64,
                &token::ID,
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.lp_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;
    }

    // ── 3. Hand-rolled initialize_mint for lp_mint ────────────────────────
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

    // ── 4. Hand-rolled ATA create for creator_lp_ata ─────────────────────
    {
        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.creator.to_account_info(),
                associated_token: ctx.accounts.creator_lp_ata.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
                mint: ctx.accounts.lp_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
    }

    // ── 5. Hand-rolled create_account for lp_position ─────────────────────
    {
        let rent = &ctx.accounts.rent;
        let space = LpPosition::SPACE;
        let lamports = rent.minimum_balance(space);
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"lp_position",
            market_id.as_ref(),
            creator_key.as_ref(),
            &[lp_position_bump],
        ]];
        invoke_signed(
            &system_instruction::create_account(
                &creator_key,
                &ctx.accounts.lp_position.key(),
                lamports,
                space as u64,
                &crate::ID,  // owner = sooth_core
            ),
            &[
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.lp_position.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

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
        use anchor_lang::AnchorSerialize;
        position.serialize(&mut &mut data[8..])?;
    }

    // ── 6. PDA-signed mint_to ─────────────────────────────────────────────
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
