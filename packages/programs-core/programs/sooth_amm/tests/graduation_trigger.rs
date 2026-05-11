//! Runtime integration test for the AMM graduation trigger.

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
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

use sooth_amm::math::{cost_delta, wad_mul, LN2_WAD, WAD, WAD_U};

const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;
const MARKET_ID: Pubkey = sooth_market::ID;
const AMM_ID: Pubkey = sooth_amm::ID;
const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;

const NOW_TS: i64 = 1_000_000;
const FEE_BPS: u16 = 10_000;
const INITIAL_B_WAD: u128 = 10u128 * WAD_U;
const SEED_DEPOSIT_WAD: u128 = 10u128 * WAD_U;
const SEED_LP_AMOUNT: u64 = 10_000_000;
const DELTA_SHARES_WAD: i128 = 5i128 * WAD;

#[test]
fn cumulative_fees_crossing_b_ln2_graduates_once() {
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
    let trader = Keypair::new();
    svm.airdrop(&creator.pubkey(), 50_000_000_000).unwrap();
    svm.airdrop(&trader.pubkey(), 50_000_000_000).unwrap();
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

    let market_id: [u8; 16] = {
        let mut id = [0u8; 16];
        for (i, b) in id.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(31).wrapping_add(7);
        }
        id
    };
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
    let (position_pda, _) =
        Pubkey::find_program_address(&[b"pos", &market_id, trader.pubkey().as_ref()], &AMM_ID);

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
        &creator,
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
        &creator,
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

    let trader_usdc_ata = get_associated_token_address(&trader.pubkey(), &USDC_MINT);
    let trader_lp_ata = get_associated_token_address(&trader.pubkey(), &lp_mint);
    send_ixs(
        &mut svm,
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
                &lp_mint,
                &spl_token::ID,
            ),
        ],
    );
    send_ixs(
        &mut svm,
        &mint_authority,
        &[spl_token::instruction::mint_to(
            &spl_token::ID,
            &USDC_MINT,
            &trader_usdc_ata,
            &mint_authority.pubkey(),
            &[],
            100_000_000,
        )
        .unwrap()],
    );

    let initial_amm = read_amm_state(&svm, &amm_state);
    assert_eq!(initial_amm.fee_b_base_wad, 0);
    assert!(!initial_amm.is_graduated);
    let threshold_wad = wad_mul(initial_amm.b, LN2_WAD).unwrap() as u128;
    assert_eq!(
        threshold_wad,
        INITIAL_B_WAD
            .checked_mul(LN2_WAD as u128)
            .and_then(|v| v.checked_div(WAD_U))
            .unwrap()
    );

    for trade_index in 0..8 {
        let before = read_amm_state(&svm, &amm_state);
        let expected_fee = expected_fee_wad(before.q_yes, before.q_no, before.b, DELTA_SHARES_WAD);
        assert!(
            before.fee_b_base_wad < threshold_wad || before.is_graduated,
            "trade {trade_index}: fee threshold crossed without graduation"
        );
        if before.fee_b_base_wad < threshold_wad {
            assert!(!before.is_graduated, "pre-crossing market graduated early");
        }

        svm.expire_blockhash();
        send_buy(
            &mut svm,
            &trader,
            market,
            amm_state,
            position_pda,
            vault_authority,
            trader_usdc_ata,
            vault,
            protocol_config_pda,
            fee_pool_vault,
            lp_mint,
            lp_mint_authority,
            trader_lp_ata,
        );

        let after = read_amm_state(&svm, &amm_state);
        assert_eq!(after.fee_b_base_wad, before.fee_b_base_wad + expected_fee);
        if before.fee_b_base_wad < threshold_wad && after.fee_b_base_wad >= threshold_wad {
            assert!(
                after.is_graduated,
                "market should graduate once cumulative fees cross b*ln(2)"
            );

            let post_cross_fee =
                expected_fee_wad(after.q_yes, after.q_no, after.b, DELTA_SHARES_WAD);
            svm.expire_blockhash();
            send_buy(
                &mut svm,
                &trader,
                market,
                amm_state,
                position_pda,
                vault_authority,
                trader_usdc_ata,
                vault,
                protocol_config_pda,
                fee_pool_vault,
                lp_mint,
                lp_mint_authority,
                trader_lp_ata,
            );

            let after_post = read_amm_state(&svm, &amm_state);
            assert!(after_post.is_graduated);
            assert_eq!(
                after_post.fee_b_base_wad,
                after.fee_b_base_wad + post_cross_fee
            );
            return;
        }

        assert!(
            !after.is_graduated,
            "market graduated before cumulative fees reached b*ln(2)"
        );
    }

    panic!("test did not reach graduation threshold");
}

fn send_buy(
    svm: &mut LiteSVM,
    trader: &Keypair,
    market: Pubkey,
    amm_state: Pubkey,
    position: Pubkey,
    vault_authority: Pubkey,
    user_usdc_ata: Pubkey,
    market_vault: Pubkey,
    protocol_config: Pubkey,
    fee_pool_vault: Pubkey,
    lp_mint: Pubkey,
    lp_mint_authority: Pubkey,
    user_lp_ata: Pubkey,
) {
    let max_cost_wad: u128 = 20u128 * WAD_U;
    let trade_accounts = sooth_amm::accounts::TradePositions {
        market,
        amm_state,
        position,
        vault_authority,
        user_usdc_ata,
        market_vault,
        usdc_mint: USDC_MINT,
        protocol_config,
        market_fee_pool: fee_pool_vault,
        lp_mint,
        lp_mint_authority,
        user_lp_ata,
        user: trader.pubkey(),
        system_program: solana_sdk::system_program::ID,
        token_program: spl_token::ID,
        rent: solana_sdk::sysvar::rent::ID,
        sooth_launchpad_program: LAUNCHPAD_ID,
        instruction_sysvar: solana_sdk::sysvar::instructions::ID,
    };
    send_ixs(
        svm,
        trader,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(400_000),
            build_ix(
                AMM_ID,
                trade_accounts,
                sooth_amm::instruction::TradePositions {
                    outcome: 1,
                    delta_shares: DELTA_SHARES_WAD,
                    max_cost_wad,
                },
            ),
        ],
    );
}

fn expected_fee_wad(q_yes: i128, q_no: i128, b: i128, delta_shares: i128) -> u128 {
    let cost_wad = cost_delta(q_yes, q_no, b, delta_shares, 0).unwrap();
    assert!(cost_wad > 0);
    (cost_wad as u128).checked_mul(FEE_BPS as u128).unwrap() / 10_000
}

fn read_amm_state(svm: &LiteSVM, amm_state: &Pubkey) -> sooth_amm::state::AmmState {
    let acc = svm.get_account(amm_state).expect("amm_state missing");
    assert_eq!(acc.owner, AMM_ID);
    decode_anchor(&acc.data)
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
