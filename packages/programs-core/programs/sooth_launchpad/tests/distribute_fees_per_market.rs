//! Runtime integration tests for per-market fee distribution and the one-shot
//! legacy global fee-pool drain.

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account, compute_budget::ComputeBudgetInstruction, message::Message,
    program_pack::Pack, signature::Keypair, signer::Signer, sysvar::clock::Clock,
    transaction::Transaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account_idempotent,
};
use spl_token::state::{Account as TokenAccount, Mint};

const USDC_MINT: Pubkey = sooth_protocol_types::BASE_TOKEN_MINT;
const MARKET_ID: Pubkey = sooth_market::ID;
const AMM_ID: Pubkey = sooth_amm::ID;
const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;

const NOW_TS: i64 = 1_000_000;
const INITIAL_B_WAD: u128 = 1_000u128 * 1_000_000_000_000_000_000u128;

#[test]
fn distribute_fees_drains_market_fee_pool() {
    let mut fixture = setup_fixture();
    let market = create_market_with_pool(&mut fixture, 1);
    mint_usdc(&mut fixture, market.market_fee_pool, 10_000);

    distribute_market(&mut fixture, &market);

    assert_eq!(token_amount(&fixture.svm, market.market_fee_pool), 0);
    assert_recipient_balances(&fixture, split_4way(10_000));
}

#[test]
fn distribute_fees_bps_split_unchanged() {
    let mut fixture = setup_fixture();
    let market = create_market_with_pool(&mut fixture, 2);
    mint_usdc(&mut fixture, market.market_fee_pool, 10_000);

    distribute_market(&mut fixture, &market);

    assert_eq!(token_amount(&fixture.svm, fixture.recipients.b_base), 5_000);
    assert_eq!(token_amount(&fixture.svm, fixture.recipients.lp_yield), 3_000);
    assert_eq!(
        token_amount(&fixture.svm, fixture.recipients.adjudicator),
        1_000
    );
    assert_eq!(token_amount(&fixture.svm, fixture.recipients.protocol), 1_000);
}

#[test]
fn distribute_fees_two_markets_independent() {
    let mut fixture = setup_fixture();
    let market_a = create_market_with_pool(&mut fixture, 3);
    let market_b = create_market_with_pool(&mut fixture, 4);
    mint_usdc(&mut fixture, market_a.market_fee_pool, 10_000);
    mint_usdc(&mut fixture, market_b.market_fee_pool, 7_001);

    distribute_market(&mut fixture, &market_a);

    assert_eq!(token_amount(&fixture.svm, market_a.market_fee_pool), 0);
    assert_eq!(token_amount(&fixture.svm, market_b.market_fee_pool), 7_001);
    assert_recipient_balances(&fixture, split_4way(10_000));

    distribute_market(&mut fixture, &market_b);

    assert_eq!(token_amount(&fixture.svm, market_b.market_fee_pool), 0);
    assert_recipient_balances(&fixture, split_sum(split_4way(10_000), split_4way(7_001)));
}

#[test]
fn distribute_fees_zero_balance_rejects() {
    let mut fixture = setup_fixture();
    let market = create_market_with_pool(&mut fixture, 5);
    let ix = distribute_market_ix(&fixture, &market);

    let err = try_send_ixs(
        &mut fixture.svm,
        &fixture.cranker,
        &[ComputeBudgetInstruction::set_compute_unit_limit(300_000), ix],
    )
    .expect_err("empty market fee pool should reject");

    assert_anchor_error(err, "NothingToDistribute");
}

#[test]
fn distribute_fees_legacy_drains_global_pool_once() {
    let mut fixture = setup_fixture();
    let fee_pool_vault = fixture.fee_pool_vault;
    mint_usdc(&mut fixture, fee_pool_vault, 10_000);

    distribute_legacy(&mut fixture);

    assert_eq!(token_amount(&fixture.svm, fixture.fee_pool_vault), 0);
    assert_recipient_balances(&fixture, split_4way(10_000));

    let marker = read_legacy_marker(&fixture);
    assert!(marker.drained_at > 0);
}

#[test]
fn distribute_fees_legacy_rejects_replay() {
    let mut fixture = setup_fixture();
    let fee_pool_vault = fixture.fee_pool_vault;
    mint_usdc(&mut fixture, fee_pool_vault, 10_000);
    distribute_legacy(&mut fixture);
    fixture.svm.expire_blockhash();
    let ix = distribute_legacy_ix(&fixture);

    let err = try_send_ixs(
        &mut fixture.svm,
        &fixture.cranker,
        &[ComputeBudgetInstruction::set_compute_unit_limit(300_000), ix],
    )
    .expect_err("second legacy drain should reject");

    assert_anchor_error(err, "LegacyDrainAlreadyExecuted");
}

#[test]
fn distribute_fees_legacy_idempotent_on_zero_balance() {
    let mut fixture = setup_fixture();

    distribute_legacy(&mut fixture);

    assert_eq!(token_amount(&fixture.svm, fixture.fee_pool_vault), 0);
    let marker = read_legacy_marker(&fixture);
    assert!(marker.drained_at > 0);
    fixture.svm.expire_blockhash();
    let ix = distribute_legacy_ix(&fixture);

    let err = try_send_ixs(
        &mut fixture.svm,
        &fixture.cranker,
        &[ComputeBudgetInstruction::set_compute_unit_limit(300_000), ix],
    )
    .expect_err("second zero-balance legacy drain should reject");

    assert_anchor_error(err, "LegacyDrainAlreadyExecuted");
}

struct Fixture {
    svm: LiteSVM,
    creator: Keypair,
    cranker: Keypair,
    mint_authority: Keypair,
    protocol_config: Pubkey,
    fee_pool_authority: Pubkey,
    fee_pool_vault: Pubkey,
    legacy_marker: Pubkey,
    recipients: Recipients,
    allowlist: Pubkey,
}

#[derive(Clone, Copy)]
struct Recipients {
    b_base: Pubkey,
    lp_yield: Pubkey,
    adjudicator: Pubkey,
    protocol: Pubkey,
}

#[derive(Clone, Copy)]
struct MarketFixture {
    market: Pubkey,
    market_fee_pool: Pubkey,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Split {
    b_base: u64,
    lp_yield: u64,
    adjudicator: u64,
    protocol: u64,
}

fn setup_fixture() -> Fixture {
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

    let creator = Keypair::new();
    let cranker = Keypair::new();
    let mint_authority = Keypair::new();
    svm.airdrop(&creator.pubkey(), 50_000_000_000).unwrap();
    svm.airdrop(&cranker.pubkey(), 50_000_000_000).unwrap();
    svm.airdrop(&mint_authority.pubkey(), 5_000_000_000)
        .unwrap();

    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = NOW_TS;
    svm.set_sysvar(&clock);

    write_mint(&mut svm, USDC_MINT, mint_authority.pubkey());

    let recipients = create_recipients(&mut svm, &creator);
    let (protocol_config, _) = Pubkey::find_program_address(&[b"protocol_config"], &LAUNCHPAD_ID);
    let (fee_pool_authority, _) =
        Pubkey::find_program_address(&[b"fee_pool_authority"], &LAUNCHPAD_ID);
    let fee_pool_vault = get_associated_token_address(&fee_pool_authority, &USDC_MINT);
    let (legacy_marker, _) =
        Pubkey::find_program_address(&[b"legacy_fee_drain_marker"], &LAUNCHPAD_ID);
    let (allowlist, _) = Pubkey::find_program_address(
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
                    allowlist,
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
                    allowlist,
                    authority: creator.pubkey(),
                },
                sooth_market::instruction::AddAdjudicator {
                    adjudicator: creator.pubkey(),
                },
            ),
        ],
    );

    send_ixs(
        &mut svm,
        &creator,
        &[build_ix(
            LAUNCHPAD_ID,
            sooth_launchpad::accounts::InitializeProtocol {
                config: protocol_config,
                authority: creator.pubkey(),
                system_program: solana_sdk::system_program::ID,
            },
            sooth_launchpad::instruction::InitializeProtocol {
                args: sooth_launchpad::instructions::InitializeProtocolArgs {
                    fee_bps: 100,
                    treasury: recipients.protocol,
                    b_base_share_bps: 5_000,
                    lp_yield_share_bps: 3_000,
                    adjudicator_share_bps: 1_000,
                    protocol_share_bps: 1_000,
                    default_trial_period: 7 * 24 * 60 * 60,
                },
            },
        )],
    );

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

    Fixture {
        svm,
        creator,
        cranker,
        mint_authority,
        protocol_config,
        fee_pool_authority,
        fee_pool_vault,
        legacy_marker,
        recipients,
        allowlist,
    }
}

fn create_market_with_pool(fixture: &mut Fixture, seed: u8) -> MarketFixture {
    let market_id = market_id(seed);
    let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &MARKET_ID);
    let (vault_authority, _) = Pubkey::find_program_address(&[b"vault", &market_id], &MARKET_ID);
    let (lock_authority, _) = Pubkey::find_program_address(&[b"lock", &market_id], &MARKET_ID);
    let (yes_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"y"], &MARKET_ID);
    let (no_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"n"], &MARKET_ID);
    let vault = get_associated_token_address(&vault_authority, &USDC_MINT);
    let lock_vault = get_associated_token_address(&lock_authority, &USDC_MINT);
    let (amm_state, _) = Pubkey::find_program_address(&[b"amm", &market_id], &AMM_ID);
    let (market_fee_pool, _) =
        Pubkey::find_program_address(&[b"market_fee_pool", &market_id], &LAUNCHPAD_ID);

    let deadline = NOW_TS + 7 * 24 * 60 * 60;
    send_ixs(
        &mut fixture.svm,
        &fixture.creator,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            build_ix(
                LAUNCHPAD_ID,
                sooth_launchpad::accounts::CreateMarket {
                    config: fixture.protocol_config,
                    market,
                    adjudicator_allowlist: fixture.allowlist,
                    vault_authority,
                    yes_mint,
                    no_mint,
                    lock_authority,
                    usdc_mint: USDC_MINT,
                    vault,
                    lock_vault,
                    amm_state,
                    creator: fixture.creator.pubkey(),
                    sooth_market_program: MARKET_ID,
                    sooth_amm_program: AMM_ID,
                    token_program: spl_token::ID,
                    associated_token_program: spl_associated_token_account::ID,
                    system_program: solana_sdk::system_program::ID,
                    rent: solana_sdk::sysvar::rent::ID,
                },
                sooth_launchpad::instruction::CreateMarket {
                    args: sooth_launchpad::instructions::CreateMarketArgs {
                        market_id,
                        question_hash: [seed; 32],
                        start_time: NOW_TS,
                        deadline,
                        adjudicator: fixture.creator.pubkey(),
                        initial_b: INITIAL_B_WAD,
                    },
                },
            ),
        ],
    );

    send_ixs(
        &mut fixture.svm,
        &fixture.creator,
        &[build_ix(
            LAUNCHPAD_ID,
            sooth_launchpad::accounts::InitMarketFeePool {
                market,
                fee_pool_authority: fixture.fee_pool_authority,
                usdc_mint: USDC_MINT,
                market_fee_pool,
                signer: fixture.creator.pubkey(),
                token_program: spl_token::ID,
                system_program: solana_sdk::system_program::ID,
                rent: solana_sdk::sysvar::rent::ID,
            },
            sooth_launchpad::instruction::InitMarketFeePool {},
        )],
    );

    MarketFixture {
        market,
        market_fee_pool,
    }
}

fn distribute_market(fixture: &mut Fixture, market: &MarketFixture) {
    let ix = distribute_market_ix(fixture, market);
    send_ixs(
        &mut fixture.svm,
        &fixture.cranker,
        &[ComputeBudgetInstruction::set_compute_unit_limit(300_000), ix],
    );
}

fn distribute_market_ix(fixture: &Fixture, market: &MarketFixture) -> Instruction {
    build_ix(
        LAUNCHPAD_ID,
        sooth_launchpad::accounts::DistributeFees {
            config: fixture.protocol_config,
            market: market.market,
            fee_pool_authority: fixture.fee_pool_authority,
            usdc_mint: USDC_MINT,
            market_fee_pool: market.market_fee_pool,
            b_base_yield_vault: fixture.recipients.b_base,
            lp_yield_vault: fixture.recipients.lp_yield,
            adjudicator_fee_vault: fixture.recipients.adjudicator,
            protocol_treasury_vault: fixture.recipients.protocol,
            cranker: fixture.cranker.pubkey(),
            token_program: spl_token::ID,
        },
        sooth_launchpad::instruction::DistributeFees {},
    )
}

fn distribute_legacy(fixture: &mut Fixture) {
    let ix = distribute_legacy_ix(fixture);
    send_ixs(
        &mut fixture.svm,
        &fixture.cranker,
        &[ComputeBudgetInstruction::set_compute_unit_limit(300_000), ix],
    );
}

fn distribute_legacy_ix(fixture: &Fixture) -> Instruction {
    build_ix(
        LAUNCHPAD_ID,
        sooth_launchpad::accounts::DistributeFeesLegacy {
            legacy_marker: fixture.legacy_marker,
            config: fixture.protocol_config,
            fee_pool_authority: fixture.fee_pool_authority,
            usdc_mint: USDC_MINT,
            fee_pool_vault: fixture.fee_pool_vault,
            b_base_yield_vault: fixture.recipients.b_base,
            lp_yield_vault: fixture.recipients.lp_yield,
            adjudicator_fee_vault: fixture.recipients.adjudicator,
            protocol_treasury_vault: fixture.recipients.protocol,
            cranker: fixture.cranker.pubkey(),
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
        },
        sooth_launchpad::instruction::DistributeFeesLegacy {},
    )
}

fn create_recipients(svm: &mut LiteSVM, payer: &Keypair) -> Recipients {
    let b_base_owner = Pubkey::new_unique();
    let lp_yield_owner = Pubkey::new_unique();
    let adjudicator_owner = Pubkey::new_unique();
    let protocol_owner = Pubkey::new_unique();
    let owners = [
        b_base_owner,
        lp_yield_owner,
        adjudicator_owner,
        protocol_owner,
    ];
    let ixs: Vec<Instruction> = owners
        .iter()
        .map(|owner| {
            create_associated_token_account_idempotent(
                &payer.pubkey(),
                owner,
                &USDC_MINT,
                &spl_token::ID,
            )
        })
        .collect();
    send_ixs(svm, payer, &ixs);

    Recipients {
        b_base: get_associated_token_address(&b_base_owner, &USDC_MINT),
        lp_yield: get_associated_token_address(&lp_yield_owner, &USDC_MINT),
        adjudicator: get_associated_token_address(&adjudicator_owner, &USDC_MINT),
        protocol: get_associated_token_address(&protocol_owner, &USDC_MINT),
    }
}

fn mint_usdc(fixture: &mut Fixture, destination: Pubkey, amount: u64) {
    send_ixs(
        &mut fixture.svm,
        &fixture.mint_authority,
        &[spl_token::instruction::mint_to(
            &spl_token::ID,
            &USDC_MINT,
            &destination,
            &fixture.mint_authority.pubkey(),
            &[],
            amount,
        )
        .unwrap()],
    );
}

fn token_amount(svm: &LiteSVM, ata: Pubkey) -> u64 {
    let Some(acc) = svm.get_account(&ata) else {
        return 0;
    };
    if acc.data.is_empty() {
        return 0;
    }
    TokenAccount::unpack(&acc.data)
        .expect("token account unpack")
        .amount
}

fn read_legacy_marker(fixture: &Fixture) -> sooth_launchpad::state::LegacyFeeDrainMarker {
    let acc = fixture
        .svm
        .get_account(&fixture.legacy_marker)
        .expect("legacy marker missing");
    decode_anchor(&acc.data)
}

fn assert_recipient_balances(fixture: &Fixture, expected: Split) {
    assert_eq!(
        token_amount(&fixture.svm, fixture.recipients.b_base),
        expected.b_base
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.recipients.lp_yield),
        expected.lp_yield
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.recipients.adjudicator),
        expected.adjudicator
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.recipients.protocol),
        expected.protocol
    );
}

fn split_4way(total: u64) -> Split {
    let to_b_base = total * 5_000 / 10_000;
    let to_lp_yield = total * 3_000 / 10_000;
    let to_adjudicator = total * 1_000 / 10_000;
    let to_protocol = total - to_b_base - to_lp_yield - to_adjudicator;
    Split {
        b_base: to_b_base,
        lp_yield: to_lp_yield,
        adjudicator: to_adjudicator,
        protocol: to_protocol,
    }
}

fn split_sum(left: Split, right: Split) -> Split {
    Split {
        b_base: left.b_base + right.b_base,
        lp_yield: left.lp_yield + right.lp_yield,
        adjudicator: left.adjudicator + right.adjudicator,
        protocol: left.protocol + right.protocol,
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

fn assert_anchor_error(err: litesvm::types::FailedTransactionMetadata, expected: &str) {
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(expected),
        "expected Anchor error {expected}, err={:?}, logs={logs}",
        err.err
    );
}

fn target_deploy() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../../..");
    p.push("target/deploy");
    p.canonicalize()
        .expect("target/deploy not found; run `cargo build-sbf` for each program first")
}

fn market_id(seed: u8) -> [u8; 16] {
    let mut id = [0u8; 16];
    for (i, b) in id.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(17).wrapping_add(seed);
    }
    id
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

fn decode_anchor<T: AccountDeserialize>(data: &[u8]) -> T {
    T::try_deserialize(&mut &data[..]).expect("anchor decode failed")
}
