use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account, compute_budget::ComputeBudgetInstruction, instruction::Instruction,
    message::Message, program_pack::Pack, signature::Keypair, signer::Signer, sysvar::clock::Clock,
    transaction::Transaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account_idempotent,
};
use spl_token::state::Mint;

use sooth_book::math::{min_resting_order_for_tick, NUM_TICKS};
use sooth_book::state::{BookSide, MarketBook, SIDE_FOR};

const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;
const BOOK_ID: Pubkey = sooth_book::ID;
const MARKET_ID: Pubkey = sooth_market::ID;
const AMM_ID: Pubkey = sooth_amm::ID;
const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;
const NOW_TS: i64 = 1_000_000;
const INITIAL_B_WAD: u128 = 1_000_000_000_000_000_000_000;
const WAD: u128 = 1_000_000_000_000_000_000;
const TICK: u16 = 500;

struct Fixture {
    svm: LiteSVM,
    creator: Keypair,
    mint_authority: Keypair,
    pdas: MarketPdas,
}

struct Trader {
    keypair: Keypair,
    usdc_ata: Pubkey,
    orderbook_position: Pubkey,
}

struct MarketPdas {
    market_id: [u8; 16],
    market: Pubkey,
    vault_authority: Pubkey,
    fee_pool_authority: Pubkey,
    lock_authority: Pubkey,
    yes_mint: Pubkey,
    no_mint: Pubkey,
    vault: Pubkey,
    lock_vault: Pubkey,
    amm_state: Pubkey,
    market_fee_pool: Pubkey,
    protocol_config: Pubkey,
    market_book: Pubkey,
}

impl MarketPdas {
    fn derive(market_id: [u8; 16]) -> Self {
        let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &MARKET_ID);
        let (vault_authority, _) =
            Pubkey::find_program_address(&[b"vault", &market_id], &MARKET_ID);
        let (fee_pool_authority, _) =
            Pubkey::find_program_address(&[b"fee_pool_authority"], &LAUNCHPAD_ID);
        let (lock_authority, _) = Pubkey::find_program_address(&[b"lock", &market_id], &MARKET_ID);
        let (yes_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"y"], &MARKET_ID);
        let (no_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"n"], &MARKET_ID);
        let vault = get_associated_token_address(&vault_authority, &USDC_MINT);
        let lock_vault = get_associated_token_address(&lock_authority, &USDC_MINT);
        let (amm_state, _) = Pubkey::find_program_address(&[b"amm", &market_id], &AMM_ID);
        let (market_fee_pool, _) =
            Pubkey::find_program_address(&[b"market_fee_pool", &market_id], &LAUNCHPAD_ID);
        let (protocol_config, _) =
            Pubkey::find_program_address(&[b"protocol_config"], &LAUNCHPAD_ID);
        let (market_book, _) =
            Pubkey::find_program_address(&[b"market_book", &market_id], &BOOK_ID);
        Self {
            market_id,
            market,
            vault_authority,
            fee_pool_authority,
            lock_authority,
            yes_mint,
            no_mint,
            vault,
            lock_vault,
            amm_state,
            market_fee_pool,
            protocol_config,
            market_book,
        }
    }
}

#[test]
fn place_at_empty_tick() {
    let mut fixture = setup_market(1);
    let trader = setup_trader(&mut fixture);

    buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();

    let book_side = read_book_side(&fixture.svm, &book_side_pda(&fixture.pdas, SIDE_FOR, TICK));
    assert_eq!(book_side.market, fixture.pdas.market);
    assert_eq!(book_side.side, SIDE_FOR);
    assert_eq!(book_side.tick, TICK);
    assert_eq!(book_side.head_index, 0);
    assert_eq!(book_side.orders.len(), 1);
    assert_eq!(book_side.orders[0].maker, trader.keypair.pubkey());
    assert_eq!(book_side.orders[0].amount, WAD);

    let market_book = read_market_book(&fixture.svm, &fixture.pdas.market_book);
    assert!(market_book.bitmap(SIDE_FOR).is_set(TICK));
}

#[test]
fn append_at_populated_tick() {
    let mut fixture = setup_market(2);
    let trader = setup_trader(&mut fixture);
    let book_side_key = book_side_pda(&fixture.pdas, SIDE_FOR, TICK);

    buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();
    buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();

    let account = fixture.svm.get_account(&book_side_key).unwrap();
    assert_eq!(account.data.len(), BookSide::space_for(2));
    let book_side = decode_anchor::<BookSide>(&account.data);
    assert_eq!(book_side.orders.len(), 2);
    assert_eq!(book_side.head_index, 0);
}

#[test]
fn cap_rejects_51st_order() {
    let mut fixture = setup_market(3);
    let trader = setup_trader(&mut fixture);

    for _ in 0..50 {
        buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();
    }
    let err = buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap_err();
    assert_anchor_error(err, "BookSideFull");

    let book_side = read_book_side(&fixture.svm, &book_side_pda(&fixture.pdas, SIDE_FOR, TICK));
    assert_eq!(book_side.orders.len(), 50);
}

#[test]
fn cancel_marks_amount_zero() {
    let mut fixture = setup_market(4);
    let trader = setup_trader(&mut fixture);

    buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();
    cancel(&mut fixture, &trader, SIDE_FOR, TICK).unwrap();

    let book_side = read_book_side(&fixture.svm, &book_side_pda(&fixture.pdas, SIDE_FOR, TICK));
    assert_eq!(book_side.orders.len(), 1);
    assert_eq!(book_side.orders[0].amount, 0);
    assert!(fixture
        .svm
        .get_account(&book_side_pda(&fixture.pdas, SIDE_FOR, TICK))
        .is_some());
}

#[test]
fn cancel_by_id_seed_mismatch() {
    let mut fixture = setup_market(5);
    let trader = setup_trader(&mut fixture);

    buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();
    buy_yes(&mut fixture, &trader, TICK + 1, WAD, false).unwrap();
    let order_id =
        read_book_side(&fixture.svm, &book_side_pda(&fixture.pdas, SIDE_FOR, TICK)).orders[0].id;

    let err = cancel_by_id(&mut fixture, &trader, order_id, SIDE_FOR, TICK + 1).unwrap_err();
    assert_anchor_error(err, "OrderIdSeedMismatch");
}

#[test]
fn compact_drops_trailing_zeros() {
    let mut fixture = setup_market(6);
    let trader = setup_trader(&mut fixture);
    let book_side_key = book_side_pda(&fixture.pdas, SIDE_FOR, TICK);

    for _ in 0..5 {
        buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();
    }
    let mut book_side = read_book_side(&fixture.svm, &book_side_key);
    for order in book_side.orders.iter_mut().skip(2) {
        order.amount = 0;
    }
    write_book_side(&mut fixture.svm, book_side_key, &book_side);

    compact_book_side(&mut fixture, SIDE_FOR, TICK, 3).unwrap();

    let book_side = read_book_side(&fixture.svm, &book_side_key);
    assert_eq!(book_side.orders.len(), 2);
    assert!(book_side.orders.iter().all(|order| order.amount > 0));
}

#[test]
fn compact_max_drops_bounded() {
    let mut fixture = setup_market(7);
    let trader = setup_trader(&mut fixture);
    let book_side_key = book_side_pda(&fixture.pdas, SIDE_FOR, TICK);

    for _ in 0..20 {
        buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();
    }
    let mut book_side = read_book_side(&fixture.svm, &book_side_key);
    for order in &mut book_side.orders {
        order.amount = 0;
    }
    write_book_side(&mut fixture.svm, book_side_key, &book_side);

    compact_book_side(&mut fixture, SIDE_FOR, TICK, 16).unwrap();

    let book_side = read_book_side(&fixture.svm, &book_side_key);
    assert_eq!(book_side.orders.len(), 4);
}

#[test]
fn close_rejects_when_not_drained() {
    let mut fixture = setup_market(8);
    let trader = setup_trader(&mut fixture);

    buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();

    let err = close_book_side(&mut fixture, SIDE_FOR, TICK).unwrap_err();
    assert_anchor_error(err, "BookSideNotDrained");
}

#[test]
fn close_succeeds_when_drained() {
    let mut fixture = setup_market(9);
    let trader = setup_trader(&mut fixture);
    let book_side_key = book_side_pda(&fixture.pdas, SIDE_FOR, TICK);

    buy_yes(&mut fixture, &trader, TICK, WAD, false).unwrap();
    let mut book_side = read_book_side(&fixture.svm, &book_side_key);
    book_side.orders[0].amount = 0;
    book_side.head_index = book_side.orders.len() as u32;
    write_book_side(&mut fixture.svm, book_side_key, &book_side);

    let mut market_book = read_market_book(&fixture.svm, &fixture.pdas.market_book);
    market_book.bitmap_mut(SIDE_FOR).clear_bit(TICK);
    write_market_book(&mut fixture.svm, fixture.pdas.market_book, &market_book);

    let closer_before = fixture
        .svm
        .get_account(&fixture.creator.pubkey())
        .unwrap()
        .lamports;
    close_book_side(&mut fixture, SIDE_FOR, TICK).unwrap();
    let closer_after = fixture
        .svm
        .get_account(&fixture.creator.pubkey())
        .unwrap()
        .lamports;

    assert!(is_closed(&fixture.svm, &book_side_key));
    assert!(closer_after > closer_before);
}

#[test]
fn dust_credit_back_for_escrow() {
    let mut fixture = setup_market(10);
    let trader = setup_trader(&mut fixture);
    let tick = 999;
    let amount = min_resting_order_for_tick(NUM_TICKS - tick).unwrap() - 1;
    write_orderbook_position(
        &mut fixture.svm,
        trader.orderbook_position,
        &sooth_market::state::OrderbookPosition {
            market: fixture.pdas.market,
            user: trader.keypair.pubkey(),
            yes_shares: 0,
            no_shares: amount,
            _reserved: [0; 16],
        },
    );

    buy_yes(&mut fixture, &trader, tick, amount, true).unwrap();

    let position = read_orderbook_position(&fixture.svm, &trader.orderbook_position);
    assert_eq!(position.no_shares, amount);
    assert!(fixture
        .svm
        .get_account(&book_side_pda(&fixture.pdas, SIDE_FOR, tick))
        .map(|acc| acc.lamports == 0 && acc.data.is_empty())
        .unwrap_or(true));
    let market_book = read_market_book(&fixture.svm, &fixture.pdas.market_book);
    assert!(!market_book.bitmap(SIDE_FOR).is_set(tick));
}

fn setup_market(seed: u8) -> Fixture {
    let mut svm = LiteSVM::new();
    let dir = target_deploy();
    for (name, id) in [
        ("sooth_book.so", BOOK_ID),
        ("sooth_market.so", MARKET_ID),
        ("sooth_amm.so", AMM_ID),
        ("sooth_launchpad.so", LAUNCHPAD_ID),
    ] {
        let path = dir.join(name);
        assert!(
            path.exists(),
            "missing {}; run `NO_DNA=1 anchor build` from packages/programs-core first",
            path.display()
        );
        svm.add_program_from_file(id, &path).unwrap();
    }

    let mint_authority = Keypair::new();
    svm.airdrop(&mint_authority.pubkey(), 5_000_000_000)
        .unwrap();
    write_mint(&mut svm, USDC_MINT, mint_authority.pubkey());

    let creator = Keypair::new();
    svm.airdrop(&creator.pubkey(), 50_000_000_000).unwrap();

    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = NOW_TS;
    svm.set_sysvar(&clock);

    let (allowlist_pda, _) = Pubkey::find_program_address(
        &[sooth_market::state::ADJUDICATOR_ALLOWLIST_SEED],
        &MARKET_ID,
    );
    send_ixs(
        &mut svm,
        &creator,
        &[
            build_ix(
                MARKET_ID,
                sooth_market::accounts::InitializeAdjudicatorAllowlist {
                    allowlist: allowlist_pda,
                    signer: creator.pubkey(),
                    system_program: solana_sdk::system_program::ID,
                },
                sooth_market::instruction::InitializeAdjudicatorAllowlist {
                    authority: creator.pubkey(),
                },
            ),
            build_ix(
                MARKET_ID,
                sooth_market::accounts::AddAdjudicator {
                    allowlist: allowlist_pda,
                    authority: creator.pubkey(),
                },
                sooth_market::instruction::AddAdjudicator {
                    adjudicator: creator.pubkey(),
                },
            ),
        ],
    );

    let (protocol_config_pda, _) =
        Pubkey::find_program_address(&[b"protocol_config"], &LAUNCHPAD_ID);
    send_ixs(
        &mut svm,
        &creator,
        &[build_ix(
            LAUNCHPAD_ID,
            sooth_launchpad::accounts::InitializeProtocol {
                config: protocol_config_pda,
                authority: creator.pubkey(),
                system_program: solana_sdk::system_program::ID,
            },
            sooth_launchpad::instruction::InitializeProtocol {
                args: sooth_launchpad::instructions::InitializeProtocolArgs {
                    fee_bps: 100,
                    treasury: creator.pubkey(),
                    b_base_share_bps: 5_000,
                    lp_yield_share_bps: 3_000,
                    adjudicator_share_bps: 1_000,
                    protocol_share_bps: 1_000,
                    default_trial_period: 7 * 24 * 60 * 60,
                },
            },
        )],
    );

    let pdas = MarketPdas::derive(market_id(seed));
    let deadline = NOW_TS + 7 * 24 * 60 * 60;
    send_ixs(
        &mut svm,
        &creator,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            build_ix(
                LAUNCHPAD_ID,
                sooth_launchpad::accounts::CreateMarket {
                    config: protocol_config_pda,
                    market: pdas.market,
                    adjudicator_allowlist: allowlist_pda,
                    vault_authority: pdas.vault_authority,
                    yes_mint: pdas.yes_mint,
                    no_mint: pdas.no_mint,
                    lock_authority: pdas.lock_authority,
                    usdc_mint: USDC_MINT,
                    vault: pdas.vault,
                    lock_vault: pdas.lock_vault,
                    amm_state: pdas.amm_state,
                    creator: creator.pubkey(),
                    sooth_market_program: MARKET_ID,
                    sooth_amm_program: AMM_ID,
                    token_program: spl_token::ID,
                    associated_token_program: spl_associated_token_account::ID,
                    system_program: solana_sdk::system_program::ID,
                    rent: solana_sdk::sysvar::rent::ID,
                },
                sooth_launchpad::instruction::CreateMarket {
                    args: sooth_launchpad::instructions::CreateMarketArgs {
                        market_id: pdas.market_id,
                        question_hash: [0u8; 32],
                        start_time: NOW_TS,
                        deadline,
                        adjudicator: creator.pubkey(),
                        initial_b: INITIAL_B_WAD,
                    },
                },
            ),
        ],
    );
    send_ixs(
        &mut svm,
        &creator,
        &[build_ix(
            LAUNCHPAD_ID,
            sooth_launchpad::accounts::InitMarketFeePool {
                market: pdas.market,
                fee_pool_authority: pdas.fee_pool_authority,
                usdc_mint: USDC_MINT,
                market_fee_pool: pdas.market_fee_pool,
                signer: creator.pubkey(),
                token_program: spl_token::ID,
                system_program: solana_sdk::system_program::ID,
                rent: solana_sdk::sysvar::rent::ID,
            },
            sooth_launchpad::instruction::InitMarketFeePool {},
        )],
    );

    Fixture {
        svm,
        creator,
        mint_authority,
        pdas,
    }
}

fn setup_trader(fixture: &mut Fixture) -> Trader {
    let trader = Keypair::new();
    fixture
        .svm
        .airdrop(&trader.pubkey(), 50_000_000_000)
        .unwrap();
    let usdc_ata = get_associated_token_address(&trader.pubkey(), &USDC_MINT);
    send_ixs(
        &mut fixture.svm,
        &trader,
        &[create_associated_token_account_idempotent(
            &trader.pubkey(),
            &trader.pubkey(),
            &USDC_MINT,
            &spl_token::ID,
        )],
    );
    send_ixs(
        &mut fixture.svm,
        &fixture.mint_authority,
        &[spl_token::instruction::mint_to(
            &spl_token::ID,
            &USDC_MINT,
            &usdc_ata,
            &fixture.mint_authority.pubkey(),
            &[],
            100_000_000_000,
        )
        .unwrap()],
    );
    let (orderbook_position, _) = Pubkey::find_program_address(
        &[
            b"orderbook_position",
            fixture.pdas.market_id.as_ref(),
            trader.pubkey().as_ref(),
        ],
        &MARKET_ID,
    );
    Trader {
        keypair: trader,
        usdc_ata,
        orderbook_position,
    }
}

fn buy_yes(
    fixture: &mut Fixture,
    trader: &Trader,
    tick: u16,
    amount: u128,
    escrow: bool,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = build_ix(
        BOOK_ID,
        sooth_book::accounts::BuyYesOrder {
            taker: trader.keypair.pubkey(),
            market: fixture.pdas.market,
            market_book: fixture.pdas.market_book,
            book_side: book_side_pda(&fixture.pdas, SIDE_FOR, tick),
            market_usdc_vault: fixture.pdas.vault,
            vault_authority: fixture.pdas.vault_authority,
            market_fee_pool: fixture.pdas.market_fee_pool,
            taker_usdc_ata: trader.usdc_ata,
            taker_orderbook_position: trader.orderbook_position,
            protocol_config: fixture.pdas.protocol_config,
            system_program: solana_sdk::system_program::ID,
            token_program: spl_token::ID,
            rent: solana_sdk::sysvar::rent::ID,
            sooth_market_program: MARKET_ID,
            instruction_sysvar: solana_sdk::sysvar::instructions::ID,
        },
        sooth_book::instruction::BuyYes {
            tick,
            amount,
            escrow,
            match_limit_arg: 3,
        },
    );
    try_send_ixs(
        &mut fixture.svm,
        &trader.keypair,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(500_000),
            ix,
        ],
    )
}

fn cancel(
    fixture: &mut Fixture,
    trader: &Trader,
    side: u8,
    tick: u16,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = build_ix(
        BOOK_ID,
        cancel_accounts(fixture, trader, side, tick),
        sooth_book::instruction::Cancel { side, tick },
    );
    try_send_ixs(&mut fixture.svm, &trader.keypair, &[ix])
}

fn cancel_by_id(
    fixture: &mut Fixture,
    trader: &Trader,
    order_id: u64,
    side: u8,
    tick: u16,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let ix = build_ix(
        BOOK_ID,
        sooth_book::accounts::CancelByIdOrder {
            user: trader.keypair.pubkey(),
            market: fixture.pdas.market,
            market_book: fixture.pdas.market_book,
            book_side: book_side_pda(&fixture.pdas, side, tick),
            vault_authority: fixture.pdas.vault_authority,
            market_usdc_vault: fixture.pdas.vault,
            user_usdc_ata: trader.usdc_ata,
            user_orderbook_position: trader.orderbook_position,
            system_program: solana_sdk::system_program::ID,
            token_program: spl_token::ID,
            rent: solana_sdk::sysvar::rent::ID,
            sooth_market_program: MARKET_ID,
            instruction_sysvar: solana_sdk::sysvar::instructions::ID,
        },
        sooth_book::instruction::CancelById {
            order_id,
            side,
            tick,
        },
    );
    try_send_ixs(&mut fixture.svm, &trader.keypair, &[ix])
}

fn compact_book_side(
    fixture: &mut Fixture,
    side: u8,
    tick: u16,
    max_drops: u8,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let creator = clone_keypair(&fixture.creator);
    let ix = build_ix(
        BOOK_ID,
        sooth_book::accounts::CompactBookSide {
            cranker: creator.pubkey(),
            market: fixture.pdas.market,
            book_side: book_side_pda(&fixture.pdas, side, tick),
        },
        sooth_book::instruction::CompactBookSide { max_drops },
    );
    try_send_ixs(&mut fixture.svm, &creator, &[ix])
}

fn close_book_side(
    fixture: &mut Fixture,
    side: u8,
    tick: u16,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let creator = clone_keypair(&fixture.creator);
    let ix = build_ix(
        BOOK_ID,
        sooth_book::accounts::CloseBookSide {
            closer: creator.pubkey(),
            market: fixture.pdas.market,
            market_book: fixture.pdas.market_book,
            book_side: book_side_pda(&fixture.pdas, side, tick),
        },
        sooth_book::instruction::CloseBookSide {},
    );
    try_send_ixs(&mut fixture.svm, &creator, &[ix])
}

fn cancel_accounts(
    fixture: &Fixture,
    trader: &Trader,
    side: u8,
    tick: u16,
) -> sooth_book::accounts::CancelOrder {
    sooth_book::accounts::CancelOrder {
        user: trader.keypair.pubkey(),
        market: fixture.pdas.market,
        market_book: fixture.pdas.market_book,
        book_side: book_side_pda(&fixture.pdas, side, tick),
        vault_authority: fixture.pdas.vault_authority,
        market_usdc_vault: fixture.pdas.vault,
        user_usdc_ata: trader.usdc_ata,
        user_orderbook_position: trader.orderbook_position,
        system_program: solana_sdk::system_program::ID,
        token_program: spl_token::ID,
        rent: solana_sdk::sysvar::rent::ID,
        sooth_market_program: MARKET_ID,
        instruction_sysvar: solana_sdk::sysvar::instructions::ID,
    }
}

fn build_ix<A, D>(program_id: Pubkey, accounts: A, data: D) -> Instruction
where
    A: ToAccountMetas,
    D: InstructionData,
{
    Instruction {
        program_id,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

fn send_ixs(svm: &mut LiteSVM, signer: &Keypair, ixs: &[Instruction]) {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(
        &[signer],
        Message::new(ixs, Some(&signer.pubkey())),
        blockhash,
    );
    if let Err(err) = svm.send_transaction(tx) {
        panic!("tx failed: err={:?} logs={:#?}", err.err, err.meta.logs);
    }
}

fn try_send_ixs(
    svm: &mut LiteSVM,
    signer: &Keypair,
    ixs: &[Instruction],
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(
        &[signer],
        Message::new(ixs, Some(&signer.pubkey())),
        blockhash,
    );
    svm.send_transaction(tx).map(|_| ())
}

fn target_deploy() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../../..");
    p.push("target/deploy");
    p.canonicalize().expect(
        "target/deploy not found; run `NO_DNA=1 anchor build` from packages/programs-core first",
    )
}

fn write_mint(svm: &mut LiteSVM, address: Pubkey, mint_authority: Pubkey) {
    let mut data = vec![0u8; Mint::LEN];
    let mint = Mint {
        mint_authority: spl_token::solana_program::program_option::COption::Some(mint_authority),
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: spl_token::solana_program::program_option::COption::None,
    };
    spl_token::solana_program::program_pack::Pack::pack_into_slice(&mint, &mut data);
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

fn book_side_pda(pdas: &MarketPdas, side: u8, tick: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"book_side",
            pdas.market_id.as_ref(),
            &[side],
            tick.to_le_bytes().as_ref(),
        ],
        &BOOK_ID,
    )
    .0
}

fn market_id(salt: u8) -> [u8; 16] {
    let mut id = [0u8; 16];
    for (i, b) in id.iter_mut().enumerate() {
        *b = i as u8 ^ salt;
    }
    id
}

fn read_book_side(svm: &LiteSVM, pda: &Pubkey) -> BookSide {
    let acc = svm.get_account(pda).expect("book_side missing");
    assert_eq!(acc.owner, BOOK_ID);
    decode_anchor(&acc.data)
}

fn read_market_book(svm: &LiteSVM, pda: &Pubkey) -> MarketBook {
    let acc = svm.get_account(pda).expect("market_book missing");
    assert_eq!(acc.owner, BOOK_ID);
    decode_anchor(&acc.data)
}

fn read_orderbook_position(svm: &LiteSVM, pda: &Pubkey) -> sooth_market::state::OrderbookPosition {
    let acc = svm.get_account(pda).expect("orderbook_position missing");
    assert_eq!(acc.owner, MARKET_ID);
    decode_anchor(&acc.data)
}

fn write_book_side(svm: &mut LiteSVM, pda: Pubkey, book_side: &BookSide) {
    let existing = svm.get_account(&pda).expect("book_side missing");
    write_anchor_account(
        svm,
        pda,
        BOOK_ID,
        existing.lamports,
        BookSide::space_for(book_side.orders.len()),
        book_side,
    );
}

fn write_market_book(svm: &mut LiteSVM, pda: Pubkey, market_book: &MarketBook) {
    let existing = svm.get_account(&pda).expect("market_book missing");
    write_anchor_account(
        svm,
        pda,
        BOOK_ID,
        existing.lamports,
        MarketBook::SPACE,
        market_book,
    );
}

fn write_orderbook_position(
    svm: &mut LiteSVM,
    pda: Pubkey,
    position: &sooth_market::state::OrderbookPosition,
) {
    let lamports =
        svm.minimum_balance_for_rent_exemption(sooth_market::state::OrderbookPosition::SPACE);
    write_anchor_account(
        svm,
        pda,
        MARKET_ID,
        lamports,
        sooth_market::state::OrderbookPosition::SPACE,
        position,
    );
}

fn write_anchor_account<T: AccountSerialize>(
    svm: &mut LiteSVM,
    pda: Pubkey,
    owner: Pubkey,
    lamports: u64,
    space: usize,
    value: &T,
) {
    let mut data = vec![0u8; space];
    value.try_serialize(&mut &mut data[..]).unwrap();
    svm.set_account(
        pda,
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

fn decode_anchor<T: AccountDeserialize>(data: &[u8]) -> T {
    T::try_deserialize(&mut &data[..]).expect("anchor decode failed")
}

fn assert_anchor_error(err: litesvm::types::FailedTransactionMetadata, expected: &str) {
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(expected),
        "expected Anchor error {expected}, err={:?}, logs={logs}",
        err.err
    );
}

fn is_closed(svm: &LiteSVM, account: &Pubkey) -> bool {
    svm.get_account(account)
        .map(|acc| {
            acc.lamports == 0
                || acc.owner == solana_sdk::system_program::ID
                || acc.data.is_empty()
                || acc.data.iter().all(|b| *b == 0)
        })
        .unwrap_or(true)
}

fn clone_keypair(kp: &Keypair) -> Keypair {
    Keypair::from_bytes(&kp.to_bytes()).expect("keypair round-trip")
}
