use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct InitMarketFeePool<'info> {
    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
        seeds::program = sooth_market::ID,
    )]
    pub market: Box<Account<'info, sooth_market::state::Market>>,

    /// Signer-only PDA — authority on every per-market fee-pool token account.
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"fee_pool_authority"],
        bump,
    )]
    pub fee_pool_authority: UncheckedAccount<'info>,

    #[account(address = sooth_protocol_types::BASE_TOKEN_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = signer,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = fee_pool_authority,
    )]
    pub market_fee_pool: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(_ctx: Context<InitMarketFeePool>) -> Result<()> {
    Ok(())
}
