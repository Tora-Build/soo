//! Runtime integration tests for `sooth_amm::dismiss_market`.

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account, compute_budget::ComputeBudgetInstruction, message::Message,
    program_pack::Pack, signature::Keypair, signer::Signer, sysvar::clock::Clock,
    transaction::Transaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account_idempotent,
};
use spl_token::state::Mint;

use sooth_amm::math::{WAD, WAD_U};

const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;
const MARKET_ID: Pubkey = sooth_market::ID;
const AMM_ID: Pubkey = sooth_amm::ID;
const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;

const NOW_TS: i64 = 1_000_000;
const FEE_BPS: u16 = 100;
const INITIAL_B_WAD: u128 = 1_000u128 * WAD_U;
const SEED_DEPOSIT_WAD: u128 = 10u128 * WAD_U;
const SEED_LP_AMOUNT: u64 = 10_000_000;
const DELTA_SHARES_WAD: i128 = 5i128 * WAD;

#[test]
fn pre_trial_dismiss() {
    let mut fixture = setup_market(0x60);
    let mut amm = read_amm_state(&fixture.svm, &fixture.pdas.amm_state);
    amm.trial_end_at = NOW_TS + 24 * 60 * 60;
    write_amm_state(&mut fixture.svm, &fixture.pdas.amm_state, &amm);

    let ix = dismiss_ix(&fixture.pdas, fixture.creator.pubkey());
    let res = try_send_ixs(&mut fixture.svm, &fixture.creator, &[ix]);
    assert_anchor_error(
        res.expect_err("pre-trial dismissal must fail"),
        "TrialNotExpired",
    );

    let post = read_amm_state(&fixture.svm, &fixture.pdas.amm_state);
    assert!(!post.is_dismissed);
}

#[test]
fn non_creator_dismiss() {
    let mut fixture = setup_market(0x61);
    fast_forward_past_trial(&mut fixture.svm, &fixture.pdas.amm_state);

    let non_creator = Keypair::new();
    fixture
        .svm
        .airdrop(&non_creator.pubkey(), 5_000_000_000)
        .unwrap();

    let ix = dismiss_ix(&fixture.pdas, non_creator.pubkey());
    let res = try_send_ixs(&mut fixture.svm, &non_creator, &[ix]);
    assert_anchor_error(
        res.expect_err("non-creator dismissal must fail"),
        "Unauthorized",
    );

    let post = read_amm_state(&fixture.svm, &fixture.pdas.amm_state);
    assert!(!post.is_dismissed);
}

#[test]
fn happy_path() {
    let mut fixture = setup_market(0x62);
    fast_forward_past_trial(&mut fixture.svm, &fixture.pdas.amm_state);

    let ix = dismiss_ix(&fixture.pdas, fixture.creator.pubkey());
    send_ixs(&mut fixture.svm, &fixture.creator, &[ix]);

    let post = read_amm_state(&fixture.svm, &fixture.pdas.amm_state);
    assert!(post.is_dismissed);

    fixture.svm.expire_blockhash();
    let ix = dismiss_ix(&fixture.pdas, fixture.creator.pubkey());
    let res = try_send_ixs(&mut fixture.svm, &fixture.creator, &[ix]);
    assert_anchor_error(
        res.expect_err("second dismissal must fail"),
        "AlreadyDismissed",
    );
}

#[test]
fn graduated_market_dismiss() {
    let mut fixture = setup_market(0x63);
    fast_forward_past_trial(&mut fixture.svm, &fixture.pdas.amm_state);

    let mut amm = read_amm_state(&fixture.svm, &fixture.pdas.amm_state);
    amm.is_graduated = true;
    write_amm_state(&mut fixture.svm, &fixture.pdas.amm_state, &amm);

    let ix = dismiss_ix(&fixture.pdas, fixture.creator.pubkey());
    let res = try_send_ixs(&mut fixture.svm, &fixture.creator, &[ix]);
    assert_anchor_error(
        res.expect_err("graduated market dismissal must fail"),
        "AlreadyGraduated",
    );

    let post = read_amm_state(&fixture.svm, &fixture.pdas.amm_state);
    assert!(!post.is_dismissed);
}

#[test]
fn post_dismiss_buy_blocked() {
    let mut fixture = setup_market(0x64);
    seed_lp(&mut fixture);
    let trader = setup_trader(&mut fixture);
    fast_forward_past_trial(&mut fixture.svm, &fixture.pdas.amm_state);

    let ix = dismiss_ix(&fixture.pdas, fixture.creator.pubkey());
    send_ixs(&mut fixture.svm, &fixture.creator, &[ix]);
    assert!(read_amm_state(&fixture.svm, &fixture.pdas.amm_state).is_dismissed);

    fixture.svm.expire_blockhash();
    let buy_ix = buy_ix(&fixture, &trader);
    let res = try_send_ixs(
        &mut fixture.svm,
        &trader.keypair,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(400_000),
            buy_ix,
        ],
    );
    assert_anchor_error(
        res.expect_err("buy after dismissal must fail"),
        "MarketDismissed",
    );
}

struct Fixture {
    svm: LiteSVM,
    creator: Keypair,
    mint_authority: Keypair,
    protocol_config_pda: Pubkey,
    market_fee_pool: Pubkey,
    pdas: MarketPdas,
}

struct TraderFixture {
    keypair: Keypair,
    position_pda: Pubkey,
    usdc_ata: Pubkey,
    lp_ata: Pubkey,
}

struct MarketPdas {
    market_id: [u8; 16],
    market: Pubkey,
    vault_authority: Pubkey,
    lock_authority: Pubkey,
    yes_mint: Pubkey,
    no_mint: Pubkey,
    vault: Pubkey,
    lock_vault: Pubkey,
    amm_state: Pubkey,
    lp_mint: Pubkey,
    lp_mint_authority: Pubkey,
}

impl MarketPdas {
    fn derive(market_id: [u8; 16]) -> Self {
        let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &MARKET_ID);
        let (vault_authority, _) =
            Pubkey::find_program_address(&[b"vault", &market_id], &MARKET_ID);
        let (lock_authority, _) = Pubkey::find_program_address(&[b"lock", &market_id], &MARKET_ID);
        let (yes_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"y"], &MARKET_ID);
        let (no_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"n"], &MARKET_ID);
        let vault = get_associated_token_address(&vault_authority, &USDC_MINT);
        let lock_vault = get_associated_token_address(&lock_authority, &USDC_MINT);
        let (amm_state, _) = Pubkey::find_program_address(&[b"amm", &market_id], &AMM_ID);
        let (lp_mint, _) = Pubkey::find_program_address(&[b"lp", &market_id], &LAUNCHPAD_ID);
        let (lp_mint_authority, _) =
            Pubkey::find_program_address(&[b"lp_mint_authority", &market_id], &LAUNCHPAD_ID);

        Self {
            market_id,
            market,
            vault_authority,
            lock_authority,
            yes_mint,
            no_mint,
            vault,
            lock_vault,
            amm_state,
            lp_mint,
            lp_mint_authority,
        }
    }
}

fn setup_market(seed: u8) -> Fixture {
    let mut svm = LiteSVM::new();
    let dir = target_deploy();
    for (name, id) in [
        ("sooth_market.so", MARKET_ID),
        ("sooth_amm.so", AMM_ID),
        ("sooth_launchpad.so", LAUNCHPAD_ID),
    ] {
        let path = dir.join(name);
        assert!(
            path.exists(),
            "missing {}; run `cargo build-sbf` for each program first",
            path.display()
        );
        svm.add_program_from_file(id, &path).unwrap();
    }

    let mint_authority = Keypair::new();
    write_mint(&mut svm, USDC_MINT, mint_authority.pubkey());

    let creator = Keypair::new();
    svm.airdrop(&creator.pubkey(), 50_000_000_000).unwrap();
    svm.airdrop(&mint_authority.pubkey(), 5_000_000_000)
        .unwrap();

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
                    fee_bps: FEE_BPS,
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

    let (fee_pool_authority, _) =
        Pubkey::find_program_address(&[b"fee_pool_authority"], &LAUNCHPAD_ID);
    let fee_pool_vault = get_associated_token_address(&fee_pool_authority, &USDC_MINT);
    send_ixs(
        &mut svm,
        &creator,
        &[build_ix(
            LAUNCHPAD_ID,
            sooth_launchpad::accounts::InitializeFeePool {
                fee_pool_authority,
                usdc_mint: USDC_MINT,
                fee_pool_vault,
                signer: creator.pubkey(),
                token_program: spl_token::ID,
                associated_token_program: spl_associated_token_account::ID,
                system_program: solana_sdk::system_program::ID,
                rent: solana_sdk::sysvar::rent::ID,
            },
            sooth_launchpad::instruction::InitializeFeePool {},
        )],
    );

    let pdas = MarketPdas::derive(market_id(seed));
    let (market_fee_pool, _) = Pubkey::find_program_address(
        &[b"market_fee_pool", pdas.market_id.as_ref()],
        &LAUNCHPAD_ID,
    );
    let deadline = NOW_TS + 7 * 24 * 60 * 60;
    let create_args = sooth_launchpad::instructions::CreateMarketArgs {
        market_id: pdas.market_id,
        question_hash: [0u8; 32],
        start_time: NOW_TS,
        deadline,
        adjudicator: creator.pubkey(),
        initial_b: INITIAL_B_WAD,
    };
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
                sooth_launchpad::instruction::CreateMarket { args: create_args },
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
                fee_pool_authority,
                usdc_mint: USDC_MINT,
                market_fee_pool,
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
        protocol_config_pda,
        market_fee_pool,
        pdas,
    }
}

fn seed_lp(fixture: &mut Fixture) {
    let creator_lp_ata =
        get_associated_token_address(&fixture.creator.pubkey(), &fixture.pdas.lp_mint);
    send_ixs(
        &mut fixture.svm,
        &fixture.creator,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(400_000),
            build_ix(
                LAUNCHPAD_ID,
                sooth_launchpad::accounts::SeedLp {
                    config: fixture.protocol_config_pda,
                    market: fixture.pdas.market,
                    amm_state: fixture.pdas.amm_state,
                    lp_mint: fixture.pdas.lp_mint,
                    lp_mint_authority: fixture.pdas.lp_mint_authority,
                    creator_lp_ata,
                    lp_position: Pubkey::find_program_address(
                        &[
                            b"lp_position",
                            fixture.pdas.market_id.as_ref(),
                            fixture.creator.pubkey().as_ref(),
                        ],
                        &LAUNCHPAD_ID,
                    )
                    .0,
                    creator: fixture.creator.pubkey(),
                    token_program: spl_token::ID,
                    associated_token_program: spl_associated_token_account::ID,
                    system_program: solana_sdk::system_program::ID,
                    rent: solana_sdk::sysvar::rent::ID,
                },
                sooth_launchpad::instruction::SeedLp {
                    args: sooth_launchpad::instructions::SeedLpArgs {
                        lp_amount: SEED_LP_AMOUNT,
                        seed_deposit_wad: SEED_DEPOSIT_WAD,
                    },
                },
            ),
        ],
    );
}

fn setup_trader(fixture: &mut Fixture) -> TraderFixture {
    let trader = Keypair::new();
    fixture
        .svm
        .airdrop(&trader.pubkey(), 50_000_000_000)
        .unwrap();

    let usdc_ata = get_associated_token_address(&trader.pubkey(), &USDC_MINT);
    let lp_ata = get_associated_token_address(&trader.pubkey(), &fixture.pdas.lp_mint);
    send_ixs(
        &mut fixture.svm,
        &trader,
        &[
            create_associated_token_account_idempotent(
                &trader.pubkey(),
                &trader.pubkey(),
                &USDC_MINT,
                &spl_token::ID,
            ),
            create_associated_token_account_idempotent(
                &trader.pubkey(),
                &trader.pubkey(),
                &fixture.pdas.lp_mint,
                &spl_token::ID,
            ),
        ],
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
            100_000_000,
        )
        .unwrap()],
    );

    let (position_pda, _) = Pubkey::find_program_address(
        &[
            b"pos",
            fixture.pdas.market_id.as_ref(),
            trader.pubkey().as_ref(),
        ],
        &AMM_ID,
    );

    TraderFixture {
        keypair: trader,
        position_pda,
        usdc_ata,
        lp_ata,
    }
}

fn buy_ix(fixture: &Fixture, trader: &TraderFixture) -> Instruction {
    let trade_accounts = sooth_amm::accounts::TradePositions {
        market: fixture.pdas.market,
        amm_state: fixture.pdas.amm_state,
        position: trader.position_pda,
        vault_authority: fixture.pdas.vault_authority,
        user_usdc_ata: trader.usdc_ata,
        market_vault: fixture.pdas.vault,
        usdc_mint: USDC_MINT,
        protocol_config: fixture.protocol_config_pda,
        market_fee_pool: fixture.market_fee_pool,
        lp_mint: fixture.pdas.lp_mint,
        lp_mint_authority: fixture.pdas.lp_mint_authority,
        user_lp_ata: trader.lp_ata,
        user: trader.keypair.pubkey(),
        system_program: solana_sdk::system_program::ID,
        token_program: spl_token::ID,
        rent: solana_sdk::sysvar::rent::ID,
        sooth_launchpad_program: LAUNCHPAD_ID,
        instruction_sysvar: solana_sdk::sysvar::instructions::ID,
    };
    build_ix(
        AMM_ID,
        trade_accounts,
        sooth_amm::instruction::TradePositions {
            outcome: 1,
            delta_shares: DELTA_SHARES_WAD,
            max_cost_wad: 6u128 * WAD_U,
        },
    )
}

fn dismiss_ix(pdas: &MarketPdas, creator: Pubkey) -> Instruction {
    build_ix(
        AMM_ID,
        sooth_amm::accounts::DismissMarket {
            market: pdas.market,
            amm_state: pdas.amm_state,
            creator,
        },
        sooth_amm::instruction::DismissMarket {},
    )
}

fn fast_forward_past_trial(svm: &mut LiteSVM, amm_state: &Pubkey) {
    let amm = read_amm_state(svm, amm_state);
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = amm.trial_end_at + 1;
    svm.set_sysvar(&clock);
}

fn read_amm_state(svm: &LiteSVM, amm_state: &Pubkey) -> sooth_amm::state::AmmState {
    let acc = svm.get_account(amm_state).expect("amm_state missing");
    assert_eq!(acc.owner, AMM_ID);
    decode_anchor(&acc.data)
}

fn write_amm_state(svm: &mut LiteSVM, amm_state_pubkey: &Pubkey, amm: &sooth_amm::state::AmmState) {
    let mut acc = svm
        .get_account(amm_state_pubkey)
        .expect("amm_state missing");
    let mut data = Vec::with_capacity(sooth_amm::state::AmmState::SPACE);
    amm.try_serialize(&mut data)
        .expect("amm_state serialize failed");
    assert_eq!(data.len(), sooth_amm::state::AmmState::SPACE);
    acc.data = data;
    svm.set_account(*amm_state_pubkey, acc).unwrap();
}

fn target_deploy() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../../..");
    p.push("target/deploy");
    p.canonicalize()
        .expect("target/deploy not found; run `cargo build-sbf` for each program first")
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
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(
        &[signer],
        Message::new(ixs, Some(&signer.pubkey())),
        blockhash,
    );
    svm.send_transaction(tx).map(|_| ())
}

fn write_mint(svm: &mut LiteSVM, address: Pubkey, mint_authority: Pubkey) {
    let mut data = vec![0u8; Mint::LEN];
    let mint = spl_token::state::Mint {
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

fn decode_anchor<T: anchor_lang::AccountDeserialize>(data: &[u8]) -> T {
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

fn market_id(seed: u8) -> [u8; 16] {
    let mut id = [0u8; 16];
    for (i, b) in id.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(17).wrapping_add(seed);
    }
    id
}
