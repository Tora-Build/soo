//! Runtime CPI integration test: `sooth_amm::trade_positions` →
//! `sooth_launchpad::mint_lp_for_buy` (architecture §4.2 — pre-graduation
//! buys mint LP units to the trader proportional to fee paid).
//!
//! Mirrors the harness pattern of `cpi_create_market.rs`. Sequence:
//!   1. Boot LiteSVM with all four `.so` binaries.
//!   2. Bootstrap singletons: AdjudicatorAllowlist, ProtocolConfig,
//!      fee_pool_vault.
//!   3. Drive `create_market` (4-leg CPI) to land the per-market PDAs +
//!      AmmState.
//!   4. Drive `seed_lp` to bootstrap the per-market LP mint, mint authority,
//!      and the creator's LP position record.
//!   5. Fund a trader user with USDC + create their LP ATA idempotently.
//!   6. Dispatch `trade_positions` to buy 10 YES.
//!   7. Assert the trader's LP ATA balance grew and the LP mint's
//!      `supply` increased correspondingly.
//!
//! The test pins the architecture §4.2 invariant: every pre-graduation buy
//! produces a non-zero LP-mint side-effect proportional to the fee paid.

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
use spl_token::state::{Account as TokenAccount, Mint};

const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;
const MARKET_ID: Pubkey = sooth_market::ID;
const AMM_ID: Pubkey = sooth_amm::ID;
const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;

const NOW_TS: i64 = 1_000_000;
const INITIAL_B_WAD: u128 = 1_000u128 * 1_000_000_000_000_000_000u128;
const SEED_DEPOSIT_WAD: u128 = 10u128 * 1_000_000_000_000_000_000u128;
// Creator's initial LP allocation (USDC base units; matches seed_lp's
// `lp_amount = total_initial_b` convention — see seed_lp.rs §"Initial LP
// allocation formula"). 10 USDC at 6 decimals.
const SEED_LP_AMOUNT: u64 = 10_000_000;

/// Trade size: 10 YES shares in WAD. Mirrors apps/demo/tests/amm-buy-flow.
const DELTA_SHARES_WAD: i128 = 10i128 * 1_000_000_000_000_000_000i128;

#[test]
fn pre_graduation_buy_mints_lp_to_trader() {
    // ─── 0. Boot LiteSVM with all four programs at their declare_id! ─────
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

    // ─── 1. USDC mint + funded creator/trader + clock warp ───────────────
    let mint_authority = Keypair::new();
    write_mint(&mut svm, USDC_MINT, mint_authority.pubkey());

    let creator = Keypair::new();
    let trader = Keypair::new();
    svm.airdrop(&creator.pubkey(), 50_000_000_000).unwrap();
    svm.airdrop(&trader.pubkey(), 50_000_000_000).unwrap();
    svm.airdrop(&mint_authority.pubkey(), 5_000_000_000).unwrap();

    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = NOW_TS;
    svm.set_sysvar(&clock);

    // ─── 2. Adjudicator allowlist bootstrap ──────────────────────────────
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

    // ─── 3. ProtocolConfig + fee_pool_vault singletons ───────────────────
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
                    fee_bps: 100, // 1%
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

    // ─── 4. Per-market PDA derivation ────────────────────────────────────
    let market_id: [u8; 16] = {
        let mut id = [0u8; 16];
        for (i, b) in id.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(19).wrapping_add(3);
        }
        id
    };
    let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &MARKET_ID);
    let (vault_authority, _) =
        Pubkey::find_program_address(&[b"vault", &market_id], &MARKET_ID);
    let (lock_authority, _) =
        Pubkey::find_program_address(&[b"lock", &market_id], &MARKET_ID);
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
    let (position_pda, _) = Pubkey::find_program_address(
        &[b"pos", &market_id, trader.pubkey().as_ref()],
        &AMM_ID,
    );

    // ─── 5. create_market (4-leg CPI) ────────────────────────────────────
    let deadline = NOW_TS + 7 * 24 * 60 * 60;
    let create_args = sooth_launchpad::instructions::CreateMarketArgs {
        market_id,
        question_hash: [0u8; 32],
        start_time: NOW_TS,
        deadline,
        adjudicator: creator.pubkey(),
        initial_b: INITIAL_B_WAD,
    };
    let create_accounts = sooth_launchpad::accounts::CreateMarket {
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
    };
    let create_ix = build_ix(
        LAUNCHPAD_ID,
        create_accounts,
        sooth_launchpad::instruction::CreateMarket { args: create_args },
    );
    send_ixs(
        &mut svm,
        &creator,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            create_ix,
        ],
    );

    // ─── 6. seed_lp — bootstrap LP mint + creator LP allocation ──────────
    let creator_lp_ata = get_associated_token_address(&creator.pubkey(), &lp_mint);
    let seed_lp_ix = build_ix(
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
    );
    send_ixs(
        &mut svm,
        &creator,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(400_000),
            seed_lp_ix,
        ],
    );

    // Snapshot lp_mint.supply right after seed (= SEED_LP_AMOUNT).
    let supply_after_seed = read_mint_supply(&svm, &lp_mint);
    assert_eq!(
        supply_after_seed, SEED_LP_AMOUNT,
        "seed_lp should mint exactly SEED_LP_AMOUNT to creator_lp_ata"
    );

    // ─── 7. Trader USDC ATA + LP ATA + funding ───────────────────────────
    let trader_usdc_ata = get_associated_token_address(&trader.pubkey(), &USDC_MINT);
    let trader_lp_ata = get_associated_token_address(&trader.pubkey(), &lp_mint);

    // Create both ATAs idempotently (the trader pays). Also mint USDC into
    // the trader's USDC ATA so the buy can pay cost+fee.
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

    // Mint 100 USDC to the trader. Mint authority = `mint_authority`
    // keypair; needs its own signer.
    send_ixs(
        &mut svm,
        &mint_authority,
        &[spl_token::instruction::mint_to(
            &spl_token::ID,
            &USDC_MINT,
            &trader_usdc_ata,
            &mint_authority.pubkey(),
            &[],
            100_000_000, // 100 USDC at 6 decimals
        )
        .unwrap()],
    );

    // ─── 8. Dispatch trade_positions buy 10 YES ──────────────────────────
    //
    // `max_cost_wad`: pick a generous ceiling to avoid the slippage check
    // tripping on the LMSR cost from a balanced book. 10 YES at b = 1000
    // WAD costs ≈ 5.025 WAD; with 1% fee adds 0.05 WAD. Set to 6 WAD
    // (6e18) for headroom.
    let max_cost_wad: u128 = 6u128 * 1_000_000_000_000_000_000u128;
    let trade_accounts = sooth_amm::accounts::TradePositions {
        market,
        amm_state,
        position: position_pda,
        vault_authority,
        user_usdc_ata: trader_usdc_ata,
        market_vault: vault,
        usdc_mint: USDC_MINT,
        protocol_config: protocol_config_pda,
        fee_pool_vault,
        lp_mint,
        lp_mint_authority,
        user_lp_ata: trader_lp_ata,
        user: trader.pubkey(),
        system_program: solana_sdk::system_program::ID,
        token_program: spl_token::ID,
        rent: solana_sdk::sysvar::rent::ID,
        sooth_launchpad_program: LAUNCHPAD_ID,
        instruction_sysvar: solana_sdk::sysvar::instructions::ID,
    };
    let trade_ix = build_ix(
        AMM_ID,
        trade_accounts,
        sooth_amm::instruction::TradePositions {
            outcome: 1, // YES
            delta_shares: DELTA_SHARES_WAD,
            max_cost_wad,
        },
    );

    send_ixs(
        &mut svm,
        &trader,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(400_000),
            trade_ix,
        ],
    );

    // ─── 9. Assertions ───────────────────────────────────────────────────
    //
    // Architecture §4.2: pre-graduation buys mint LP units to the trader.
    // The amount is `fee_usdc` (1% of cost, ceil-converted from WAD), so
    // for a ~5 WAD cost the trader gets ~50_000 LP base units (0.05 LP
    // at 6 decimals).
    let trader_lp_balance = read_token_amount(&svm, &trader_lp_ata);
    assert!(
        trader_lp_balance > 0,
        "trader_lp_ata should have non-zero LP balance after pre-graduation buy; got 0"
    );

    let supply_after_trade = read_mint_supply(&svm, &lp_mint);
    assert!(
        supply_after_trade > supply_after_seed,
        "lp_mint.supply should grow after pre-graduation buy: before={} after={}",
        supply_after_seed,
        supply_after_trade,
    );
    assert_eq!(
        supply_after_trade - supply_after_seed,
        trader_lp_balance,
        "lp_mint.supply delta must equal trader_lp_ata balance delta",
    );

    // Sanity: the position was actually mutated by the trade (not just
    // the LP-mint side-effect), so the architecture invariant holds:
    // Position mutation and LP-mint are one indivisible buy step.
    let position_acc = svm
        .get_account(&position_pda)
        .expect("position PDA missing after trade");
    assert_eq!(position_acc.owner, AMM_ID);
    let position: sooth_amm::state::Position = decode_anchor(&position_acc.data);
    assert_eq!(position.yes_shares, DELTA_SHARES_WAD);
    assert_eq!(position.no_shares, 0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

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

fn decode_anchor<T: anchor_lang::AccountDeserialize>(data: &[u8]) -> T {
    T::try_deserialize(&mut &data[..]).expect("anchor decode failed")
}
