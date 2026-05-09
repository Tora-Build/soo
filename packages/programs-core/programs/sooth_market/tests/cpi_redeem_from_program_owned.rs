//! Runtime integration tests for `redeem_from_program_owned`.
//!
//! The variant burns requested YES/NO amounts from accounts owned by a burn
//! authority and pays USDC to an unrelated destination token account.

mod common;

use common::*;

use solana_sdk::{pubkey::Pubkey, signature::Keypair, signer::Signer};
use sooth_market::state::market::{OUTCOME_INVALID, OUTCOME_YES};

const REDEEM_AMOUNT: u64 = 100_000_000;

struct ProgramOwnedRedeemFixture {
    harness: Harness,
    pdas: MarketPdas,
    burn_authority: Keypair,
    source_yes_ata: Pubkey,
    source_no_ata: Pubkey,
    usdc_destination: Pubkey,
}

fn boot_with_program_owned_complete_set(salt: u8) -> ProgramOwnedRedeemFixture {
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(salt));
    register_adjudicator(&mut harness, &pdas);

    let payer = Keypair::new();
    harness.svm.airdrop(&payer.pubkey(), 5_000_000_000).unwrap();
    let burn_authority = Keypair::new();
    harness
        .svm
        .airdrop(&burn_authority.pubkey(), 5_000_000_000)
        .unwrap();
    let recipient = Keypair::new();
    harness
        .svm
        .airdrop(&recipient.pubkey(), 5_000_000_000)
        .unwrap();

    let creator_for_ata = clone_keypair(&harness.creator);
    let payer_usdc_ata = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        payer.pubkey(),
        USDC_MINT,
    );
    let source_yes_ata = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        burn_authority.pubkey(),
        pdas.yes_mint,
    );
    let source_no_ata = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        burn_authority.pubkey(),
        pdas.no_mint,
    );
    let usdc_destination = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        recipient.pubkey(),
        USDC_MINT,
    );

    let mint_authority = clone_keypair(&harness.usdc_mint_authority);
    mint_usdc(
        &mut harness.svm,
        &mint_authority,
        payer_usdc_ata,
        REDEEM_AMOUNT,
    );

    let mint_ix = build_ix(
        MARKET_ID,
        sooth_market::accounts::MintCompleteSetToProgramOwned {
            market: pdas.market,
            vault_authority: pdas.vault_authority,
            yes_mint: pdas.yes_mint,
            no_mint: pdas.no_mint,
            usdc_mint: USDC_MINT,
            market_vault: pdas.vault,
            payer_usdc_ata,
            destination_authority: burn_authority.pubkey(),
            destination_yes_ata: source_yes_ata,
            destination_no_ata: source_no_ata,
            payer: payer.pubkey(),
            token_program: spl_token::ID,
        },
        sooth_market::instruction::MintCompleteSetToProgramOwned {
            amount: REDEEM_AMOUNT,
        },
    );
    send_ixs(&mut harness.svm, &payer, &[mint_ix]);

    assert_eq!(fetch_token_amount(&harness.svm, source_yes_ata), REDEEM_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, source_no_ata), REDEEM_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, pdas.vault), REDEEM_AMOUNT);

    ProgramOwnedRedeemFixture {
        harness,
        pdas,
        burn_authority,
        source_yes_ata,
        source_no_ata,
        usdc_destination,
    }
}

fn lock_and_settle(harness: &mut Harness, pdas: &MarketPdas, winning_outcome: u8) {
    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(harness, pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    harness.svm.expire_blockhash();
    let attest_ix = build_attest_outcome_ix(harness, pdas, winning_outcome);
    send_ixs(&mut harness.svm, &creator, &[attest_ix]);
}

fn build_redeem_from_program_owned_ix(
    pdas: &MarketPdas,
    burn_authority: Pubkey,
    source_yes_ata: Pubkey,
    source_no_ata: Pubkey,
    usdc_destination: Pubkey,
    amount_yes: u64,
    amount_no: u64,
) -> solana_sdk::instruction::Instruction {
    build_ix(
        MARKET_ID,
        sooth_market::accounts::RedeemFromProgramOwned {
            market: pdas.market,
            vault_authority: pdas.vault_authority,
            yes_mint: pdas.yes_mint,
            no_mint: pdas.no_mint,
            usdc_mint: USDC_MINT,
            market_vault: pdas.vault,
            source_yes_ata,
            source_no_ata,
            usdc_destination,
            burn_authority,
            token_program: spl_token::ID,
        },
        sooth_market::instruction::RedeemFromProgramOwned {
            amount_yes,
            amount_no,
        },
    )
}

#[test]
fn redeem_from_program_owned_yes_winner_burns_yes_and_pays_full() {
    let ProgramOwnedRedeemFixture {
        mut harness,
        pdas,
        burn_authority,
        source_yes_ata,
        source_no_ata,
        usdc_destination,
    } = boot_with_program_owned_complete_set(0xF1);
    lock_and_settle(&mut harness, &pdas, OUTCOME_YES);

    harness.svm.expire_blockhash();
    let ix = build_redeem_from_program_owned_ix(
        &pdas,
        burn_authority.pubkey(),
        source_yes_ata,
        source_no_ata,
        usdc_destination,
        REDEEM_AMOUNT,
        0,
    );
    send_ixs(&mut harness.svm, &burn_authority, &[ix]);

    assert_eq!(fetch_token_amount(&harness.svm, source_yes_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, source_no_ata), REDEEM_AMOUNT);
    assert_eq!(
        fetch_token_amount(&harness.svm, usdc_destination),
        REDEEM_AMOUNT
    );
    assert_eq!(fetch_token_amount(&harness.svm, pdas.vault), 0);
}

#[test]
fn redeem_from_program_owned_loser_burns_no_and_pays_zero_when_yes_wins() {
    let ProgramOwnedRedeemFixture {
        mut harness,
        pdas,
        burn_authority,
        source_yes_ata,
        source_no_ata,
        usdc_destination,
    } = boot_with_program_owned_complete_set(0xF2);
    lock_and_settle(&mut harness, &pdas, OUTCOME_YES);

    harness.svm.expire_blockhash();
    let ix = build_redeem_from_program_owned_ix(
        &pdas,
        burn_authority.pubkey(),
        source_yes_ata,
        source_no_ata,
        usdc_destination,
        0,
        REDEEM_AMOUNT,
    );
    send_ixs(&mut harness.svm, &burn_authority, &[ix]);

    assert_eq!(fetch_token_amount(&harness.svm, source_yes_ata), REDEEM_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, source_no_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, usdc_destination), 0);
    assert_eq!(fetch_token_amount(&harness.svm, pdas.vault), REDEEM_AMOUNT);
}

#[test]
fn redeem_from_program_owned_invalid_burns_yes_and_pays_half() {
    let ProgramOwnedRedeemFixture {
        mut harness,
        pdas,
        burn_authority,
        source_yes_ata,
        source_no_ata,
        usdc_destination,
    } = boot_with_program_owned_complete_set(0xF3);
    lock_and_settle(&mut harness, &pdas, OUTCOME_INVALID);

    harness.svm.expire_blockhash();
    let ix = build_redeem_from_program_owned_ix(
        &pdas,
        burn_authority.pubkey(),
        source_yes_ata,
        source_no_ata,
        usdc_destination,
        REDEEM_AMOUNT,
        0,
    );
    send_ixs(&mut harness.svm, &burn_authority, &[ix]);

    assert_eq!(fetch_token_amount(&harness.svm, source_yes_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, source_no_ata), REDEEM_AMOUNT);
    assert_eq!(
        fetch_token_amount(&harness.svm, usdc_destination),
        REDEEM_AMOUNT / 2
    );
    assert_eq!(
        fetch_token_amount(&harness.svm, pdas.vault),
        REDEEM_AMOUNT / 2
    );
}

#[test]
fn redeem_from_program_owned_invalid_burns_no_and_pays_half() {
    let ProgramOwnedRedeemFixture {
        mut harness,
        pdas,
        burn_authority,
        source_yes_ata,
        source_no_ata,
        usdc_destination,
    } = boot_with_program_owned_complete_set(0xF4);
    lock_and_settle(&mut harness, &pdas, OUTCOME_INVALID);

    harness.svm.expire_blockhash();
    let ix = build_redeem_from_program_owned_ix(
        &pdas,
        burn_authority.pubkey(),
        source_yes_ata,
        source_no_ata,
        usdc_destination,
        0,
        REDEEM_AMOUNT,
    );
    send_ixs(&mut harness.svm, &burn_authority, &[ix]);

    assert_eq!(fetch_token_amount(&harness.svm, source_yes_ata), REDEEM_AMOUNT);
    assert_eq!(fetch_token_amount(&harness.svm, source_no_ata), 0);
    assert_eq!(
        fetch_token_amount(&harness.svm, usdc_destination),
        REDEEM_AMOUNT / 2
    );
    assert_eq!(
        fetch_token_amount(&harness.svm, pdas.vault),
        REDEEM_AMOUNT / 2
    );
}

#[test]
fn redeem_from_program_owned_rejects_wrong_burn_authority_signer() {
    let ProgramOwnedRedeemFixture {
        mut harness,
        pdas,
        source_yes_ata,
        source_no_ata,
        usdc_destination,
        ..
    } = boot_with_program_owned_complete_set(0xF5);
    lock_and_settle(&mut harness, &pdas, OUTCOME_YES);

    let wrong_burn_authority = Keypair::new();
    harness
        .svm
        .airdrop(&wrong_burn_authority.pubkey(), 5_000_000_000)
        .unwrap();
    harness.svm.expire_blockhash();
    let ix = build_redeem_from_program_owned_ix(
        &pdas,
        wrong_burn_authority.pubkey(),
        source_yes_ata,
        source_no_ata,
        usdc_destination,
        REDEEM_AMOUNT,
        0,
    );
    let res = try_send_ixs(&mut harness.svm, &wrong_burn_authority, &[ix]);
    assert!(
        res.is_err(),
        "source token accounts owned by a different burn authority must be rejected"
    );
}

#[test]
fn redeem_from_program_owned_rejects_unsettled_market() {
    let ProgramOwnedRedeemFixture {
        mut harness,
        pdas,
        burn_authority,
        source_yes_ata,
        source_no_ata,
        usdc_destination,
    } = boot_with_program_owned_complete_set(0xF6);

    let ix = build_redeem_from_program_owned_ix(
        &pdas,
        burn_authority.pubkey(),
        source_yes_ata,
        source_no_ata,
        usdc_destination,
        REDEEM_AMOUNT,
        0,
    );
    let res = try_send_ixs(&mut harness.svm, &burn_authority, &[ix]);
    assert!(res.is_err(), "non-Settled market must reject redemption");
}
