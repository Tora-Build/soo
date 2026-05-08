//! Runtime integration tests for `sooth_launchpad::redeem_lp`.

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::{
    instruction::Instruction, program_pack::Pack, system_instruction,
};
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account, compute_budget::ComputeBudgetInstruction, message::Message,
    signature::Keypair, signer::Signer, sysvar::clock::Clock, transaction::Transaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account_idempotent,
};
use spl_token::state::{Account as TokenAccount, Mint};

const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;
const MARKET_ID: Pubkey = sooth_market::ID;
const AMM_ID: Pubkey = sooth_amm::ID;
const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;

const NOW_TS: i64 = 1_000_000;
const INITIAL_B_WAD: u128 = 1_000u128 * 1_000_000_000_000_000_000u128;
const SEED_DEPOSIT_WAD: u128 = 10u128 * 1_000_000_000_000_000_000u128;
const SEED_LP_AMOUNT: u64 = 1_000;
const YIELD_USDC_AMOUNT: u64 = 100;

#[test]
fn pre_grad_redeem_fails() {
    let mut fixture = setup_fixture(1);
    create_user_usdc_ata(&mut fixture.svm, &fixture.creator);
    mint_yield(&mut fixture, YIELD_USDC_AMOUNT);

    let err = try_redeem_creator(&mut fixture, SEED_LP_AMOUNT / 2)
        .expect_err("pre-graduation redeem should fail");
    assert_anchor_error(err, "NotGraduated");
}

#[test]
fn happy_path_single_holder() {
    let mut fixture = setup_fixture(2);
    let user_usdc_ata = create_user_usdc_ata(&mut fixture.svm, &fixture.creator);
    mint_yield(&mut fixture, YIELD_USDC_AMOUNT);
    set_graduated(&mut fixture.svm, &fixture.pdas.amm_state, true);

    redeem_creator(&mut fixture, SEED_LP_AMOUNT / 2);

    assert_eq!(
        read_token_amount(&fixture.svm, &fixture.pdas.creator_lp_ata),
        500
    );
    assert_eq!(read_mint_supply(&fixture.svm, &fixture.pdas.lp_mint), 500);
    assert_eq!(
        read_token_amount(&fixture.svm, &fixture.pdas.lp_yield_vault),
        50
    );
    assert_eq!(read_token_amount(&fixture.svm, &user_usdc_ata), 50);
}

#[test]
fn two_holders_sequential() {
    let mut fixture = setup_fixture(3);
    let holder_two = Keypair::new();
    fixture
        .svm
        .airdrop(&holder_two.pubkey(), 50_000_000_000)
        .unwrap();

    let holder_two_lp_ata =
        create_user_lp_ata(&mut fixture.svm, &holder_two, &fixture.pdas.lp_mint);
    let holder_two_usdc_ata = create_user_usdc_ata(&mut fixture.svm, &holder_two);
    let creator_usdc_ata = create_user_usdc_ata(&mut fixture.svm, &fixture.creator);

    transfer_lp(
        &mut fixture.svm,
        &fixture.creator,
        fixture.pdas.creator_lp_ata,
        holder_two_lp_ata,
        500,
    );
    mint_yield(&mut fixture, YIELD_USDC_AMOUNT);
    set_graduated(&mut fixture.svm, &fixture.pdas.amm_state, true);

    redeem_creator(&mut fixture, 500);
    assert_eq!(read_token_amount(&fixture.svm, &creator_usdc_ata), 50);
    assert_eq!(
        read_token_amount(&fixture.svm, &fixture.pdas.lp_yield_vault),
        50
    );
    assert_eq!(read_mint_supply(&fixture.svm, &fixture.pdas.lp_mint), 500);

    redeem(&mut fixture, &holder_two, 500);
    assert_eq!(read_token_amount(&fixture.svm, &holder_two_usdc_ata), 50);
    assert_eq!(
        read_token_amount(&fixture.svm, &fixture.pdas.lp_yield_vault),
        0
    );
    assert_eq!(read_mint_supply(&fixture.svm, &fixture.pdas.lp_mint), 0);
}

#[test]
fn zero_lp_amount() {
    let mut fixture = setup_fixture(4);
    create_user_usdc_ata(&mut fixture.svm, &fixture.creator);
    mint_yield(&mut fixture, YIELD_USDC_AMOUNT);
    set_graduated(&mut fixture.svm, &fixture.pdas.amm_state, true);

    let err = try_redeem_creator(&mut fixture, 0).expect_err("zero LP should fail");
    assert_anchor_error(err, "ZeroLpAmount");
}

#[test]
fn empty_supply_guard() {
    let mut fixture = setup_fixture(5);
    create_user_usdc_ata(&mut fixture.svm, &fixture.creator);
    mint_yield(&mut fixture, YIELD_USDC_AMOUNT);
    set_graduated(&mut fixture.svm, &fixture.pdas.amm_state, true);

    burn_lp(
        &mut fixture.svm,
        &fixture.creator,
        fixture.pdas.creator_lp_ata,
        fixture.pdas.lp_mint,
        SEED_LP_AMOUNT,
    );
    assert_eq!(read_mint_supply(&fixture.svm, &fixture.pdas.lp_mint), 0);

    let err =
        try_redeem_creator(&mut fixture, 1).expect_err("empty supply should fail before burn CPI");
    assert_anchor_error(err, "EmptyLpSupply");
}

#[test]
fn wrong_mint_fails() {
    let mut fixture = setup_fixture(6);
    create_user_usdc_ata(&mut fixture.svm, &fixture.creator);
    mint_yield(&mut fixture, YIELD_USDC_AMOUNT);
    set_graduated(&mut fixture.svm, &fixture.pdas.amm_state, true);

    let wrong_mint = Pubkey::new_unique();
    write_mint(
        &mut fixture.svm,
        wrong_mint,
        fixture.mint_authority.pubkey(),
    );

    let err = try_redeem_creator_with_lp_mint(&mut fixture, 1, wrong_mint)
        .expect_err("wrong LP mint should fail ATA constraint");
    assert_anchor_error(err, "ConstraintAssociated");
}

struct Fixture {
    svm: LiteSVM,
    creator: Keypair,
    mint_authority: Keypair,
    pdas: Pdas,
}

#[derive(Clone, Copy)]
struct Pdas {
    amm_state: Pubkey,
    lp_mint: Pubkey,
    creator_lp_ata: Pubkey,
    lp_yield_authority: Pubkey,
    lp_yield_vault: Pubkey,
}

fn setup_fixture(seed: u8) -> Fixture {
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
        &[&creator],
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
        &[&creator],
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

    let market_id = market_id(seed);
    let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &MARKET_ID);
    let (vault_authority, _) = Pubkey::find_program_address(&[b"vault", &market_id], &MARKET_ID);
    let (lock_authority, _) = Pubkey::find_program_address(&[b"lock", &market_id], &MARKET_ID);
    let (yes_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"y"], &MARKET_ID);
    let (no_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"n"], &MARKET_ID);
    let vault = get_associated_token_address(&vault_authority, &USDC_MINT);
    let lock_vault = get_associated_token_address(&lock_authority, &USDC_MINT);
    let (amm_state, _) = Pubkey::find_program_address(&[b"amm", &market_id], &AMM_ID);
    let (lp_mint, _) = Pubkey::find_program_address(&[b"lp", &market_id], &LAUNCHPAD_ID);
    let (lp_mint_authority, _) =
        Pubkey::find_program_address(&[b"lp_mint_authority", &market_id], &LAUNCHPAD_ID);
    let (lp_position, _) = Pubkey::find_program_address(
        &[b"lp_position", &market_id, creator.pubkey().as_ref()],
        &LAUNCHPAD_ID,
    );
    let (lp_yield_authority, _) =
        Pubkey::find_program_address(&[b"lp_yield_authority"], &LAUNCHPAD_ID);
    let lp_yield_vault_keypair = Keypair::new();
    let lp_yield_vault = lp_yield_vault_keypair.pubkey();

    let create_yield_vault_ixs = create_token_account_ixs(
        &svm,
        &creator.pubkey(),
        &lp_yield_vault,
        &USDC_MINT,
        &lp_yield_authority,
    );
    send_ixs(
        &mut svm,
        &[&creator, &lp_yield_vault_keypair],
        &create_yield_vault_ixs,
    );

    let deadline = NOW_TS + 7 * 24 * 60 * 60;
    let create_args = sooth_launchpad::instructions::CreateMarketArgs {
        market_id,
        question_hash: [0u8; 32],
        start_time: NOW_TS,
        deadline,
        adjudicator: creator.pubkey(),
        initial_b: INITIAL_B_WAD,
    };
    send_ixs(
        &mut svm,
        &[&creator],
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            build_ix(
                LAUNCHPAD_ID,
                sooth_launchpad::accounts::CreateMarket {
                    config: protocol_config_pda,
                    market,
                    adjudicator_allowlist: allowlist_pda,
                    vault_authority,
                    yes_mint,
                    no_mint,
                    lock_authority,
                    usdc_mint: USDC_MINT,
                    vault,
                    lock_vault,
                    amm_state,
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

    let creator_lp_ata = get_associated_token_address(&creator.pubkey(), &lp_mint);
    send_ixs(
        &mut svm,
        &[&creator],
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(400_000),
            build_ix(
                LAUNCHPAD_ID,
                sooth_launchpad::accounts::SeedLp {
                    config: protocol_config_pda,
                    market,
                    amm_state,
                    lp_mint,
                    lp_mint_authority,
                    creator_lp_ata,
                    lp_position,
                    creator: creator.pubkey(),
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

    assert_eq!(read_mint_supply(&svm, &lp_mint), SEED_LP_AMOUNT);

    Fixture {
        svm,
        creator,
        mint_authority,
        pdas: Pdas {
            amm_state,
            lp_mint,
            creator_lp_ata,
            lp_yield_authority,
            lp_yield_vault,
        },
    }
}

fn redeem(fixture: &mut Fixture, user: &Keypair, lp_amount: u64) {
    try_redeem(fixture, user, lp_amount)
        .unwrap_or_else(|err| panic!("redeem failed: err={:?} logs={:#?}", err.err, err.meta.logs));
}

fn redeem_creator(fixture: &mut Fixture, lp_amount: u64) {
    try_redeem_creator(fixture, lp_amount).unwrap_or_else(|err| {
        panic!(
            "creator redeem failed: err={:?} logs={:#?}",
            err.err, err.meta.logs
        )
    });
}

fn try_redeem_creator(
    fixture: &mut Fixture,
    lp_amount: u64,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    try_redeem_creator_with_lp_mint(fixture, lp_amount, fixture.pdas.lp_mint)
}

fn try_redeem_creator_with_lp_mint(
    fixture: &mut Fixture,
    lp_amount: u64,
    lp_mint: Pubkey,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let user_pubkey = fixture.creator.pubkey();
    let user_lp_ata = get_associated_token_address(&user_pubkey, &fixture.pdas.lp_mint);
    let user_usdc_ata = get_associated_token_address(&user_pubkey, &USDC_MINT);
    try_send_ixs(
        &mut fixture.svm,
        &[&fixture.creator],
        &[build_ix(
            LAUNCHPAD_ID,
            sooth_launchpad::accounts::RedeemLp {
                amm_state: fixture.pdas.amm_state,
                lp_mint,
                user_lp_ata,
                lp_yield_vault: fixture.pdas.lp_yield_vault,
                lp_yield_authority: fixture.pdas.lp_yield_authority,
                user_usdc_ata,
                user: user_pubkey,
                token_program: spl_token::ID,
            },
            sooth_launchpad::instruction::RedeemLp { lp_amount },
        )],
    )
}

fn try_redeem(
    fixture: &mut Fixture,
    user: &Keypair,
    lp_amount: u64,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    try_redeem_with_lp_mint(fixture, user, lp_amount, fixture.pdas.lp_mint)
}

fn try_redeem_with_lp_mint(
    fixture: &mut Fixture,
    user: &Keypair,
    lp_amount: u64,
    lp_mint: Pubkey,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let user_lp_ata = get_associated_token_address(&user.pubkey(), &fixture.pdas.lp_mint);
    let user_usdc_ata = get_associated_token_address(&user.pubkey(), &USDC_MINT);
    try_send_ixs(
        &mut fixture.svm,
        &[user],
        &[build_ix(
            LAUNCHPAD_ID,
            sooth_launchpad::accounts::RedeemLp {
                amm_state: fixture.pdas.amm_state,
                lp_mint,
                user_lp_ata,
                lp_yield_vault: fixture.pdas.lp_yield_vault,
                lp_yield_authority: fixture.pdas.lp_yield_authority,
                user_usdc_ata,
                user: user.pubkey(),
                token_program: spl_token::ID,
            },
            sooth_launchpad::instruction::RedeemLp { lp_amount },
        )],
    )
}

fn mint_yield(fixture: &mut Fixture, amount: u64) {
    send_ixs(
        &mut fixture.svm,
        &[&fixture.mint_authority],
        &[spl_token::instruction::mint_to(
            &spl_token::ID,
            &USDC_MINT,
            &fixture.pdas.lp_yield_vault,
            &fixture.mint_authority.pubkey(),
            &[],
            amount,
        )
        .unwrap()],
    );
}

fn set_graduated(svm: &mut LiteSVM, amm_state: &Pubkey, is_graduated: bool) {
    let mut amm = read_amm_state(svm, amm_state);
    amm.is_graduated = is_graduated;
    write_amm_state(svm, amm_state, &amm);
}

fn read_amm_state(svm: &LiteSVM, amm_state: &Pubkey) -> sooth_amm::state::AmmState {
    let acc = svm.get_account(amm_state).expect("amm_state missing");
    sooth_amm::state::AmmState::try_deserialize(&mut &acc.data[..])
        .expect("amm_state decode failed")
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

fn create_user_usdc_ata(svm: &mut LiteSVM, user: &Keypair) -> Pubkey {
    let ata = get_associated_token_address(&user.pubkey(), &USDC_MINT);
    send_ixs(
        svm,
        &[user],
        &[create_associated_token_account_idempotent(
            &user.pubkey(),
            &user.pubkey(),
            &USDC_MINT,
            &spl_token::ID,
        )],
    );
    ata
}

fn create_user_lp_ata(svm: &mut LiteSVM, user: &Keypair, lp_mint: &Pubkey) -> Pubkey {
    let ata = get_associated_token_address(&user.pubkey(), lp_mint);
    send_ixs(
        svm,
        &[user],
        &[create_associated_token_account_idempotent(
            &user.pubkey(),
            &user.pubkey(),
            lp_mint,
            &spl_token::ID,
        )],
    );
    ata
}

fn transfer_lp(svm: &mut LiteSVM, owner: &Keypair, source: Pubkey, dest: Pubkey, amount: u64) {
    send_ixs(
        svm,
        &[owner],
        &[spl_token::instruction::transfer(
            &spl_token::ID,
            &source,
            &dest,
            &owner.pubkey(),
            &[],
            amount,
        )
        .unwrap()],
    );
}

fn burn_lp(svm: &mut LiteSVM, owner: &Keypair, source: Pubkey, mint: Pubkey, amount: u64) {
    send_ixs(
        svm,
        &[owner],
        &[spl_token::instruction::burn(
            &spl_token::ID,
            &source,
            &mint,
            &owner.pubkey(),
            &[],
            amount,
        )
        .unwrap()],
    );
}

fn create_token_account_ixs(
    svm: &LiteSVM,
    payer: &Pubkey,
    account: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
) -> [Instruction; 2] {
    let lamports = svm.minimum_balance_for_rent_exemption(TokenAccount::LEN);
    [
        system_instruction::create_account(
            payer,
            account,
            lamports,
            TokenAccount::LEN as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_account(&spl_token::ID, account, mint, owner).unwrap(),
    ]
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

fn send_ixs(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) {
    try_send_ixs(svm, signers, ixs)
        .unwrap_or_else(|err| panic!("tx failed: err={:?} logs={:#?}", err.err, err.meta.logs));
}

fn try_send_ixs(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let blockhash = svm.latest_blockhash();
    let payer = signers[0].pubkey();
    let tx = Transaction::new(signers, Message::new(ixs, Some(&payer)), blockhash);
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

fn read_mint_supply(svm: &LiteSVM, mint_address: &Pubkey) -> u64 {
    let acc = svm.get_account(mint_address).expect("mint account missing");
    let mint = Mint::unpack(&acc.data).expect("mint unpack");
    mint.supply
}

fn read_token_amount(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let acc = svm
        .get_account(token_account)
        .expect("token account missing");
    let ta = TokenAccount::unpack(&acc.data).expect("token account unpack");
    ta.amount
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
