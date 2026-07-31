//! `cancel` — cancel the first cancellable order for `(user, side, tick)`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::SoothCoreError;
use crate::events::OrderCancelled;
use crate::instructions::orderbook_common::{create_orderbook_position, credit_shares};
use crate::math::{resting_cost_base, MAX_TICK, MIN_TICK};
use crate::state::{BookSide, InlineOrder, Market, MarketBook, OrderbookPosition};

#[derive(Accounts)]
#[instruction(side: u8, tick: u16)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"market_book", market.market_id.as_ref()],
        bump,
        constraint = market_book.market == market.key() @ SoothCoreError::OrderIdSeedMismatch,
    )]
    pub market_book: Box<Account<'info, MarketBook>>,

    #[account(
        mut,
        seeds = [b"book_side", market.market_id.as_ref(), &[side], &tick.to_le_bytes()],
        bump,
        has_one = market @ SoothCoreError::OrderIdSeedMismatch,
    )]
    pub book_side: Box<Account<'info, BookSide>>,

    /// CHECK: derived via seeds; signs vault outflows.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault @ SoothCoreError::BaseMintDrift,
    )]
    pub market_usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market_usdc_vault.mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA seed-bound under crate::ID.
    #[account(
        mut,
        seeds = [
            b"orderbook_position",
            market.market_id.as_ref(),
            user.key().as_ref()
        ],
        bump,
    )]
    pub user_orderbook_position: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CancelOrder>, side: u8, tick: u16) -> Result<()> {
    require!(side <= 1, SoothCoreError::InvalidOrderId);
    require!(
        (MIN_TICK..=MAX_TICK).contains(&tick),
        SoothCoreError::InvalidTick
    );
    require!(
        ctx.accounts.book_side.side == side && ctx.accounts.book_side.tick == tick,
        SoothCoreError::OrderIdSeedMismatch
    );

    let signer = ctx.accounts.user.key();
    let mut head = ctx.accounts.book_side.head_index as usize;
    while head < ctx.accounts.book_side.orders.len()
        && ctx.accounts.book_side.orders[head].amount == 0
    {
        head += 1;
    }
    ctx.accounts.book_side.head_index = head as u32;

    let idx = ctx.accounts.book_side.orders[head..]
        .iter()
        .position(|o| o.amount > 0 && o.maker == signer)
        .map(|i| i + head)
        .ok_or(error!(SoothCoreError::NoCancellableOrder))?;
    let order = ctx.accounts.book_side.orders[idx].clone();

    refund_order(
        &ctx.accounts.user,
        ctx.accounts.market.as_ref(),
        &ctx.accounts.vault_authority,
        ctx.accounts.market_usdc_vault.as_ref(),
        ctx.accounts.user_usdc_ata.as_ref(),
        &ctx.accounts.user_orderbook_position,
        &ctx.accounts.system_program,
        &ctx.accounts.token_program,
        &ctx.accounts.rent,
        side,
        tick,
        &order,
    )?;

    ctx.accounts.book_side.orders[idx].amount = 0;
    if ctx.accounts.book_side.orders[head..]
        .iter()
        .all(|order| order.amount == 0)
    {
        ctx.accounts.market_book.bitmap_mut(side).clear_bit(tick);
    }

    emit!(OrderCancelled {
        market: ctx.accounts.market.key(),
        side,
        tick,
        maker: signer,
        order_id: order.id,
        remaining: order.amount,
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn refund_order<'info>(
    user: &Signer<'info>,
    market: &Account<'info, Market>,
    vault_authority: &UncheckedAccount<'info>,
    market_usdc_vault: &Account<'info, TokenAccount>,
    user_usdc_ata: &Account<'info, TokenAccount>,
    user_orderbook_position: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    token_program: &Program<'info, Token>,
    rent: &Sysvar<'info, Rent>,
    side: u8,
    tick: u16,
    order: &InlineOrder,
) -> Result<()> {
    if order.escrow {
        // Credit shares back to the user's orderbook position.
        let info = user_orderbook_position.to_account_info();
        // Was a hand-rolled copy of the same bug D-2 fixed: it transferred
        // rent to a system-owned account (zero-length data) and then wrote the
        // discriminator into it. Use the shared helper, which does
        // create_account, falls back to allocate+assign when the PDA was
        // pre-funded by a griefer, and verifies the derivation.
        create_orderbook_position(
            &info,
            market,
            user.key(),
            user,
            system_program,
            rent,
        )?;
        use anchor_lang::{AccountDeserialize, AccountSerialize};
        let data = info.try_borrow_mut_data()?;
        let mut slice: &[u8] = &data;
        let mut pos = OrderbookPosition::try_deserialize(&mut slice)
            .map_err(|_| error!(SoothCoreError::Unauthorized))?;
        drop(data);
        credit_shares(&mut pos, side ^ 1, order.amount)?;
        let mut data = info.try_borrow_mut_data()?;
        pos.try_serialize(&mut &mut data[..])?;
    } else {
        let refund_base = resting_cost_base(order.amount, tick)?;
        if refund_base > 0 {
            let market_id = market.market_id;
            let vault_authority_bump = market.vault_authority_bump;
            let signer_seeds: &[&[&[u8]]] =
                &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: market_usdc_vault.to_account_info(),
                        to: user_usdc_ata.to_account_info(),
                        authority: vault_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                refund_base,
            )?;
        }
    }
    Ok(())
}

