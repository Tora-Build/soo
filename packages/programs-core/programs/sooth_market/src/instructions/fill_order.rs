use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::set_return_data, sysvar};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::SoothMarketError;
use crate::instruction_introspection::{
    require_sooth_book_cpi_parent, SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
    SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
};
use crate::instructions::orderbook_common::{
    complement_tick_cost_wad, compute_taker_pull, credit_shares, ensure_position_identity,
    read_fee_bps, require_before_deadline, tick_cost_wad, wad_to_base, NUM_TICKS,
};
use crate::state::{Market, OrderbookPosition};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FillReturnData {
    pub fee_base_delta: u128,
    pub taker_payout_delta: u128,
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: derived via seeds; signs vault outflows.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothMarketError::VaultAuthorityMismatch,
        constraint = vault.mint == crate::USDC_MINT_DEVNET
            @ SoothMarketError::VaultAuthorityMismatch,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = taker)]
    pub taker_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = vault.mint, token::authority = maker)]
    pub maker_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = taker,
        space = OrderbookPosition::SPACE,
        seeds = [b"orderbook_position", market.market_id.as_ref(), taker.key().as_ref()],
        bump,
    )]
    pub taker_position: Box<Account<'info, OrderbookPosition>>,

    #[account(
        init_if_needed,
        payer = taker,
        space = OrderbookPosition::SPACE,
        seeds = [b"orderbook_position", market.market_id.as_ref(), maker.key().as_ref()],
        bump,
    )]
    pub maker_position: Box<Account<'info, OrderbookPosition>>,

    #[account(mut)]
    pub taker: Signer<'info>,

    /// CHECK: maker identity is bound through the maker_position seeds and
    /// maker_usdc_ata token authority.
    pub maker: UncheckedAccount<'info>,

    /// CHECK: PDA + owner constraints bind this to sooth_launchpad's singleton.
    #[account(
        seeds = [b"protocol_config"],
        bump,
        seeds::program = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
        owner = sooth_protocol_types::SOOTH_LAUNCHPAD_PROGRAM_ID,
    )]
    pub protocol_config: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// CHECK: address-pinned and parsed by the parent-ix gate.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<FillOrder>,
    taker_side: u8,
    shares: u128,
    taker_tick: u16,
    maker_tick: u16,
    taker_escrow: bool,
    maker_escrow: bool,
) -> Result<()> {
    require_sooth_book_cpi_parent(
        &ctx.accounts.instruction_sysvar,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
        ],
    )?;
    require_before_deadline(&ctx.accounts.market)?;
    require!(
        taker_side == 0 || taker_side == 1,
        SoothMarketError::InvalidOutcome
    );
    require!(taker_tick <= NUM_TICKS, SoothMarketError::InvalidTick);
    require!(maker_tick <= NUM_TICKS, SoothMarketError::InvalidTick);

    let market_key = ctx.accounts.market.key();
    ensure_position_identity(
        &mut ctx.accounts.taker_position,
        market_key,
        ctx.accounts.taker.key(),
    )?;
    ensure_position_identity(
        &mut ctx.accounts.maker_position,
        market_key,
        ctx.accounts.maker.key(),
    )?;

    let mut fee_base_delta: u128 = 0;
    let mut taker_payout_delta: u128 = 0;

    if !taker_escrow {
        let fee_bps = read_fee_bps(&ctx.accounts.protocol_config.to_account_info())?;
        let base_cost_wad = tick_cost_wad(taker_tick, shares)?;
        let (_taker_base_cost, fee_base, taker_cost_plus_fee) =
            compute_taker_pull(base_cost_wad, fee_bps)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_usdc_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            taker_cost_plus_fee,
        )?;
        fee_base_delta = fee_base as u128;
    }

    let market_id = ctx.accounts.market.market_id;
    let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];

    if maker_escrow {
        let maker_payout = wad_to_base(complement_tick_cost_wad(maker_tick, shares)?)?;
        if maker_payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.maker_usdc_ata.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                maker_payout,
            )?;
        }
    }

    if taker_escrow {
        let taker_payout = wad_to_base(complement_tick_cost_wad(taker_tick, shares)?)?;
        taker_payout_delta = taker_payout_delta
            .checked_add(taker_payout as u128)
            .ok_or(error!(SoothMarketError::MathOverflow))?;
    }

    let tick_sum = (taker_tick as u32)
        .checked_add(maker_tick as u32)
        .ok_or(error!(SoothMarketError::MathOverflow))?;
    if tick_sum > NUM_TICKS as u32 {
        let surplus_wad = shares
            .checked_mul((tick_sum - NUM_TICKS as u32) as u128)
            .ok_or(error!(SoothMarketError::MathOverflow))?
            .checked_div(NUM_TICKS as u128)
            .ok_or(error!(SoothMarketError::MathOverflow))?;
        let surplus = wad_to_base(surplus_wad)?;
        taker_payout_delta = taker_payout_delta
            .checked_add(surplus as u128)
            .ok_or(error!(SoothMarketError::MathOverflow))?;
    }

    if !maker_escrow {
        credit_shares(&mut ctx.accounts.maker_position, taker_side ^ 1, shares)?;
    }
    if !taker_escrow {
        credit_shares(&mut ctx.accounts.taker_position, taker_side, shares)?;
    }

    let ret = FillReturnData {
        fee_base_delta,
        taker_payout_delta,
    };
    let data = AnchorSerialize::try_to_vec(&ret)?;
    set_return_data(&data);

    Ok(())
}
