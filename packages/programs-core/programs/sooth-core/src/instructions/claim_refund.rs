//! `claim_refund` — refund a dismissed-market AMM Position.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::AMM_TOKEN_MINT;
use crate::constants::{
    POSITION_LOCKED_COST_USDC_OFFSET, POSITION_MARKET_OFFSET,
    POSITION_TOTAL_LEN as POSITION_MIN_LEN, POSITION_USER_OFFSET,
};

use crate::error::SoothCoreError;
use crate::events::RefundClaimed;
use crate::state::{AmmState, Market};

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// AMM state for this market. Must be dismissed.
    #[account(
        seeds = [b"amm", market.market_id.as_ref()],
        bump = amm_state.bump,
        constraint = amm_state.market == market.key() @ SoothCoreError::AmmStateMarketMismatch,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// Vault authority signer-only PDA.
    /// CHECK: derived via seeds.
    #[account(
        seeds = [b"vault", market.market_id.as_ref()],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        address = market.vault_amm @ SoothCoreError::VaultAuthorityMismatch,
        constraint = market_vault.mint == AMM_TOKEN_MINT
            @ SoothCoreError::VaultAuthorityMismatch,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = amm_mint,
        token::authority = user,
    )]
    pub user_amm_ata: Box<Account<'info, TokenAccount>>,

    /// AMM Position account — closed by the inline `close_dismissed_position`.
    /// CHECK: validated in handler body.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    #[account(address = AMM_TOKEN_MINT)]
    pub amm_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

/// Refunds are the terminal alternative to settlement payouts.
///
/// Both draw on the same AMM vault, so a market that could do both would pay
/// one deposit twice. The market must therefore be dismissed and must not have
/// settled. `dismiss_market` refuses anything but an `Open` market and `settle`
/// refuses a dismissed one, so the two states are disjoint at the source; this
/// guard holds the exclusion independently of either.
///
/// Dismissal is read from `AmmState`, the account `dismiss_market` writes
/// first and the one every dismissed market carries, rather than from the
/// `Market` mirror.
fn assert_refundable(market: &Market, amm: &AmmState) -> Result<()> {
    require!(amm.is_dismissed, SoothCoreError::MarketNotDismissed);
    require!(!market.is_settled(), SoothCoreError::MarketAlreadySettled);
    Ok(())
}

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    let market_id = ctx.accounts.market.market_id;
    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();

    assert_refundable(&ctx.accounts.market, &ctx.accounts.amm_state)?;

    let locked_cost_usdc =
        read_and_validate_position(&ctx.accounts.position, &market_id, &market_key, &user_key)?;

    if locked_cost_usdc > 0 {
        let vault_authority_bump = ctx.accounts.market.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", market_id.as_ref(), &[vault_authority_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_amm_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            locked_cost_usdc,
        )?;
    }

    // Spend the claim in place. The account stays: `LockEntry`'s seeds derive
    // from the position's key and `claim_unlocked` deserializes it, so a
    // position closed here would strand any sell proceeds still escrowed in
    // the lock vault. Zeroing the one field this instruction pays makes the
    // refund unrepeatable — the same trade `redeem_amm_position` makes, at
    // the cost of the account's rent.
    clear_locked_cost(&ctx.accounts.position)?;

    emit!(RefundClaimed {
        market: market_key,
        user: user_key,
        amount_usdc: locked_cost_usdc,
    });

    Ok(())
}

/// The refund a position is owed, read from the raw account buffer.
///
/// This is the one field `claim_refund` pays out, so it is also the field
/// `redeem_amm_position` clears when it pays a settlement claim — a position
/// cannot be owed both.
fn read_locked_cost(data: &[u8]) -> Result<u64> {
    Ok(u64::from_le_bytes(
        data[POSITION_LOCKED_COST_USDC_OFFSET..POSITION_LOCKED_COST_USDC_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(SoothCoreError::VaultAuthorityMismatch))?,
    ))
}

fn read_and_validate_position(
    position: &UncheckedAccount,
    market_id: &[u8; 16],
    market_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<u64> {
    let (expected_position, _) =
        Pubkey::find_program_address(&[b"pos", market_id.as_ref(), user_key.as_ref()], &crate::ID);
    require_keys_eq!(
        position.key(),
        expected_position,
        SoothCoreError::VaultAuthorityMismatch
    );
    require_keys_eq!(
        *position.to_account_info().owner,
        crate::ID,
        SoothCoreError::VaultAuthorityMismatch
    );

    let data = position.try_borrow_data()?;
    require!(
        data.len() >= POSITION_MIN_LEN,
        SoothCoreError::VaultAuthorityMismatch
    );
    let pos_user = Pubkey::new_from_array(
        data[POSITION_USER_OFFSET..POSITION_USER_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothCoreError::VaultAuthorityMismatch))?,
    );
    let pos_market = Pubkey::new_from_array(
        data[POSITION_MARKET_OFFSET..POSITION_MARKET_OFFSET + 32]
            .try_into()
            .map_err(|_| error!(SoothCoreError::VaultAuthorityMismatch))?,
    );
    let locked_cost_usdc = read_locked_cost(&data)?;
    drop(data);

    require_keys_eq!(pos_user, *user_key, SoothCoreError::VaultAuthorityMismatch);
    require_keys_eq!(
        pos_market,
        *market_key,
        SoothCoreError::VaultAuthorityMismatch
    );
    Ok(locked_cost_usdc)
}

/// Close a position account by zeroing its data and moving its lamports to
/// the user.
/// Zero the refund field in the raw buffer, leaving the rest of the position
/// intact. Writes through the same offset `read_locked_cost` reads, so the
/// two cannot disagree about which bytes hold the claim.
fn clear_locked_cost(position: &UncheckedAccount) -> Result<()> {
    let mut data = position.try_borrow_mut_data()?;
    let end = POSITION_LOCKED_COST_USDC_OFFSET + 8;
    require!(data.len() >= end, SoothCoreError::VaultAuthorityMismatch);
    data[POSITION_LOCKED_COST_USDC_OFFSET..end].fill(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::amm_state::amm_fixture;
    use crate::state::market::market_fixture;
    use crate::state::MarketLifecycle;

    #[test]
    fn a_dismissed_market_refunds() {
        let mut market = market_fixture(MarketLifecycle::Open);
        let mut amm = amm_fixture();
        market.is_dismissed = true;
        amm.is_dismissed = true;
        assert!(assert_refundable(&market, &amm).is_ok());
    }

    #[test]
    fn a_live_market_does_not_refund() {
        let market = market_fixture(MarketLifecycle::Open);
        let amm = amm_fixture();
        assert!(assert_refundable(&market, &amm).is_err());
    }

    #[test]
    fn a_settled_market_never_refunds() {
        // The double-pay invariant from the other side: settle → redeem →
        // dismiss → claim_refund. `dismiss_market` refuses a settled market,
        // and a market carrying a dismissal flag still pays no refund once
        // settled — either guard alone is enough.
        let mut market = market_fixture(MarketLifecycle::Settled);
        let mut amm = amm_fixture();
        amm.is_dismissed = true;
        market.is_dismissed = true;
        assert!(assert_refundable(&market, &amm).is_err());
    }

    #[test]
    fn the_amm_flag_alone_is_enough_to_refund() {
        // Dismissal is read from `AmmState`, so an entry whose `Market` mirror
        // is clear still opens the exit.
        let market = market_fixture(MarketLifecycle::Open);
        let mut amm = amm_fixture();
        amm.is_dismissed = true;
        assert!(assert_refundable(&market, &amm).is_ok());
    }

    /// The raw buffer `claim_refund` reads: discriminator then Borsh fields.
    fn serialize_position(position: &crate::state::Position) -> Vec<u8> {
        use anchor_lang::{AnchorSerialize, Discriminator};
        let mut data = crate::state::Position::DISCRIMINATOR.to_vec();
        position.serialize(&mut data).unwrap();
        data
    }

    #[test]
    fn the_refund_read_lands_on_locked_cost_usdc() {
        // Pins the offset the raw parser uses against the real Borsh layout.
        let mut position = crate::state::position::position_fixture();
        position.yes_shares = 7;
        position.no_shares = 9;
        position.locked_cost_usdc = 1_250_000;
        let data = serialize_position(&position);
        assert_eq!(read_locked_cost(&data).unwrap(), 1_250_000);
    }

    #[test]
    fn a_refund_spends_the_claim_without_erasing_the_position() {
        // `LockEntry`'s seeds derive from the position's key and
        // `claim_unlocked` deserializes the position, so a refund that wiped
        // the account would leave escrowed sell proceeds unreachable for
        // good. The claim goes to zero; the shares and identity stay.
        let mut position = crate::state::position::position_fixture();
        position.yes_shares = 11;
        position.no_shares = 3;
        position.locked_cost_usdc = 900_000;
        let mut data = serialize_position(&position);

        let end = POSITION_LOCKED_COST_USDC_OFFSET + 8;
        data[POSITION_LOCKED_COST_USDC_OFFSET..end].fill(0);

        assert_eq!(
            read_locked_cost(&data).unwrap(),
            0,
            "refund is unrepeatable"
        );
        let after = crate::state::Position::try_deserialize(&mut data.as_slice())
            .expect("the position still deserializes, so claim_unlocked still works");
        assert_eq!(after.yes_shares, 11);
        assert_eq!(after.no_shares, 3);
        assert_eq!(after.user, position.user);
        assert_ne!(&data[..8], &[0u8; 8], "the discriminator survives");
    }

    #[test]
    fn a_position_already_paid_at_settlement_refunds_nothing() {
        // The P0 invariant at position level: whatever order the calls arrive
        // in, one deposit is paid once. This runs the real redemption path,
        // then reads the buffer exactly as `claim_refund` does.
        use crate::instructions::redeem_amm_position::consume_position;
        use crate::state::market::OUTCOME_YES;
        let mut position = crate::state::position::position_fixture();
        position.yes_shares = 2_000_000_000_000_000_000;
        position.locked_cost_usdc = 1_250_000;
        let claim = consume_position(&mut position, OUTCOME_YES).unwrap();
        assert!(claim.usdc_payout > 0, "the settlement claim was paid");
        let data = serialize_position(&position);
        assert_eq!(read_locked_cost(&data).unwrap(), 0);
    }
}
