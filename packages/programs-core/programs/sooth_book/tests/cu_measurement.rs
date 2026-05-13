use std::{collections::HashSet, path::PathBuf};

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::{types::TransactionMetadata, LiteSVM};
use solana_sdk::{
    account::Account, compute_budget::ComputeBudgetInstruction, instruction::AccountMeta,
    instruction::Instruction, message::Message, program_pack::Pack, signature::Keypair,
    signer::Signer, sysvar::clock::Clock, transaction::Transaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account_idempotent,
};
use spl_token::state::{Account as TokenState, Mint};

use sooth_book::math::NUM_TICKS;
use sooth_book::state::{SIDE_AGAINST, SIDE_FOR};

const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;
const BOOK_ID: Pubkey = sooth_book::ID;
const MARKET_ID: Pubkey = sooth_market::ID;
const AMM_ID: Pubkey = sooth_amm::ID;
const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;
const NOW_TS: i64 = 1_000_000;
const INITIAL_B_WAD: u128 = 1_000_000_000_000_000_000_000;
const WAD: u128 = 1_000_000_000_000_000_000;
const CU_CEILING: u64 = 800_000;
const WRITABLE_ACCOUNT_CEILING_WITH_MARGIN: usize = 28;

struct Fixture {
    svm: LiteSVM,
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
fn measure_three_fill_worst_case_buy_cu_and_writables() {
    let mut fixture = setup_market(71);
    let makers = setup_traders(&mut fixture, 3);
    for (maker, tick) in makers.iter().zip([900, 850, 800]) {
        write_orderbook_position(
            &mut fixture.svm,
            maker.orderbook_position,
            &sooth_market::state::OrderbookPosition {
                market: fixture.pdas.market,
                user: maker.keypair.pubkey(),
                yes_shares: WAD,
                no_shares: 0,
                _reserved: [0; 16],
            },
        );
        buy_no(&mut fixture, maker, tick, WAD, true, 3).unwrap();
    }
    let taker = setup_trader(&mut fixture);
    let bundles = [
        fill_bundle(&fixture, &makers[0], SIDE_AGAINST, 900),
        fill_bundle(&fixture, &makers[1], SIDE_AGAINST, 850),
        fill_bundle(&fixture, &makers[2], SIDE_AGAINST, 800),
    ]
    .concat();
    let buy_ix = buy_yes_ix(&fixture, &taker, 950, 3 * WAD, false, 3, bundles);
    let ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
        buy_ix,
    ];
    let writable_count = writable_account_count(&taker.keypair, &ixs);
    let meta = try_send_ixs(&mut fixture.svm, &taker.keypair, &ixs).unwrap();
    let cu = meta.compute_units_consumed;

    println!("SOOTH_BOOK_W8_3_FILL_WORST_CASE_CU={cu}");
    println!("SOOTH_BOOK_W8_3_FILL_WRITABLE_ACCOUNTS={writable_count}");
    assert!(
        cu <= CU_CEILING,
        "3-fill worst-case CU {cu} exceeds {CU_CEILING}"
    );
    assert!(
        writable_count <= WRITABLE_ACCOUNT_CEILING_WITH_MARGIN,
        "writable account count {writable_count} exceeds margin ceiling {WRITABLE_ACCOUNT_CEILING_WITH_MARGIN}"
    );
    assert_eq!(
        read_token_amount(&fixture.svm, &fixture.pdas.market_fee_pool),
        expected_fee_base(WAD, 950, 100) * 3
    );
}

#[test]
fn measure_single_fill_baseline_buy_cu() {
    let mut fixture = setup_market(72);
    let maker = setup_trader(&mut fixture);
    write_orderbook_position(
        &mut fixture.svm,
        maker.orderbook_position,
        &sooth_market::state::OrderbookPosition {
            market: fixture.pdas.market,
            user: maker.keypair.pubkey(),
            yes_shares: WAD,
            no_shares: 0,
            _reserved: [0; 16],
        },
    );
    buy_no(&mut fixture, &maker, 900, WAD, true, 1).unwrap();
    let taker = setup_trader(&mut fixture);
    let bundles = fill_bundle(&fixture, &maker, SIDE_AGAINST, 900);
    let meta = buy_yes(&mut fixture, &taker, 950, WAD, false, 1, bundles).unwrap();
    let cu = meta.compute_units_consumed;
    println!("SOOTH_BOOK_W8_1_FILL_BASELINE_CU={cu}");
    assert!(cu > 0);
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
                        deadline: NOW_TS + 7 * 24 * 60 * 60,
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
        mint_authority,
        pdas,
    }
}

fn setup_traders(fixture: &mut Fixture, count: usize) -> Vec<Trader> {
    (0..count).map(|_| setup_trader(fixture)).collect()
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
    match_limit_arg: u32,
    remaining: Vec<AccountMeta>,
) -> Result<TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let ix = buy_yes_ix(
        fixture,
        trader,
        tick,
        amount,
        escrow,
        match_limit_arg,
        remaining,
    );
    try_send_ixs(
        &mut fixture.svm,
        &trader.keypair,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            ix,
        ],
    )
}

fn buy_yes_ix(
    fixture: &Fixture,
    trader: &Trader,
    tick: u16,
    amount: u128,
    escrow: bool,
    match_limit_arg: u32,
    remaining: Vec<AccountMeta>,
) -> Instruction {
    let mut ix = build_ix(
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
            match_limit_arg,
        },
    );
    ix.accounts.extend(remaining);
    ix
}

fn buy_no(
    fixture: &mut Fixture,
    trader: &Trader,
    tick: u16,
    amount: u128,
    escrow: bool,
    match_limit_arg: u32,
) -> Result<TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let ix = build_ix(
        BOOK_ID,
        sooth_book::accounts::BuyNoOrder {
            taker: trader.keypair.pubkey(),
            market: fixture.pdas.market,
            market_book: fixture.pdas.market_book,
            book_side: book_side_pda(&fixture.pdas, SIDE_AGAINST, tick),
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
        sooth_book::instruction::BuyNo {
            tick,
            amount,
            escrow,
            match_limit_arg,
        },
    );
    try_send_ixs(
        &mut fixture.svm,
        &trader.keypair,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            ix,
        ],
    )
}

fn fill_bundle(fixture: &Fixture, maker: &Trader, opp_side: u8, opp_tick: u16) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(book_side_pda(&fixture.pdas, opp_side, opp_tick), false),
        AccountMeta::new(maker.orderbook_position, false),
        AccountMeta::new(maker.usdc_ata, false),
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
    ]
}

fn writable_account_count(payer: &Keypair, ixs: &[Instruction]) -> usize {
    let mut accounts = HashSet::from([payer.pubkey()]);
    for ix in ixs {
        for meta in &ix.accounts {
            if meta.is_writable {
                accounts.insert(meta.pubkey);
            }
        }
    }
    accounts.len()
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
    if let Err(err) = try_send_ixs(svm, signer, ixs) {
        panic!("tx failed: err={:?} logs={:#?}", err.err, err.meta.logs);
    }
}

fn try_send_ixs(
    svm: &mut LiteSVM,
    signer: &Keypair,
    ixs: &[Instruction],
) -> Result<TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(
        &[signer],
        Message::new(ixs, Some(&signer.pubkey())),
        blockhash,
    );
    svm.send_transaction(tx)
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

fn read_token_amount(svm: &LiteSVM, pda: &Pubkey) -> u64 {
    let acc = svm.get_account(pda).expect("token account missing");
    TokenState::unpack(&acc.data).unwrap().amount
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

fn expected_fee_base(shares: u128, taker_tick: u16, fee_bps: u16) -> u64 {
    let base_cost_wad = shares * taker_tick as u128 / NUM_TICKS as u128;
    let fee_wad = base_cost_wad * fee_bps as u128 / 10_000;
    (((base_cost_wad + fee_wad) / 1_000_000_000_000) - (base_cost_wad / 1_000_000_000_000)) as u64
}
