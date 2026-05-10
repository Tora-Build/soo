//! Runtime integration tests for `mint_complete_set_to_program_owned`.
//!
//! The variant splits the paying authority from the outcome-token owner:
//! payer USDC is debited, while YES/NO are minted into token accounts owned
//! by an arbitrary destination authority.

mod common;

use common::*;

use solana_sdk::{pubkey::Pubkey, signature::Keypair, signer::Signer};

const MINT_AMOUNT: u64 = 100_000_000;

struct ProgramOwnedMintFixture {
    harness: Harness,
    pdas: MarketPdas,
    payer: Keypair,
    payer_usdc_ata: Pubkey,
    destination_authority: Pubkey,
    destination_yes_ata: Pubkey,
    destination_no_ata: Pubkey,
}

fn boot_with_destination(salt: u8, payer_usdc_amount: u64) -> ProgramOwnedMintFixture {
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(salt));
    register_adjudicator(&mut harness, &pdas);

    let payer = Keypair::new();
    harness.svm.airdrop(&payer.pubkey(), 5_000_000_000).unwrap();

    let creator_for_ata = clone_keypair(&harness.creator);
    let payer_usdc_ata = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        payer.pubkey(),
        USDC_MINT,
    );

    let (destination_authority, _) =
        Pubkey::find_program_address(&[b"program-owned-dest", pdas.market.as_ref()], &MARKET_ID);
    let destination_yes_ata = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        destination_authority,
        pdas.yes_mint,
    );
    let destination_no_ata = ensure_ata(
        &mut harness.svm,
        &creator_for_ata,
        destination_authority,
        pdas.no_mint,
    );

    if payer_usdc_amount > 0 {
        let mint_authority = clone_keypair(&harness.usdc_mint_authority);
        mint_usdc(
            &mut harness.svm,
            &mint_authority,
            payer_usdc_ata,
            payer_usdc_amount,
        );
    }

    ProgramOwnedMintFixture {
        harness,
        pdas,
        payer,
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
    }
}

fn build_mint_to_program_owned_ix(
    pdas: &MarketPdas,
    payer: Pubkey,
    payer_usdc_ata: Pubkey,
    destination_authority: Pubkey,
    destination_yes_ata: Pubkey,
    destination_no_ata: Pubkey,
    yes_mint: Pubkey,
    no_mint: Pubkey,
    amount: u64,
) -> solana_sdk::instruction::Instruction {
    build_ix(
        MARKET_ID,
        sooth_market::accounts::MintCompleteSetToProgramOwned {
            payer,
            payer_usdc_ata,
            usdc_mint: USDC_MINT,
            destination_authority,
            destination_yes_ata,
            destination_no_ata,
            market: pdas.market,
            market_vault: pdas.vault,
            vault_authority: pdas.vault_authority,
            yes_mint,
            no_mint,
            token_program: spl_token::ID,
        },
        sooth_market::instruction::MintCompleteSetToProgramOwned { amount },
    )
}

#[test]
fn mint_to_program_owned_happy_path_splits_payer_and_destination() {
    let ProgramOwnedMintFixture {
        mut harness,
        pdas,
        payer,
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
    } = boot_with_destination(0xE1, MINT_AMOUNT);

    let ix = build_mint_to_program_owned_ix(
        &pdas,
        payer.pubkey(),
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
        pdas.yes_mint,
        pdas.no_mint,
        MINT_AMOUNT,
    );
    send_ixs(&mut harness.svm, &payer, &[ix]);

    assert_eq!(fetch_token_amount(&harness.svm, payer_usdc_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, pdas.vault), MINT_AMOUNT);
    assert_eq!(
        fetch_token_amount(&harness.svm, destination_yes_ata),
        MINT_AMOUNT
    );
    assert_eq!(
        fetch_token_amount(&harness.svm, destination_no_ata),
        MINT_AMOUNT
    );
}

#[test]
fn mint_to_program_owned_rejects_insufficient_usdc() {
    let ProgramOwnedMintFixture {
        mut harness,
        pdas,
        payer,
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
    } = boot_with_destination(0xE2, MINT_AMOUNT - 1);

    let ix = build_mint_to_program_owned_ix(
        &pdas,
        payer.pubkey(),
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
        pdas.yes_mint,
        pdas.no_mint,
        MINT_AMOUNT,
    );
    let res = try_send_ixs(&mut harness.svm, &payer, &[ix]);
    assert!(res.is_err(), "insufficient payer USDC must be rejected");
    assert_eq!(fetch_token_amount(&harness.svm, destination_yes_ata), 0);
    assert_eq!(fetch_token_amount(&harness.svm, destination_no_ata), 0);
}

#[test]
fn mint_to_program_owned_rejects_wrong_destination_authority() {
    let ProgramOwnedMintFixture {
        mut harness,
        pdas,
        payer,
        payer_usdc_ata,
        destination_yes_ata,
        destination_no_ata,
        ..
    } = boot_with_destination(0xE3, MINT_AMOUNT);
    let wrong_destination_authority = Pubkey::new_unique();

    let ix = build_mint_to_program_owned_ix(
        &pdas,
        payer.pubkey(),
        payer_usdc_ata,
        wrong_destination_authority,
        destination_yes_ata,
        destination_no_ata,
        pdas.yes_mint,
        pdas.no_mint,
        MINT_AMOUNT,
    );
    let res = try_send_ixs(&mut harness.svm, &payer, &[ix]);
    assert!(
        res.is_err(),
        "destination ATAs owned by a different authority must be rejected"
    );
}

#[test]
fn mint_to_program_owned_rejects_wrong_yes_mint() {
    let ProgramOwnedMintFixture {
        mut harness,
        pdas,
        payer,
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
    } = boot_with_destination(0xE4, MINT_AMOUNT);

    let ix = build_mint_to_program_owned_ix(
        &pdas,
        payer.pubkey(),
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
        pdas.no_mint,
        pdas.no_mint,
        MINT_AMOUNT,
    );
    let res = try_send_ixs(&mut harness.svm, &payer, &[ix]);
    assert!(res.is_err(), "wrong YES mint must be rejected");
}

#[test]
fn mint_to_program_owned_rejects_wrong_no_mint() {
    let ProgramOwnedMintFixture {
        mut harness,
        pdas,
        payer,
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
    } = boot_with_destination(0xE5, MINT_AMOUNT);

    let ix = build_mint_to_program_owned_ix(
        &pdas,
        payer.pubkey(),
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
        pdas.yes_mint,
        pdas.yes_mint,
        MINT_AMOUNT,
    );
    let res = try_send_ixs(&mut harness.svm, &payer, &[ix]);
    assert!(res.is_err(), "wrong NO mint must be rejected");
}

#[test]
fn mint_to_program_owned_rejects_non_open_market() {
    let ProgramOwnedMintFixture {
        mut harness,
        pdas,
        payer,
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
    } = boot_with_destination(0xE6, MINT_AMOUNT);

    let creator = clone_keypair(&harness.creator);
    let lock_ix = build_request_lock_ix(&harness, &pdas);
    send_ixs(&mut harness.svm, &creator, &[lock_ix]);

    harness.svm.expire_blockhash();
    let ix = build_mint_to_program_owned_ix(
        &pdas,
        payer.pubkey(),
        payer_usdc_ata,
        destination_authority,
        destination_yes_ata,
        destination_no_ata,
        pdas.yes_mint,
        pdas.no_mint,
        MINT_AMOUNT,
    );
    let res = try_send_ixs(&mut harness.svm, &payer, &[ix]);
    assert!(res.is_err(), "non-Open market must reject minting");
}
