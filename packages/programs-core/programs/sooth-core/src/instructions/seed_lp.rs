//! `seed_lp` — post the creator's LMSR subsidy and mint their LP claim.
//!
//! Creates the market's LP mint, the creator's LP ATA and their `LpPosition`,
//! moves `seed_deposit_wad` of the AMM token into the AMM vault, and mints
//! `lp_amount` LP tokens to the creator. Every account here is created by hand
//! because each is a PDA whose address the handler must sign for.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, InitializeMint, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::AMM_TOKEN_MINT;
use crate::error::SoothCoreError;
use crate::events::LpSeeded;
use crate::math::{wad_mul, wad_to_usdc_ceil, LN2_WAD};
use crate::pda::create_pda_account;
use crate::state::{require_not_paused, AmmState, LpPosition, Market, ProtocolConfig};

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

    /// `mut` for exactly one write: `is_seeded`, which opens the trading
    /// paths. Nothing else in this instruction touches `AmmState`.
    #[account(
        mut,
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

    // ── LMSR subsidy deposit ────────────────────────────────────────────
    //
    // These three accounts move the creator's LMSR subsidy into the AMM
    // vault; `seed_deposit_wad` must actually be funded, not just recorded
    // on LpPosition. See the handler for the arithmetic.
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
        token::authority = creator,
    )]
    pub creator_amm_ata: Box<Account<'info, TokenAccount>>,

    #[account(address = AMM_TOKEN_MINT)]
    pub amm_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<SeedLp>, args: SeedLpArgs) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    require!(
        !ctx.accounts.amm_state.is_graduated,
        SoothCoreError::AlreadyGraduated
    );

    // ── LMSR subsidy: require it, then actually move it ───────────────────
    //
    // A binary LMSR starting at q = (0, 0) has cost C(0,0) = b*ln(2), and that
    // is exactly its worst-case loss: the market maker is guaranteed to pay
    // out more than it collects, by up to b*ln(2). That difference IS the
    // liquidity it provides, and it has to be posted up front — otherwise the
    // vault holds only trader deposits and cannot pay a winning position.
    //
    // The rest of the program assumes this money exists: `trade_positions`
    // graduates a market once accumulated fees reach wad_mul(b, LN2_WAD) —
    // i.e. once fees have repaid exactly this subsidy.
    let required_wad = wad_mul(ctx.accounts.amm_state.b, LN2_WAD)
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;
    require!(required_wad >= 0, SoothCoreError::InvalidLiquidity);
    require!(
        args.seed_deposit_wad >= required_wad as u128,
        SoothCoreError::InsufficientSeedDeposit
    );

    // Ceil: round the deposit in the protocol's favour, matching the ceil on
    // the buy path in trade_positions.
    let deposit_usdc = wad_to_usdc_ceil(args.seed_deposit_wad)
        .map_err(|_| error!(SoothCoreError::MathOverflow))?;
    if deposit_usdc > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.creator_amm_ata.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            deposit_usdc,
        )?;
    }

    // The curve is funded, so the market may trade. Set after the deposit
    // transfer, so a failed transfer leaves the market closed rather than
    // open over an empty vault.
    ctx.accounts.amm_state.is_seeded = true;

    let market_id = ctx.accounts.market.market_id;
    let lp_mint_bump = ctx.bumps.lp_mint;
    let lp_mint_authority_bump = ctx.bumps.lp_mint_authority;
    let lp_position_bump = ctx.bumps.lp_position;

    let creator_key = ctx.accounts.creator.key();
    let market_key = ctx.accounts.market.key();
    let lp_mint_key = ctx.accounts.lp_mint.key();

    // ── 2. Create the lp_mint account ─────────────────────────────────────
    //
    // Via `create_pda_account`, which tolerates lamports parked at the
    // address by a griefer and still refuses an already-initialized mint —
    // so `seed_lp` remains once-only per market.
    {
        create_pda_account(
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.lp_mint.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.rent,
            Mint::LEN,
            &token::ID,
            &[b"lp", market_id.as_ref(), &[lp_mint_bump]],
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

    // ── 5. Create the lp_position account ─────────────────────────────────
    {
        create_pda_account(
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.lp_position.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.rent,
            LpPosition::SPACE,
            &crate::ID, // owner = sooth_core
            &[
                b"lp_position",
                market_id.as_ref(),
                creator_key.as_ref(),
                &[lp_position_bump],
            ],
        )?;

        let position = LpPosition {
            reclaimed_base: 0,
            _reserved: [0u8; 24],
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
