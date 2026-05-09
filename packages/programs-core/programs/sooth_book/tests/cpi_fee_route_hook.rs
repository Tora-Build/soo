//! Runtime test for SoothBook's fill fee route hook.

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

use sooth_book::instructions::{fee_route::WAD_TO_USDC_SCALAR, PRICE_TICK};
use sooth_book::state::market_account::{Market, MarketOrderBehaviour, MarketStatus};
use sooth_book::state::market_liquidities::MarketLiquidities;
use sooth_book::state::market_matching_pool_account::{Cirque, MarketMatchingPool};
use sooth_book::state::market_outcome_account::MarketOutcome;
use sooth_book::state::market_position_account::MarketPosition;
use sooth_book::state::order_account::{Order, OrderStatus};
use sooth_book::AuthorisedOperators;

const BOOK_ID: Pubkey = sooth_book::ID;
const STAKE: u64 = 1_000_000;
const PRICE: u128 = 400 * PRICE_TICK;
const FEE_BPS: u16 = 100;

struct FeeFixture {
    harness: Harness,
    crank: Keypair,
    market: Pubkey,
    market_escrow: Pubkey,
    fee_pool_authority: Pubkey,
    fee_pool_vault: Pubkey,
    authorised_operators: Pubkey,
    market_outcome: Pubkey,
    order_for: Pubkey,
    order_against: Pubkey,
    market_position_for: Pubkey,
    market_position_against: Pubkey,
    market_matching_pool_for: Pubkey,
    market_matching_pool_against: Pubkey,
    market_liquidities: Pubkey,
    purchaser_token_for: Pubkey,
    purchaser_token_against: Pubkey,
}

impl FeeFixture {
    fn boot() -> Self {
        let mut harness = Harness::boot();
        load_sooth_book(&mut harness.svm);

        let crank = Keypair::new();
        harness.svm.airdrop(&crank.pubkey(), 5_000_000_000).unwrap();

        let sooth_market_pda = Pubkey::new_unique();
        let (market, _) =
            Pubkey::find_program_address(&[b"market", sooth_market_pda.as_ref()], &BOOK_ID);
        let (market_escrow, escrow_bump) =
            Pubkey::find_program_address(&[b"escrow", market.as_ref()], &BOOK_ID);
        let (authorised_operators, _) =
            Pubkey::find_program_address(&[b"authorised_operators", b"CRANK"], &BOOK_ID);
        let (market_outcome, _) = Pubkey::find_program_address(&[market.as_ref(), b"0"], &BOOK_ID);
        let (market_liquidities, _) =
            Pubkey::find_program_address(&[b"liquidities", market.as_ref()], &BOOK_ID);

        let (fee_pool_authority, _) =
            Pubkey::find_program_address(&[b"fee_pool_authority"], &LAUNCHPAD_ID);
        let fee_pool_vault = spl_associated_token_account::get_associated_token_address(
            &fee_pool_authority,
            &USDC_MINT,
        );
        write_dummy_pda(&mut harness.svm, fee_pool_authority, LAUNCHPAD_ID);
        write_token_account(
            &mut harness.svm,
            fee_pool_vault,
            USDC_MINT,
            fee_pool_authority,
            0,
        );

        write_book_market(&mut harness.svm, market, sooth_market_pda, escrow_bump);
        write_token_account(
            &mut harness.svm,
            market_escrow,
            USDC_MINT,
            market_escrow,
            10_000_000,
        );
        write_authorised_operators(&mut harness.svm, authorised_operators, crank.pubkey());
        write_market_outcome(&mut harness.svm, market_outcome, market);

        let purchaser_for = Keypair::new();
        let purchaser_against = Keypair::new();
        let purchaser_token_for = spl_associated_token_account::get_associated_token_address(
            &purchaser_for.pubkey(),
            &USDC_MINT,
        );
        let purchaser_token_against = spl_associated_token_account::get_associated_token_address(
            &purchaser_against.pubkey(),
            &USDC_MINT,
        );
        write_token_account(
            &mut harness.svm,
            purchaser_token_for,
            USDC_MINT,
            purchaser_for.pubkey(),
            0,
        );
        write_token_account(
            &mut harness.svm,
            purchaser_token_against,
            USDC_MINT,
            purchaser_against.pubkey(),
            0,
        );

        let order_for = Pubkey::new_unique();
        let order_against = Pubkey::new_unique();
        write_order(
            &mut harness.svm,
            order_for,
            market,
            purchaser_for.pubkey(),
            true,
            1,
            STAKE,
        );
        write_order(
            &mut harness.svm,
            order_against,
            market,
            purchaser_against.pubkey(),
            false,
            2,
            STAKE,
        );

        let market_position_for = Pubkey::new_unique();
        let market_position_against = Pubkey::new_unique();
        write_market_position(
            &mut harness.svm,
            market_position_for,
            market,
            purchaser_for.pubkey(),
            true,
        );
        write_market_position(
            &mut harness.svm,
            market_position_against,
            market,
            purchaser_against.pubkey(),
            false,
        );

        let market_matching_pool_for = matching_pool_pda(market, true);
        let market_matching_pool_against = matching_pool_pda(market, false);
        write_matching_pool(
            &mut harness.svm,
            market_matching_pool_for,
            market,
            true,
            order_for,
        );
        write_matching_pool(
            &mut harness.svm,
            market_matching_pool_against,
            market,
            false,
            order_against,
        );
        write_market_liquidities(&mut harness.svm, market_liquidities, market);

        Self {
            harness,
            crank,
            market,
            market_escrow,
            fee_pool_authority,
            fee_pool_vault,
            authorised_operators,
            market_outcome,
            order_for,
            order_against,
            market_position_for,
            market_position_against,
            market_matching_pool_for,
            market_matching_pool_against,
            market_liquidities,
            purchaser_token_for,
            purchaser_token_against,
        }
    }

    fn ix(&self) -> Instruction {
        let trade_for_seed = [1u8; 16];
        let trade_against_seed = [2u8; 16];
        build_ix(
            BOOK_ID,
            sooth_book::accounts::MatchOrders {
                order_against: self.order_against,
                trade_against: trade_pda(self.order_against, trade_against_seed),
                market_position_against: self.market_position_against,
                market_matching_pool_against: self.market_matching_pool_against,
                order_for: self.order_for,
                trade_for: trade_pda(self.order_for, trade_for_seed),
                market_position_for: self.market_position_for,
                market_matching_pool_for: self.market_matching_pool_for,
                market: self.market,
                market_outcome: self.market_outcome,
                crank_operator: self.crank.pubkey(),
                authorised_operators: self.authorised_operators,
                purchaser_token_account_for: self.purchaser_token_for,
                purchaser_token_account_against: self.purchaser_token_against,
                market_escrow: self.market_escrow,
                protocol_config: self.harness.protocol_config_pda,
                fee_pool_authority: self.fee_pool_authority,
                fee_pool_vault: self.fee_pool_vault,
                market_liquidities: self.market_liquidities,
                token_program: spl_token::ID,
                system_program: solana_sdk::system_program::ID,
            },
            sooth_book::instruction::MatchOrders {
                trade_for_seed,
                trade_against_seed,
            },
        )
    }
}

#[test]
fn match_orders_records_fee_and_transfers_to_fee_pool() {
    let mut fixture = FeeFixture::boot();
    let ix = fixture.ix();

    send_ixs(&mut fixture.harness.svm, &fixture.crank, &[ix]);

    let market: Market = fetch_anchor(&fixture.harness.svm, fixture.market);
    let expected_fee_wad = (STAKE as u128)
        .checked_mul(WAD_TO_USDC_SCALAR)
        .unwrap()
        .checked_mul(FEE_BPS as u128)
        .unwrap()
        / 10_000;
    assert_eq!(market.fee_b_base_wad, expected_fee_wad);
    assert_eq!(
        fetch_token_amount(&fixture.harness.svm, fixture.fee_pool_vault),
        10_000
    );
}

fn matching_pool_pda(market: Pubkey, for_outcome: bool) -> Pubkey {
    Pubkey::find_program_address(
        &[
            market.as_ref(),
            b"0",
            b"-",
            PRICE.to_le_bytes().as_ref(),
            for_outcome.to_string().as_ref(),
        ],
        &BOOK_ID,
    )
    .0
}

fn trade_pda(order: Pubkey, seed: [u8; 16]) -> Pubkey {
    Pubkey::find_program_address(&[order.as_ref(), &seed], &BOOK_ID).0
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
    escrow_bump: u8,
) {
    let market = Market {
        authority: Pubkey::new_unique(),
        event_account: Pubkey::new_unique(),
        mint_account: USDC_MINT,
        market_status: MarketStatus::Open,
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
        title: "SoothBook fee test market".to_string(),
        unsettled_accounts_count: 0,
        unclosed_accounts_count: 0,
        escrow_account_bump: escrow_bump,
        funding_account_bump: 0,
        event_start_timestamp: NOW_TS + 7 * 24 * 60 * 60,
    };
    write_anchor_account(svm, address, BOOK_ID, &market, Market::SIZE);
}

fn write_authorised_operators(svm: &mut LiteSVM, address: Pubkey, crank: Pubkey) {
    let operators = AuthorisedOperators {
        authority: Pubkey::new_unique(),
        operator_list: vec![crank],
    };
    write_anchor_account(svm, address, BOOK_ID, &operators, AuthorisedOperators::SIZE);
}

fn write_market_outcome(svm: &mut LiteSVM, address: Pubkey, market: Pubkey) {
    let outcome = MarketOutcome {
        market,
        index: 0,
        title: "YES".to_string(),
        prices: None,
        price_ladder: vec![],
    };
    write_anchor_account(svm, address, BOOK_ID, &outcome, MarketOutcome::SIZE);
}

fn write_order(
    svm: &mut LiteSVM,
    address: Pubkey,
    market: Pubkey,
    purchaser: Pubkey,
    for_outcome: bool,
    creation_timestamp: i64,
    stake: u64,
) {
    let order = Order {
        purchaser,
        market,
        market_outcome_index: 0,
        for_outcome,
        order_status: OrderStatus::Open,
        stake,
        voided_stake: 0,
        expected_price: PRICE,
        creation_timestamp,
        stake_unmatched: stake,
        payout: 0,
        payer: purchaser,
    };
    write_anchor_account(svm, address, BOOK_ID, &order, Order::SIZE);
}

fn write_market_position(
    svm: &mut LiteSVM,
    address: Pubkey,
    market: Pubkey,
    purchaser: Pubkey,
    for_outcome: bool,
) {
    let mut position = MarketPosition {
        purchaser,
        market,
        paid: false,
        market_outcome_sums: vec![0, 0],
        unmatched_exposures: vec![0, 0],
        payer: purchaser,
    };
    sooth_book::instructions::market_position::update_on_order_request_creation(
        &mut position,
        0,
        for_outcome,
        STAKE,
        PRICE,
    )
    .unwrap();
    write_anchor_account(
        svm,
        address,
        BOOK_ID,
        &position,
        MarketPosition::size_for(2),
    );
}

fn write_matching_pool(
    svm: &mut LiteSVM,
    address: Pubkey,
    market: Pubkey,
    for_outcome: bool,
    order: Pubkey,
) {
    let mut orders = Cirque::new(MarketMatchingPool::QUEUE_LENGTH);
    orders.enqueue(order).unwrap();
    let pool = MarketMatchingPool {
        market,
        market_outcome_index: 0,
        for_outcome,
        price: PRICE,
        payer: Pubkey::new_unique(),
        liquidity_amount: STAKE,
        matched_amount: 0,
        orders,
    };
    write_anchor_account(svm, address, BOOK_ID, &pool, MarketMatchingPool::SIZE);
}

fn write_market_liquidities(svm: &mut LiteSVM, address: Pubkey, market: Pubkey) {
    let mut liquidities = MarketLiquidities {
        market,
        stake_matched_total: 0,
        liquidities_for: Vec::new(),
        liquidities_against: Vec::new(),
    };
    liquidities.add_liquidity_for(0, PRICE, STAKE).unwrap();
    liquidities.add_liquidity_against(0, PRICE, STAKE).unwrap();
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
