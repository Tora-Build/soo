//! Runtime tests for `sooth_book::mint_into_book`.

#[path = "../../sooth_market/tests/common/mod.rs"]
mod common;

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use common::*;
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account, instruction::Instruction, program_pack::Pack, signature::Keypair,
    signer::Signer,
};
use spl_token::state::{Account as TokenAccountState, AccountState};

use sooth_book::instructions::{PRICE_TICK, PRICE_WAD};
use sooth_book::state::market_account::{Market, MarketOrderBehaviour, MarketStatus};
use sooth_book::state::market_liquidities::MarketLiquidities;
use sooth_book::state::market_position_account::MarketPosition;
use sooth_book::state::order_account::{Order, OrderStatus};

const BOOK_ID: Pubkey = sooth_book::ID;
const STAKE: u64 = 100_000_000;
const PRICE_YES: u128 = 400 * PRICE_TICK;
const OUTCOME_NO: u16 = 0;
const OUTCOME_YES: u16 = 1;

struct BookFixture {
    harness: Harness,
    pdas: MarketPdas,
    user: Keypair,
    user_usdc_ata: Pubkey,
    book_market: Pubkey,
    escrow_authority: Pubkey,
    escrow_yes_ata: Pubkey,
    escrow_no_ata: Pubkey,
    liquidities: Pubkey,
    position: Pubkey,
}

impl BookFixture {
    fn boot(book_status: MarketStatus, user_usdc_amount: u64, salt: u8) -> Self {
        let mut harness = Harness::boot();
        load_sooth_book(&mut harness.svm);
        let pdas = bootstrap_market(&mut harness, market_id(salt));

        let user = Keypair::new();
        harness.svm.airdrop(&user.pubkey(), 5_000_000_000).unwrap();

        let creator_for_ata = clone_keypair(&harness.creator);
        let user_usdc_ata =
            ensure_ata(&mut harness.svm, &creator_for_ata, user.pubkey(), USDC_MINT);
        if user_usdc_amount > 0 {
            let mint_authority = clone_keypair(&harness.usdc_mint_authority);
            mint_usdc(
                &mut harness.svm,
                &mint_authority,
                user_usdc_ata,
                user_usdc_amount,
            );
        }

        let (book_market, _) =
            Pubkey::find_program_address(&[b"market", pdas.market.as_ref()], &BOOK_ID);
        let (escrow_authority, escrow_bump) =
            Pubkey::find_program_address(&[b"escrow", book_market.as_ref()], &BOOK_ID);
        let (liquidities, _) =
            Pubkey::find_program_address(&[b"liquidities", book_market.as_ref()], &BOOK_ID);
        let (position, _) = Pubkey::find_program_address(
            &[b"position", book_market.as_ref(), user.pubkey().as_ref()],
            &BOOK_ID,
        );

        write_dummy_pda(&mut harness.svm, escrow_authority, BOOK_ID);
        write_book_market(
            &mut harness.svm,
            book_market,
            pdas.market,
            book_status,
            escrow_bump,
        );
        write_market_liquidities(&mut harness.svm, liquidities, book_market);

        let escrow_yes_ata = spl_associated_token_account::get_associated_token_address(
            &escrow_authority,
            &pdas.yes_mint,
        );
        let escrow_no_ata = spl_associated_token_account::get_associated_token_address(
            &escrow_authority,
            &pdas.no_mint,
        );
        write_token_account(
            &mut harness.svm,
            escrow_yes_ata,
            pdas.yes_mint,
            escrow_authority,
            0,
        );
        write_token_account(
            &mut harness.svm,
            escrow_no_ata,
            pdas.no_mint,
            escrow_authority,
            0,
        );

        Self {
            harness,
            pdas,
            user,
            user_usdc_ata,
            book_market,
            escrow_authority,
            escrow_yes_ata,
            escrow_no_ata,
            liquidities,
            position,
        }
    }

    fn order_yes(&self, seed: u64) -> Pubkey {
        order_pda(self.book_market, seed)
    }

    fn order_no(&self, seed: u64) -> Pubkey {
        order_pda(self.book_market, seed)
    }

    fn ix(&self, price_yes: u128, stake: u64, seed_yes: u64, seed_no: u64) -> Instruction {
        build_ix(
            BOOK_ID,
            sooth_book::accounts::MintIntoBook {
                user: self.user.pubkey(),
                user_usdc_ata: self.user_usdc_ata,
                usdc_mint: USDC_MINT,
                market_pda: self.pdas.market,
                vault_authority: self.pdas.vault_authority,
                yes_mint: self.pdas.yes_mint,
                no_mint: self.pdas.no_mint,
                market_vault: self.pdas.vault,
                book_market: self.book_market,
                market_escrow_yes: self.escrow_yes_ata,
                market_escrow_no: self.escrow_no_ata,
                book_market_escrow_authority: self.escrow_authority,
                order_yes: self.order_yes(seed_yes),
                order_no: self.order_no(seed_no),
                market_liquidities: self.liquidities,
                market_position: self.position,
                sooth_market_program: MARKET_ID,
                token_program: spl_token::ID,
                system_program: solana_sdk::system_program::ID,
                rent: solana_sdk::sysvar::rent::ID,
            },
            sooth_book::instruction::MintIntoBook {
                price_yes,
                stake,
                distinct_seed_yes: seed_yes,
                distinct_seed_no: seed_no,
            },
        )
    }
}

#[test]
fn mint_into_book_happy_path_mints_complete_set_and_posts_resting_orders() {
    let mut fixture = BookFixture::boot(MarketStatus::Open, STAKE, 0x41);
    let ix = fixture.ix(PRICE_YES, STAKE, 11, 12);

    send_ixs(&mut fixture.harness.svm, &fixture.user, &[ix]);

    assert_eq!(
        fetch_token_amount(&fixture.harness.svm, fixture.user_usdc_ata),
        0
    );
    assert_eq!(
        fetch_token_amount(&fixture.harness.svm, fixture.pdas.vault),
        STAKE
    );
    assert_eq!(
        fetch_token_amount(&fixture.harness.svm, fixture.escrow_yes_ata),
        STAKE
    );
    assert_eq!(
        fetch_token_amount(&fixture.harness.svm, fixture.escrow_no_ata),
        STAKE
    );

    let order_yes: Order = fetch_anchor(&fixture.harness.svm, fixture.order_yes(11));
    assert_eq!(order_yes.purchaser, fixture.user.pubkey());
    assert_eq!(order_yes.market, fixture.book_market);
    assert_eq!(order_yes.market_outcome_index, OUTCOME_YES);
    assert!(!order_yes.for_outcome);
    assert_eq!(order_yes.expected_price, PRICE_YES);
    assert_eq!(order_yes.stake_unmatched, STAKE);
    assert_eq!(order_yes.order_status, OrderStatus::Open);

    let order_no: Order = fetch_anchor(&fixture.harness.svm, fixture.order_no(12));
    assert_eq!(order_no.purchaser, fixture.user.pubkey());
    assert_eq!(order_no.market, fixture.book_market);
    assert_eq!(order_no.market_outcome_index, OUTCOME_NO);
    assert!(!order_no.for_outcome);
    assert_eq!(order_no.expected_price, PRICE_WAD - PRICE_YES);
    assert_eq!(order_no.stake_unmatched, STAKE);
    assert_eq!(order_no.order_status, OrderStatus::Open);

    let liquidities: MarketLiquidities = fetch_anchor(&fixture.harness.svm, fixture.liquidities);
    assert_eq!(
        liquidities
            .get_liquidity_against(OUTCOME_YES, PRICE_YES)
            .map(|l| l.liquidity),
        Some(STAKE)
    );
    assert_eq!(
        liquidities
            .get_liquidity_against(OUTCOME_NO, PRICE_WAD - PRICE_YES)
            .map(|l| l.liquidity),
        Some(STAKE)
    );

    let position: MarketPosition = fetch_anchor(&fixture.harness.svm, fixture.position);
    assert_eq!(position.purchaser, fixture.user.pubkey());
    assert_eq!(position.market, fixture.book_market);
    assert_eq!(position.unmatched_exposures.len(), 2);
}

#[test]
fn mint_into_book_rejects_zero_stake() {
    let mut fixture = BookFixture::boot(MarketStatus::Open, STAKE, 0x42);
    let ix = fixture.ix(PRICE_YES, 0, 21, 22);

    let res = try_send_ixs(&mut fixture.harness.svm, &fixture.user, &[ix]);
    assert!(res.is_err(), "zero stake must be rejected");
    assert_eq!(
        fetch_token_amount(&fixture.harness.svm, fixture.escrow_yes_ata),
        0
    );
    assert_eq!(
        fetch_token_amount(&fixture.harness.svm, fixture.pdas.vault),
        0
    );
}

#[test]
fn mint_into_book_rejects_price_zero_or_one_wad() {
    let mut fixture_zero = BookFixture::boot(MarketStatus::Open, STAKE, 0x43);
    let zero_ix = fixture_zero.ix(0, STAKE, 31, 32);
    let zero_res = try_send_ixs(
        &mut fixture_zero.harness.svm,
        &fixture_zero.user,
        &[zero_ix],
    );
    assert!(zero_res.is_err(), "price 0 must be rejected");

    let mut fixture_one = BookFixture::boot(MarketStatus::Open, STAKE, 0x44);
    let one_ix = fixture_one.ix(PRICE_WAD, STAKE, 41, 42);
    let one_res = try_send_ixs(&mut fixture_one.harness.svm, &fixture_one.user, &[one_ix]);
    assert!(one_res.is_err(), "price WAD must be rejected");
}

#[test]
fn mint_into_book_rejects_non_open_book_market() {
    let mut fixture = BookFixture::boot(MarketStatus::Initializing, STAKE, 0x45);
    let ix = fixture.ix(PRICE_YES, STAKE, 51, 52);

    let res = try_send_ixs(&mut fixture.harness.svm, &fixture.user, &[ix]);
    assert!(res.is_err(), "book market must be Open");
    assert_eq!(
        fetch_token_amount(&fixture.harness.svm, fixture.pdas.vault),
        0
    );
}

fn order_pda(book_market: Pubkey, seed: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"order", book_market.as_ref(), &seed.to_le_bytes()],
        &BOOK_ID,
    )
    .0
}

fn load_sooth_book(svm: &mut LiteSVM) {
    let path = target_deploy().join("sooth_book.so");
    assert!(
        path.exists(),
        "missing {}; run `cargo build-sbf` for sooth_book first",
        path.display()
    );
    svm.add_program_from_file(BOOK_ID, &path).unwrap();
}

fn target_deploy() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../../..");
    p.push("target/deploy");
    p.canonicalize()
        .expect("target/deploy not found; run `cargo build-sbf` first")
}

fn write_book_market(
    svm: &mut LiteSVM,
    address: Pubkey,
    sooth_market_pda: Pubkey,
    status: MarketStatus,
    escrow_bump: u8,
) {
    let market = Market {
        authority: Pubkey::new_unique(),
        event_account: Pubkey::new_unique(),
        mint_account: USDC_MINT,
        market_status: status,
        market_type: Pubkey::new_unique(),
        sooth_market_pda,
        fee_b_base_wad: 0,
        market_type_discriminator: None,
        market_type_value: None,
        version: 0,
        decimal_limit: 0,
        published: true,
        suspended: false,
        market_outcomes_count: 2,
        market_winning_outcome_index: None,
        market_lock_timestamp: NOW_TS + 7 * 24 * 60 * 60,
        market_settle_timestamp: None,
        market_lock_order_behaviour: MarketOrderBehaviour::None,
        title: "SoothBook test market".to_string(),
        unsettled_accounts_count: 0,
        unclosed_accounts_count: 0,
        escrow_account_bump: escrow_bump,
        funding_account_bump: 0,
        event_start_timestamp: NOW_TS + 7 * 24 * 60 * 60,
    };
    write_anchor_account(svm, address, BOOK_ID, &market, Market::SIZE);
}

fn write_market_liquidities(svm: &mut LiteSVM, address: Pubkey, market: Pubkey) {
    let liquidities = MarketLiquidities {
        market,
        stake_matched_total: 0,
        liquidities_for: Vec::new(),
        liquidities_against: Vec::new(),
    };
    write_anchor_account(svm, address, BOOK_ID, &liquidities, MarketLiquidities::SIZE);
}

fn write_anchor_account<T: AccountSerialize>(
    svm: &mut LiteSVM,
    address: Pubkey,
    owner: Pubkey,
    value: &T,
    space: usize,
) {
    let mut data = Vec::with_capacity(space);
    value.try_serialize(&mut data).unwrap();
    data.resize(space, 0);
    let lamports = svm.minimum_balance_for_rent_exemption(space);
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn write_dummy_pda(svm: &mut LiteSVM, address: Pubkey, owner: Pubkey) {
    svm.set_account(
        address,
        Account {
            lamports: 1_000_000,
            data: Vec::new(),
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn write_token_account(
    svm: &mut LiteSVM,
    address: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
) {
    let mut data = vec![0u8; TokenAccountState::LEN];
    let account = TokenAccountState {
        mint,
        owner,
        amount,
        delegate: spl_token::solana_program::program_option::COption::None,
        state: AccountState::Initialized,
        is_native: spl_token::solana_program::program_option::COption::None,
        delegated_amount: 0,
        close_authority: spl_token::solana_program::program_option::COption::None,
    };
    TokenAccountState::pack(account, &mut data).unwrap();
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn fetch_anchor<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account missing");
    T::try_deserialize(&mut &account.data[..]).expect("anchor decode failed")
}
