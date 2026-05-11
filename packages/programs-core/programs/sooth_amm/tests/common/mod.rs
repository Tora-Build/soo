#![allow(dead_code)]

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
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

use sooth_amm::math::{cost_delta, wad_to_usdc_ceil, wad_to_usdc_floor, WAD, WAD_U};

pub const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;
pub const MARKET_ID: Pubkey = sooth_market::ID;
pub const AMM_ID: Pubkey = sooth_amm::ID;
pub const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;

pub const NOW_TS: i64 = 1_000_000;
pub const FEE_BPS: u16 = 100;
pub const INITIAL_B_WAD: u128 = 1_000u128 * WAD_U;
pub const SEED_DEPOSIT_WAD: u128 = 10u128 * WAD_U;
pub const SEED_LP_AMOUNT: u64 = 10_000_000;

pub struct Fixture {
    pub svm: LiteSVM,
    pub creator: Keypair,
    pub mint_authority: Keypair,
    pub protocol_config_pda: Pubkey,
    pub fee_pool_vault: Pubkey,
    pub pdas: MarketPdas,
}

pub struct TraderFixture {
    pub keypair: Keypair,
    pub position_pda: Pubkey,
    pub usdc_ata: Pubkey,
    pub lp_ata: Pubkey,
}

pub struct MarketPdas {
    pub market_id: [u8; 16],
    pub market: Pubkey,
    pub vault_authority: Pubkey,
    pub lock_authority: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub lock_vault: Pubkey,
    pub amm_state: Pubkey,
    pub lp_mint: Pubkey,
    pub lp_mint_authority: Pubkey,
}

impl MarketPdas {
    pub fn derive(market_id: [u8; 16]) -> Self {
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

pub fn setup_market(seed: u8) -> Fixture {
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

    let (fee_pool_authority_pda, _) =
        Pubkey::find_program_address(&[b"fee_pool_authority"], &LAUNCHPAD_ID);
    let fee_pool_vault = get_associated_token_address(&fee_pool_authority_pda, &USDC_MINT);
    send_ixs(
        &mut svm,
        &creator,
        &[build_ix(
            LAUNCHPAD_ID,
            sooth_launchpad::accounts::InitializeFeePool {
                fee_pool_authority: fee_pool_authority_pda,
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

    let mut fixture = Fixture {
        svm,
        creator,
        mint_authority,
        protocol_config_pda,
        fee_pool_vault,
        pdas,
    };
    seed_lp(&mut fixture);
    fixture
}

pub fn setup_trader(fixture: &mut Fixture) -> TraderFixture {
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
            10_000_000_000,
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

pub fn buy_yes(fixture: &mut Fixture, trader: &TraderFixture, shares: i128) -> u64 {
    let before = read_amm_state(&fixture.svm, &fixture.pdas.amm_state);
    let cost_wad = cost_delta(before.q_yes, before.q_no, before.b, shares, 0).unwrap();
    assert!(cost_wad > 0);
    let cost_usdc = wad_to_usdc_ceil(cost_wad as u128).unwrap();
    let max_cost_wad = 10_000u128 * WAD_U;
    let accounts = trade_accounts(fixture, trader);

    send_ixs(
        &mut fixture.svm,
        &trader.keypair,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(500_000),
            build_ix(
                AMM_ID,
                accounts,
                sooth_amm::instruction::TradePositions {
                    outcome: 1,
                    delta_shares: shares,
                    max_cost_wad,
                },
            ),
        ],
    );
    cost_usdc
}

pub fn sell_yes(fixture: &mut Fixture, trader: &TraderFixture, shares: i128) -> u64 {
    assert!(shares > 0);
    let before = read_amm_state(&fixture.svm, &fixture.pdas.amm_state);
    let proceeds_wad = cost_delta(before.q_yes, before.q_no, before.b, -shares, 0)
        .unwrap()
        .unsigned_abs();
    let proceeds_usdc = wad_to_usdc_floor(proceeds_wad).unwrap();
    let position = read_position(&fixture.svm, &trader.position_pda);
    let nonce = position.lock_nonce;
    let (lock_entry, _) = Pubkey::find_program_address(
        &[
            b"lock_entry",
            trader.position_pda.as_ref(),
            nonce.to_le_bytes().as_ref(),
        ],
        &AMM_ID,
    );

    send_ixs(
        &mut fixture.svm,
        &trader.keypair,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(500_000),
            build_ix(
                AMM_ID,
                sooth_amm::accounts::SellPositions {
                    market: fixture.pdas.market,
                    amm_state: fixture.pdas.amm_state,
                    position: trader.position_pda,
                    vault_authority: fixture.pdas.vault_authority,
                    lock_authority: fixture.pdas.lock_authority,
                    market_vault: fixture.pdas.vault,
                    lock_vault: fixture.pdas.lock_vault,
                    lock_entry,
                    usdc_mint: USDC_MINT,
                    user: trader.keypair.pubkey(),
                    system_program: solana_sdk::system_program::ID,
                    token_program: spl_token::ID,
                    rent: solana_sdk::sysvar::rent::ID,
                    sooth_market_program: MARKET_ID,
                    instruction_sysvar: solana_sdk::sysvar::instructions::ID,
                },
                sooth_amm::instruction::SellPositions {
                    outcome: 1,
                    delta_shares: -shares,
                    min_proceeds_wad: 0,
                },
            ),
        ],
    );
    proceeds_usdc
}

pub fn dismiss_market(fixture: &mut Fixture) {
    fast_forward_past_trial(&mut fixture.svm, &fixture.pdas.amm_state);
    let ix = build_ix(
        AMM_ID,
        sooth_amm::accounts::DismissMarket {
            market: fixture.pdas.market,
            amm_state: fixture.pdas.amm_state,
            creator: fixture.creator.pubkey(),
        },
        sooth_amm::instruction::DismissMarket {},
    );
    send_ixs(&mut fixture.svm, &fixture.creator, &[ix]);
}

pub fn claim_refund_ix(fixture: &Fixture, trader: &TraderFixture) -> Instruction {
    build_ix(
        MARKET_ID,
        sooth_market::accounts::ClaimRefund {
            user: trader.keypair.pubkey(),
            market: fixture.pdas.market,
            amm_state: fixture.pdas.amm_state,
            vault_authority: fixture.pdas.vault_authority,
            market_vault: fixture.pdas.vault,
            user_usdc_ata: trader.usdc_ata,
            position: trader.position_pda,
            usdc_mint: USDC_MINT,
            token_program: spl_token::ID,
            sooth_amm_program: AMM_ID,
            instruction_sysvar: solana_sdk::sysvar::instructions::ID,
        },
        sooth_market::instruction::ClaimRefund {},
    )
}

pub fn direct_close_ix(fixture: &Fixture, trader: &TraderFixture) -> Instruction {
    build_ix(
        AMM_ID,
        sooth_amm::accounts::CloseDismissedPosition {
            user: trader.keypair.pubkey(),
            market: fixture.pdas.market,
            amm_state: fixture.pdas.amm_state,
            position: trader.position_pda,
            instruction_sysvar: solana_sdk::sysvar::instructions::ID,
        },
        sooth_amm::instruction::CloseDismissedPosition {},
    )
}

pub fn read_position(svm: &LiteSVM, position: &Pubkey) -> sooth_amm::state::Position {
    let acc = svm.get_account(position).expect("position missing");
    assert_eq!(acc.owner, AMM_ID);
    decode_anchor(&acc.data)
}

pub fn read_amm_state(svm: &LiteSVM, amm_state: &Pubkey) -> sooth_amm::state::AmmState {
    let acc = svm.get_account(amm_state).expect("amm_state missing");
    assert_eq!(acc.owner, AMM_ID);
    decode_anchor(&acc.data)
}

pub fn fetch_token_amount(svm: &LiteSVM, ata: Pubkey) -> u64 {
    let Some(acc) = svm.get_account(&ata) else {
        return 0;
    };
    if acc.data.is_empty() {
        return 0;
    }
    spl_token::state::Account::unpack(&acc.data)
        .expect("token unpack")
        .amount
}

pub fn is_closed(svm: &LiteSVM, account: &Pubkey) -> bool {
    svm.get_account(account)
        .map(|acc| {
            acc.lamports == 0
                || acc.owner == solana_sdk::system_program::ID
                || acc.data.is_empty()
                || acc.data.iter().all(|b| *b == 0)
        })
        .unwrap_or(true)
}

pub fn send_ixs(svm: &mut LiteSVM, signer: &Keypair, ixs: &[Instruction]) {
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

pub fn try_send_ixs(
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

pub fn assert_anchor_error(err: litesvm::types::FailedTransactionMetadata, expected: &str) {
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(expected),
        "expected Anchor error {expected}, err={:?}, logs={logs}",
        err.err
    );
}

fn seed_lp(fixture: &mut Fixture) {
    let creator_lp_ata =
        get_associated_token_address(&fixture.creator.pubkey(), &fixture.pdas.lp_mint);
    let (lp_position, _) = Pubkey::find_program_address(
        &[
            b"lp_position",
            fixture.pdas.market_id.as_ref(),
            fixture.creator.pubkey().as_ref(),
        ],
        &LAUNCHPAD_ID,
    );
    send_ixs(
        &mut fixture.svm,
        &fixture.creator,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(500_000),
            build_ix(
                LAUNCHPAD_ID,
                sooth_launchpad::accounts::SeedLp {
                    config: fixture.protocol_config_pda,
                    market: fixture.pdas.market,
                    amm_state: fixture.pdas.amm_state,
                    lp_mint: fixture.pdas.lp_mint,
                    lp_mint_authority: fixture.pdas.lp_mint_authority,
                    creator_lp_ata,
                    lp_position,
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

fn trade_accounts(
    fixture: &Fixture,
    trader: &TraderFixture,
) -> sooth_amm::accounts::TradePositions {
    sooth_amm::accounts::TradePositions {
        market: fixture.pdas.market,
        amm_state: fixture.pdas.amm_state,
        position: trader.position_pda,
        vault_authority: fixture.pdas.vault_authority,
        user_usdc_ata: trader.usdc_ata,
        market_vault: fixture.pdas.vault,
        usdc_mint: USDC_MINT,
        protocol_config: fixture.protocol_config_pda,
        market_fee_pool: fixture.fee_pool_vault,
        lp_mint: fixture.pdas.lp_mint,
        lp_mint_authority: fixture.pdas.lp_mint_authority,
        user_lp_ata: trader.lp_ata,
        user: trader.keypair.pubkey(),
        system_program: solana_sdk::system_program::ID,
        token_program: spl_token::ID,
        rent: solana_sdk::sysvar::rent::ID,
        sooth_launchpad_program: LAUNCHPAD_ID,
        instruction_sysvar: solana_sdk::sysvar::instructions::ID,
    }
}

fn fast_forward_past_trial(svm: &mut LiteSVM, amm_state: &Pubkey) {
    let amm = read_amm_state(svm, amm_state);
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = amm.trial_end_at + 1;
    svm.set_sysvar(&clock);
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

fn decode_anchor<T: AccountDeserialize>(data: &[u8]) -> T {
    T::try_deserialize(&mut &data[..]).expect("anchor decode failed")
}

pub fn write_position(
    svm: &mut LiteSVM,
    position_pubkey: &Pubkey,
    position: &sooth_amm::state::Position,
) {
    let mut acc = svm.get_account(position_pubkey).expect("position missing");
    let mut data = Vec::with_capacity(sooth_amm::state::Position::SPACE);
    position
        .try_serialize(&mut data)
        .expect("position serialize failed");
    assert_eq!(data.len(), sooth_amm::state::Position::SPACE);
    acc.data = data;
    svm.set_account(*position_pubkey, acc).unwrap();
}

pub fn one_share() -> i128 {
    WAD
}
