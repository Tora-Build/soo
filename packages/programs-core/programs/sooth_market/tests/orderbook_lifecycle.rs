mod common;

use anchor_lang::{AccountDeserialize, AccountSerialize};
use common::*;

use solana_sdk::{pubkey::Pubkey, signature::Keypair, signer::Signer};
use sooth_market::state::market::{OUTCOME_INVALID, OUTCOME_NO, OUTCOME_YES};
use sooth_market::state::OrderbookPosition;

const USDC_100: u64 = 100_000_000;
const USDC_50: u64 = 50_000_000;
const USDC_75: u64 = 75_000_000;
const USDC_25: u64 = 25_000_000;
const WAD_PER_USDC_BASE: u128 = 1_000_000_000_000;

struct OrderbookFixture {
    harness: Harness,
    pdas: MarketPdas,
    user: Keypair,
    user_usdc_ata: Pubkey,
    position: Pubkey,
}

fn to_wad(base_units: u64) -> u128 {
    base_units as u128 * WAD_PER_USDC_BASE
}

fn boot_orderbook_fixture(salt: u8, user_usdc_amount: u64) -> OrderbookFixture {
    let mut harness = Harness::boot();
    let pdas = bootstrap_market(&mut harness, market_id(salt));
    register_adjudicator(&mut harness, &pdas);

    let user = Keypair::new();
    harness.svm.airdrop(&user.pubkey(), 5_000_000_000).unwrap();

    let creator = clone_keypair(&harness.creator);
    let user_usdc_ata = ensure_ata(&mut harness.svm, &creator, user.pubkey(), USDC_MINT);
    if user_usdc_amount > 0 {
        let mint_authority = clone_keypair(&harness.usdc_mint_authority);
        mint_usdc(
            &mut harness.svm,
            &mint_authority,
            user_usdc_ata,
            user_usdc_amount,
        );
    }

    let (position, _) = Pubkey::find_program_address(
        &[
            b"orderbook_position",
            pdas.market_id.as_ref(),
            user.pubkey().as_ref(),
        ],
        &MARKET_ID,
    );

    OrderbookFixture {
        harness,
        pdas,
        user,
        user_usdc_ata,
        position,
    }
}

fn build_mint_ix(f: &OrderbookFixture, amount: u64) -> solana_sdk::instruction::Instruction {
    build_ix(
        MARKET_ID,
        sooth_market::accounts::MintCompleteSetForOrderbook {
            market: f.pdas.market,
            position: f.position,
            vault: f.pdas.vault,
            user_usdc_ata: f.user_usdc_ata,
            user: f.user.pubkey(),
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
            rent: solana_sdk::sysvar::rent::ID,
        },
        sooth_market::instruction::MintCompleteSetForOrderbook { amount },
    )
}

fn build_merge_ix(f: &OrderbookFixture, amount: u64) -> solana_sdk::instruction::Instruction {
    build_ix(
        MARKET_ID,
        sooth_market::accounts::MergeCompleteSetForOrderbook {
            market: f.pdas.market,
            vault_authority: f.pdas.vault_authority,
            position: f.position,
            vault: f.pdas.vault,
            user_usdc_ata: f.user_usdc_ata,
            user: f.user.pubkey(),
            token_program: spl_token::ID,
        },
        sooth_market::instruction::MergeCompleteSetForOrderbook { amount },
    )
}

fn build_redeem_ix(f: &OrderbookFixture) -> solana_sdk::instruction::Instruction {
    build_ix(
        MARKET_ID,
        sooth_market::accounts::RedeemOrderbook {
            market: f.pdas.market,
            vault_authority: f.pdas.vault_authority,
            position: f.position,
            vault: f.pdas.vault,
            user_usdc_ata: f.user_usdc_ata,
            user: f.user.pubkey(),
            token_program: spl_token::ID,
        },
        sooth_market::instruction::RedeemOrderbook {},
    )
}

fn mint_orderbook_position(f: &mut OrderbookFixture, amount: u64) {
    let ix = build_mint_ix(f, amount);
    send_ixs(&mut f.harness.svm, &f.user, &[ix]);
}

fn lock_and_settle(f: &mut OrderbookFixture, winning_outcome: u8) {
    let creator = clone_keypair(&f.harness.creator);
    let lock_ix = build_request_lock_ix(&f.harness, &f.pdas);
    send_ixs(&mut f.harness.svm, &creator, &[lock_ix]);

    f.harness.svm.expire_blockhash();
    let attest_ix = build_attest_outcome_ix(&f.harness, &f.pdas, winning_outcome);
    send_ixs(&mut f.harness.svm, &creator, &[attest_ix]);
}

fn fetch_orderbook_position(f: &OrderbookFixture) -> OrderbookPosition {
    let acc = f
        .harness
        .svm
        .get_account(&f.position)
        .expect("orderbook position missing");
    OrderbookPosition::try_deserialize(&mut &acc.data[..]).expect("decode orderbook position")
}

fn set_orderbook_shares(f: &mut OrderbookFixture, yes_shares: u128, no_shares: u128) {
    let mut acc = f
        .harness
        .svm
        .get_account(&f.position)
        .expect("orderbook position missing");
    let mut position =
        OrderbookPosition::try_deserialize(&mut &acc.data[..]).expect("decode position");
    position.yes_shares = yes_shares;
    position.no_shares = no_shares;

    let mut data = Vec::with_capacity(OrderbookPosition::SPACE);
    position
        .try_serialize(&mut data)
        .expect("serialize orderbook position");
    data.resize(OrderbookPosition::SPACE, 0);
    acc.data = data;
    f.harness.svm.set_account(f.position, acc).unwrap();
}

fn assert_position_closed(f: &OrderbookFixture) {
    let maybe = f.harness.svm.get_account(&f.position);
    assert!(
        maybe.as_ref().map(|acc| acc.lamports).unwrap_or(0) == 0,
        "redeem_orderbook must close OrderbookPosition and refund rent"
    );
}

#[test]
fn orderbook_lifecycle_mint_credits_both_sides() {
    let mut f = boot_orderbook_fixture(0x61, USDC_100);
    mint_orderbook_position(&mut f, USDC_100);

    let position = fetch_orderbook_position(&f);
    assert_eq!(position.market, f.pdas.market);
    assert_eq!(position.user, f.user.pubkey());
    assert_eq!(position.yes_shares, to_wad(USDC_100));
    assert_eq!(position.no_shares, to_wad(USDC_100));
    assert_eq!(fetch_token_amount(&f.harness.svm, f.pdas.vault), USDC_100);
    assert_eq!(fetch_token_amount(&f.harness.svm, f.user_usdc_ata), 0);
}

#[test]
fn orderbook_lifecycle_merge_burns_both_sides() {
    let mut f = boot_orderbook_fixture(0x62, USDC_100);
    mint_orderbook_position(&mut f, USDC_100);

    f.harness.svm.expire_blockhash();
    let ix = build_merge_ix(&f, USDC_50);
    send_ixs(&mut f.harness.svm, &f.user, &[ix]);

    let position = fetch_orderbook_position(&f);
    assert_eq!(position.yes_shares, to_wad(USDC_50));
    assert_eq!(position.no_shares, to_wad(USDC_50));
    assert_eq!(fetch_token_amount(&f.harness.svm, f.pdas.vault), USDC_50);
    assert_eq!(fetch_token_amount(&f.harness.svm, f.user_usdc_ata), USDC_50);
}

#[test]
fn orderbook_lifecycle_merge_rejects_insufficient_shares() {
    let mut f = boot_orderbook_fixture(0x63, USDC_100);
    mint_orderbook_position(&mut f, USDC_50);

    f.harness.svm.expire_blockhash();
    let ix = build_merge_ix(&f, USDC_100);
    let res = try_send_ixs(&mut f.harness.svm, &f.user, &[ix]);
    assert!(res.is_err(), "merge above held shares must reject");

    let position = fetch_orderbook_position(&f);
    assert_eq!(position.yes_shares, to_wad(USDC_50));
    assert_eq!(position.no_shares, to_wad(USDC_50));
    assert_eq!(fetch_token_amount(&f.harness.svm, f.pdas.vault), USDC_50);
}

#[test]
fn orderbook_lifecycle_redeem_yes_winner() {
    let mut f = boot_orderbook_fixture(0x64, USDC_100);
    mint_orderbook_position(&mut f, USDC_100);
    set_orderbook_shares(&mut f, to_wad(USDC_100), to_wad(USDC_50));
    lock_and_settle(&mut f, OUTCOME_YES);

    f.harness.svm.expire_blockhash();
    let ix = build_redeem_ix(&f);
    send_ixs(&mut f.harness.svm, &f.user, &[ix]);

    assert_eq!(
        fetch_token_amount(&f.harness.svm, f.user_usdc_ata),
        USDC_100
    );
    assert_eq!(fetch_token_amount(&f.harness.svm, f.pdas.vault), 0);
    assert_position_closed(&f);
}

#[test]
fn orderbook_lifecycle_redeem_no_winner() {
    let mut f = boot_orderbook_fixture(0x65, USDC_100);
    mint_orderbook_position(&mut f, USDC_100);
    set_orderbook_shares(&mut f, to_wad(USDC_100), to_wad(USDC_50));
    lock_and_settle(&mut f, OUTCOME_NO);

    f.harness.svm.expire_blockhash();
    let ix = build_redeem_ix(&f);
    send_ixs(&mut f.harness.svm, &f.user, &[ix]);

    assert_eq!(fetch_token_amount(&f.harness.svm, f.user_usdc_ata), USDC_50);
    assert_eq!(fetch_token_amount(&f.harness.svm, f.pdas.vault), USDC_50);
    assert_position_closed(&f);
}

#[test]
fn orderbook_lifecycle_redeem_invalid() {
    let mut f = boot_orderbook_fixture(0x66, USDC_100);
    mint_orderbook_position(&mut f, USDC_100);
    set_orderbook_shares(&mut f, to_wad(USDC_100), to_wad(USDC_50));
    lock_and_settle(&mut f, OUTCOME_INVALID);

    f.harness.svm.expire_blockhash();
    let ix = build_redeem_ix(&f);
    send_ixs(&mut f.harness.svm, &f.user, &[ix]);

    assert_eq!(fetch_token_amount(&f.harness.svm, f.user_usdc_ata), USDC_75);
    assert_eq!(fetch_token_amount(&f.harness.svm, f.pdas.vault), USDC_25);
    assert_position_closed(&f);
}

#[test]
fn orderbook_lifecycle_redeem_post_settle_only() {
    let mut f = boot_orderbook_fixture(0x67, USDC_100);
    mint_orderbook_position(&mut f, USDC_100);

    f.harness.svm.expire_blockhash();
    let ix = build_redeem_ix(&f);
    let res = try_send_ixs(&mut f.harness.svm, &f.user, &[ix]);
    assert!(
        res.is_err(),
        "redeem_orderbook before settlement must reject"
    );
}

#[test]
fn orderbook_lifecycle_mint_post_settle_rejects() {
    let mut f = boot_orderbook_fixture(0x68, USDC_100);
    lock_and_settle(&mut f, OUTCOME_YES);

    f.harness.svm.expire_blockhash();
    let ix = build_mint_ix(&f, USDC_100);
    let res = try_send_ixs(&mut f.harness.svm, &f.user, &[ix]);
    assert!(
        res.is_err(),
        "mint_orderbook on a settled market must reject"
    );
    assert_eq!(
        fetch_token_amount(&f.harness.svm, f.user_usdc_ata),
        USDC_100
    );
}
