use anchor_lang::{prelude::*, AccountDeserialize};
use anchor_spl::token::{Mint, Token, TokenAccount};
use sooth_market::program::SoothMarket;

use crate::error::CoreError;
use crate::instructions::{current_timestamp, market_position, PRICE_WAD};
use crate::state::market_account::{Market, MarketStatus};
use crate::state::market_liquidities::MarketLiquidities;
use crate::state::market_position_account::MarketPosition;
use crate::state::order_account::{Order, OrderStatus};

const OUTCOME_NO: u16 = 0;
const OUTCOME_YES: u16 = 1;

#[event]
pub struct LiquidityMintedIntoBook {
    pub market: Pubkey,
    pub user: Pubkey,
    pub stake: u64,
    pub price_yes: u128,
}

#[derive(Accounts)]
#[instruction(price_yes: u128, stake: u64, distinct_seed_yes: u64, distinct_seed_no: u64)]
pub struct MintIntoBook<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(address = sooth_market::USDC_MINT_DEVNET)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        owner = sooth_market::ID @ CoreError::MarketMismatch,
    )]
    /// CHECK: owner-pinned and deserialized in the handler to avoid IDL
    /// account-name collisions with SoothBook's own `Market`.
    pub market_pda: UncheckedAccount<'info>,
    /// CHECK: signer-only PDA owned by `sooth_market`; derivation checked in handler.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = vault_authority,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"market", market_pda.key().as_ref()],
        bump,
        constraint = book_market.sooth_market_pda == market_pda.key() @ CoreError::MarketMismatch,
        constraint = book_market.market_status == MarketStatus::Open @ CoreError::MarketNotOpen,
    )]
    pub book_market: Box<Account<'info, Market>>,

    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = book_market_escrow_authority,
    )]
    pub market_escrow_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = book_market_escrow_authority,
    )]
    pub market_escrow_no: Box<Account<'info, TokenAccount>>,
    #[account(
        seeds = [b"escrow", book_market.key().as_ref()],
        bump = book_market.escrow_account_bump,
    )]
    /// CHECK: PDA authority for the YES/NO escrow token accounts.
    pub book_market_escrow_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = user,
        space = Order::SIZE,
        seeds = [b"order", book_market.key().as_ref(), &distinct_seed_yes.to_le_bytes()],
        bump,
    )]
    pub order_yes: Box<Account<'info, Order>>,
    #[account(
        init,
        payer = user,
        space = Order::SIZE,
        seeds = [b"order", book_market.key().as_ref(), &distinct_seed_no.to_le_bytes()],
        bump,
    )]
    pub order_no: Box<Account<'info, Order>>,

    #[account(
        mut,
        seeds = [b"liquidities", book_market.key().as_ref()],
        bump,
        constraint = market_liquidities.market == book_market.key() @ CoreError::CreationMarketMismatch,
    )]
    pub market_liquidities: Box<Account<'info, MarketLiquidities>>,

    #[account(
        init_if_needed,
        payer = user,
        space = MarketPosition::size_for(usize::from(book_market.market_outcomes_count)),
        seeds = [b"position", book_market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub market_position: Box<Account<'info, MarketPosition>>,

    pub sooth_market_program: Program<'info, SoothMarket>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<MintIntoBook>,
    price_yes: u128,
    stake: u64,
    _distinct_seed_yes: u64,
    _distinct_seed_no: u64,
) -> Result<()> {
    require!(stake > 0, CoreError::ZeroStake);
    require!(
        price_yes > 0 && price_yes < PRICE_WAD,
        CoreError::PriceOutOfRange
    );

    let sooth_market = load_sooth_market(&ctx.accounts.market_pda)?;
    require!(sooth_market.is_open(), CoreError::MarketNotOpen);
    require_keys_eq!(
        ctx.accounts.yes_mint.key(),
        sooth_market.yes_mint,
        CoreError::MarketMismatch
    );
    require_keys_eq!(
        ctx.accounts.no_mint.key(),
        sooth_market.no_mint,
        CoreError::MarketMismatch
    );
    require_keys_eq!(
        ctx.accounts.market_vault.key(),
        sooth_market.vault,
        CoreError::MarketMismatch
    );
    let (expected_vault_authority, _) = Pubkey::find_program_address(
        &[b"vault", sooth_market.market_id.as_ref()],
        &sooth_market::ID,
    );
    require_keys_eq!(
        ctx.accounts.vault_authority.key(),
        expected_vault_authority,
        CoreError::MarketMismatch
    );

    sooth_market::cpi::mint_complete_set_to_program_owned(
        CpiContext::new(
            ctx.accounts.sooth_market_program.to_account_info(),
            sooth_market::cpi::accounts::MintCompleteSetToProgramOwned {
                market: ctx.accounts.market_pda.to_account_info(),
                vault_authority: ctx.accounts.vault_authority.to_account_info(),
                yes_mint: ctx.accounts.yes_mint.to_account_info(),
                no_mint: ctx.accounts.no_mint.to_account_info(),
                usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
                market_vault: ctx.accounts.market_vault.to_account_info(),
                payer_usdc_ata: ctx.accounts.user_usdc_ata.to_account_info(),
                destination_authority: ctx.accounts.book_market_escrow_authority.to_account_info(),
                destination_yes_ata: ctx.accounts.market_escrow_yes.to_account_info(),
                destination_no_ata: ctx.accounts.market_escrow_no.to_account_info(),
                payer: ctx.accounts.user.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ),
        stake,
    )?;

    let now = current_timestamp();
    let book_market_key = ctx.accounts.book_market.key();
    initialize_resting_order(
        &mut ctx.accounts.order_yes,
        book_market_key,
        OUTCOME_YES,
        price_yes,
        stake,
        ctx.accounts.user.key(),
        now,
    );
    initialize_resting_order(
        &mut ctx.accounts.order_no,
        book_market_key,
        OUTCOME_NO,
        PRICE_WAD - price_yes,
        stake,
        ctx.accounts.user.key(),
        now,
    );

    ctx.accounts
        .market_liquidities
        .add_liquidity_against(OUTCOME_YES, price_yes, stake)?;
    ctx.accounts.market_liquidities.add_liquidity_against(
        OUTCOME_NO,
        PRICE_WAD - price_yes,
        stake,
    )?;

    initialise_position_if_needed(
        &mut ctx.accounts.market_position,
        ctx.accounts.user.key(),
        book_market_key,
        usize::from(ctx.accounts.book_market.market_outcomes_count),
    );
    market_position::update_on_order_request_creation(
        &mut ctx.accounts.market_position,
        OUTCOME_YES,
        false,
        stake,
        price_yes,
    )?;
    market_position::update_on_order_request_creation(
        &mut ctx.accounts.market_position,
        OUTCOME_NO,
        false,
        stake,
        PRICE_WAD - price_yes,
    )?;

    ctx.accounts.book_market.increment_account_counts()?;
    ctx.accounts.book_market.increment_account_counts()?;

    emit!(LiquidityMintedIntoBook {
        market: book_market_key,
        user: ctx.accounts.user.key(),
        stake,
        price_yes,
    });

    Ok(())
}

fn load_sooth_market(market_pda: &UncheckedAccount) -> Result<sooth_market::state::Market> {
    let mut data = &market_pda.try_borrow_data()?[..];
    sooth_market::state::Market::try_deserialize(&mut data)
        .map_err(|_| error!(CoreError::MarketMismatch))
}

fn initialize_resting_order(
    order: &mut Order,
    market: Pubkey,
    outcome: u16,
    price: u128,
    stake: u64,
    purchaser: Pubkey,
    creation_timestamp: i64,
) {
    order.purchaser = purchaser;
    order.market = market;
    order.market_outcome_index = outcome;
    order.for_outcome = false;
    order.order_status = OrderStatus::Open;
    order.stake = stake;
    order.voided_stake = 0;
    order.expected_price = price;
    order.creation_timestamp = creation_timestamp;
    order.stake_unmatched = stake;
    order.payout = 0;
    order.payer = purchaser;
}

fn initialise_position_if_needed(
    market_position: &mut MarketPosition,
    purchaser: Pubkey,
    market: Pubkey,
    market_outcomes_len: usize,
) {
    if market_position.purchaser == Pubkey::default() {
        market_position.purchaser = purchaser;
        market_position.payer = purchaser;
        market_position.market = market;
        market_position.paid = false;
    }
    if market_position.market_outcome_sums.len() < market_outcomes_len {
        market_position
            .market_outcome_sums
            .resize(market_outcomes_len, 0_i128);
    }
    if market_position.unmatched_exposures.len() < market_outcomes_len {
        market_position
            .unmatched_exposures
            .resize(market_outcomes_len, 0_u64);
    }
}
