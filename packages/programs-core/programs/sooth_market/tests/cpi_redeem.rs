//! Runtime integration test: end-to-end redeem flow.
//!
//! Architecture §4.5 / EVM `OrderEngine.settlePosition`. Drives:
//!   1. `create_market` (4-leg flow, via the shared harness)
//!   2. `mint_complete_set` — pull USDC from user, mint YES + NO into user
//!      ATAs; user is now long both legs (collateral-backed).
//!   3. `request_lock` (Open → Locked) via the adjudicator program's CPI.
//!   4. `attest_outcome` (Locked → Settled) with a chosen winning outcome.
//!   5. `redeem` — burn the appropriate side(s), pay USDC back per the
//!      `getRedemptionValue` table.
//!
//! Coverage:
//!   - YES wins  → YES burned, NO untouched, USDC paid 1:1 against YES.
//!   - NO  wins  → NO burned, YES untouched, USDC paid 1:1 against NO.
//!   - INVALID   → both sides burned, USDC paid at half-each.
//!   - Unsettled market → redeem rejected with `MarketNotSettled`.
//!
//! Companion to `cpi_settle.rs`, which already verifies the
//! `attest_outcome` half of the settlement flow.

mod common;

use common::*;

use solana_sdk::signer::Signer;
use sooth_market::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};

/// Mint amount used in every test (in USDC base units = outcome-token base
/// units; both share the 6-decimal scale). 100 USDC is comfortably > rent
/// thresholds and large enough for halving on INVALID to land cleanly.
const MINT_AMOUNT: u64 = 100_000_000;

/// Boot the cluster, drive the create-market flow, register the
/// adjudicator, mint MINT_AMOUNT USDC into the user ATA, then mint a
/// complete set so the user holds MINT_AMOUNT YES + MINT_AMOUNT NO.
/// Returns (harness, pdas, user, user_usdc_ata, user_yes_ata, user_no_ata).
fn boot_with_complete_set(
    salt: u8,
) -> (
    Harness,
    MarketPdas,
    solana_sdk::signature::Keypair,
    solana_sdk::pubkey::Pubkey,
    solana_sdk::pubkey::Pubkey,
    solana_sdk::pubkey::Pubkey,
) {
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(salt));
    register_adjudicator(&mut harness, &pdas);

    // The user is a fresh keypair; the creator is reused as fee payer for
    // ATA creation (it's already funded with SOL by Harness::boot).
    let user = solana_sdk::signature::Keypair::new();
    harness.svm.airdrop(&user.pubkey(), 5_000_000_000).unwrap();

    let creator_for_ata = clone_keypair(&harness.creator);
    let user_usdc_ata = ensure_ata(&mut harness.svm, &creator_for_ata, user.pubkey(), USDC_MINT);
    let user_yes_ata = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        user.pubkey(),
        pdas.yes_mint,
    );
    let user_no_ata = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        user.pubkey(),
        pdas.no_mint,
    );

    // Seed user with USDC so mint_complete_set has something to pull.
    let mint_authority = clone_keypair(&harness.usdc_mint_authority);
    mint_usdc(
        &mut harness.svm,
        &mint_authority,
        user_usdc_ata,
        MINT_AMOUNT,
    );

    // Mint a complete set: user pays MINT_AMOUNT USDC, receives MINT_AMOUNT
    // of each side. Signed by the user.
    let mint_ix = build_ix(
        MARKET_ID,
        sooth_market::accounts::MintCompleteSet {
            market: pdas.market,
            vault_authority: pdas.vault_authority,
            yes_mint: pdas.yes_mint,
            no_mint: pdas.no_mint,
            vault: pdas.vault,
            user_usdc_ata,
            user_yes_ata,
            user_no_ata,
            user: user.pubkey(),
            token_program: spl_token::ID,
        },
        sooth_market::instruction::MintCompleteSet {
            amount: MINT_AMOUNT,
        },
    );
    send_ixs(&mut harness.svm, &user, &[mint_ix]);

    // Sanity: user holds MINT_AMOUNT of each outcome, vault holds USDC.
    assert_eq!(fetch_token_amount(&harness.svm, user_yes_ata), MINT_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, user_no_ata), MINT_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, user_usdc_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, pdas.vault), MINT_AMOUNT);

    (
        harness,
        pdas,
        user,
        user_usdc_ata,
        user_yes_ata,
        user_no_ata,
    )
}

/// Lock + settle the market with the chosen outcome. Mirrors the two-step
/// flow that `cpi_settle.rs` already exercises in detail.
fn lock_and_settle(harness: &mut Harness, pdas: &MarketPdas, winning_outcome: u8) {
    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(harness, pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    harness.svm.expire_blockhash();
    let attest_ix = build_attest_outcome_ix(harness, pdas, winning_outcome);
    send_ixs(&mut harness.svm, &creator, &[attest_ix]);
}

/// Build a `redeem` ix wired to `(user, market)`. Signed by the user.
fn build_redeem_ix(
    pdas: &MarketPdas,
    user: &solana_sdk::signature::Keypair,
    user_usdc_ata: solana_sdk::pubkey::Pubkey,
    user_yes_ata: solana_sdk::pubkey::Pubkey,
    user_no_ata: solana_sdk::pubkey::Pubkey,
) -> solana_sdk::instruction::Instruction {
    build_ix(
        MARKET_ID,
        sooth_market::accounts::Redeem {
            market: pdas.market,
            vault_authority: pdas.vault_authority,
            yes_mint: pdas.yes_mint,
            no_mint: pdas.no_mint,
            vault: pdas.vault,
            user_usdc_ata,
            user_yes_ata,
            user_no_ata,
            user: user.pubkey(),
            token_program: spl_token::ID,
        },
        sooth_market::instruction::Redeem {},
    )
}

#[test]
fn redeem_yes_wins_burns_yes_pays_full_usdc() {
    let (mut harness, pdas, user, user_usdc_ata, user_yes_ata, user_no_ata) =
        boot_with_complete_set(0xC1);
    lock_and_settle(&mut harness, &pdas, OUTCOME_YES);

    harness.svm.expire_blockhash();
    let ix = build_redeem_ix(&pdas, &user, user_usdc_ata, user_yes_ata, user_no_ata);
    send_ixs(&mut harness.svm, &user, &[ix]);

    // YES winners receive 1.0 USDC per YES token; NO is worthless and
    // remains in the user's NO ATA (the EVM `OrderEngine.settlePosition`
    // zeroes both sides on the position, but on Solana the SPL tokens are
    // the source of truth — the loser's tokens are simply not redeemed).
    assert_eq!(fetch_token_amount(&harness.svm, user_yes_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, user_no_ata), MINT_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, user_usdc_ata), MINT_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, pdas.vault), 0);
}

#[test]
fn redeem_no_wins_burns_no_pays_full_usdc() {
    let (mut harness, pdas, user, user_usdc_ata, user_yes_ata, user_no_ata) =
        boot_with_complete_set(0xC2);
    lock_and_settle(&mut harness, &pdas, OUTCOME_NO);

    harness.svm.expire_blockhash();
    let ix = build_redeem_ix(&pdas, &user, user_usdc_ata, user_yes_ata, user_no_ata);
    send_ixs(&mut harness.svm, &user, &[ix]);

    assert_eq!(fetch_token_amount(&harness.svm, user_yes_ata), MINT_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, user_no_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, user_usdc_ata), MINT_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, pdas.vault), 0);
}

#[test]
fn redeem_invalid_burns_both_sides_pays_half() {
    let (mut harness, pdas, user, user_usdc_ata, user_yes_ata, user_no_ata) =
        boot_with_complete_set(0xC3);
    lock_and_settle(&mut harness, &pdas, OUTCOME_INVALID);

    harness.svm.expire_blockhash();
    let ix = build_redeem_ix(&pdas, &user, user_usdc_ata, user_yes_ata, user_no_ata);
    send_ixs(&mut harness.svm, &user, &[ix]);

    // INVALID = (yes + no) / 2. With both sides at MINT_AMOUNT the user
    // gets exactly MINT_AMOUNT back — that's the whole-vault unwind path
    // (because `mint_complete_set` left exactly MINT_AMOUNT in the vault).
    assert_eq!(fetch_token_amount(&harness.svm, user_yes_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, user_no_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, user_usdc_ata), MINT_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, pdas.vault), 0);
}

#[test]
fn redeem_before_settle_is_rejected() {
    // Lock the market but skip the attest step → still `Locked`, not
    // `Settled`. The redeem handler's first guard
    // (`require!(market.is_settled(), MarketNotSettled)`) trips.
    let (mut harness, pdas, user, user_usdc_ata, user_yes_ata, user_no_ata) =
        boot_with_complete_set(0xC4);
    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);
    // No attest_outcome ix — market stays Locked.

    harness.svm.expire_blockhash();
    let ix = build_redeem_ix(&pdas, &user, user_usdc_ata, user_yes_ata, user_no_ata);
    let res = try_send_ixs(&mut harness.svm, &user, &[ix]);
    assert!(
        res.is_err(),
        "redeem on a non-Settled market must be rejected"
    );
}
