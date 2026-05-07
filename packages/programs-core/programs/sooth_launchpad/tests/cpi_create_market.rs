//! Runtime CPI integration test: `sooth_launchpad::create_market` →
//! 4-way init flow (`sooth_market::initialize_market` +
//! `initialize_outcome_mints` + `initialize_market_vaults` +
//! `sooth_amm::initialize_amm_state`).
//!
//! Mirrors the assertions in `packages/sdk-solana/tests/create-market.test.ts`
//! (TS bankrun harness) but in pure Rust against LiteSVM, so the runtime
//! coverage is no longer SDK-side-only — `cargo test -p sooth_launchpad`
//! now exercises the same surface.
//!
//! Coverage:
//!   1. After one `create_market` ix, the four leg-1..leg-4 PDAs all exist
//!      with the expected program owners (Market PDA owned by sooth_market,
//!      both outcome mints + USDC vault + lock_vault owned by spl-token,
//!      AmmState PDA owned by sooth_amm).
//!   2. The `Market` PDA's lifecycle flips to `Open` after leg 3, the
//!      outcome mints / vault addresses are mirrored on-record, and the
//!      stored bumps round-trip to `find_program_address`.
//!   3. The `AmmState` PDA's `b` matches `args.initial_b`, `q_yes`/`q_no`
//!      start at zero, `is_graduated` is false, and `trial_end_at` lands
//!      inside the architecture-§9 ±60s tolerance band.
//!
//! Compute budget: lifted to 1.4M (the runtime maximum) via a prepended
//! `ComputeBudgetInstruction::set_compute_unit_limit` ix because the four
//! chained CPIs comfortably blow past the 200k default. Mirrors the TS
//! bankrun harness's `computeMaxUnits` lift.

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
use spl_associated_token_account::get_associated_token_address;
use spl_token::state::Mint;

const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;
const MARKET_ID: Pubkey = sooth_market::ID;
const AMM_ID: Pubkey = sooth_amm::ID;
const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;

const NOW_TS: i64 = 1_000_000;
const INITIAL_B_WAD: u128 = 1_000u128 * 1_000_000_000_000_000_000u128;

#[test]
fn create_market_initializes_all_four_pdas_via_cpi() {
    // ─── 0. Boot LiteSVM with all three programs at their declare_id! ────
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

    // ─── 1. USDC mint + funded creator + clock warp ───────────────────────
    let mint_authority = Pubkey::new_unique();
    write_mint(&mut svm, USDC_MINT, mint_authority);

    let creator = Keypair::new();
    svm.airdrop(&creator.pubkey(), 50_000_000_000).unwrap();

    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = NOW_TS;
    svm.set_sysvar(&clock);

    // ─── 2. Adjudicator allowlist bootstrap ───────────────────────────────
    //
    // `initialize_market` (driven by leg 1 of `create_market`) requires the
    // singleton `AdjudicatorAllowlist` to exist and to contain the proposed
    // `args.adjudicator`. Same one-shot bootstrap as the TS bankrun
    // fixture; the creator doubles as both the allowlist authority and the
    // adjudicator for the demo (collapsed-roles convention).
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

    // ─── 3. Singleton ProtocolConfig (sooth_launchpad) ────────────────────
    //
    // `create_market` reads `default_trial_period` from this PDA to drive
    // the `compute_trial_end_at` formula passed to leg 4.
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

    // ─── 4. Per-market PDA derivation ────────────────────────────────────
    let market_id: [u8; 16] = {
        let mut id = [0u8; 16];
        for (i, b) in id.iter_mut().enumerate() {
            *b = (i as u8) * 17;
        }
        id
    };
    let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &MARKET_ID);
    let (vault_authority, vault_authority_bump) =
        Pubkey::find_program_address(&[b"vault", &market_id], &MARKET_ID);
    let (lock_authority, lock_authority_bump) =
        Pubkey::find_program_address(&[b"lock", &market_id], &MARKET_ID);
    let (yes_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"y"], &MARKET_ID);
    let (no_mint, _) = Pubkey::find_program_address(&[b"mint", &market_id, b"n"], &MARKET_ID);
    let vault = get_associated_token_address(&vault_authority, &USDC_MINT);
    let lock_vault = get_associated_token_address(&lock_authority, &USDC_MINT);
    let (amm_state, _) = Pubkey::find_program_address(&[b"amm", &market_id], &AMM_ID);

    // ─── 5. Dispatch create_market ────────────────────────────────────────
    let deadline = NOW_TS + 7 * 24 * 60 * 60;
    let create_args = sooth_launchpad::instructions::CreateMarketArgs {
        market_id,
        question_hash: [0u8; 32],
        start_time: NOW_TS,
        deadline,
        adjudicator: creator.pubkey(),
        initial_b: INITIAL_B_WAD,
    };
    let accounts = sooth_launchpad::accounts::CreateMarket {
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
        accounts,
        sooth_launchpad::instruction::CreateMarket { args: create_args },
    );

    // 1.4M CU lift — same as the TS bankrun harness.
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    send_ixs(&mut svm, &creator, &[cu, create_ix]);

    // ─── 6. Assert: all four PDAs exist with the right owners ────────────
    let market_acc = svm.get_account(&market).expect("market PDA missing");
    assert_eq!(market_acc.owner, MARKET_ID);

    let yes_mint_acc = svm.get_account(&yes_mint).expect("yes_mint missing");
    assert_eq!(yes_mint_acc.owner, spl_token::ID);

    let no_mint_acc = svm.get_account(&no_mint).expect("no_mint missing");
    assert_eq!(no_mint_acc.owner, spl_token::ID);

    let vault_acc = svm.get_account(&vault).expect("vault ATA missing");
    assert_eq!(vault_acc.owner, spl_token::ID);

    let lock_vault_acc = svm
        .get_account(&lock_vault)
        .expect("lock_vault ATA missing");
    assert_eq!(lock_vault_acc.owner, spl_token::ID);

    let amm_state_acc = svm.get_account(&amm_state).expect("amm_state PDA missing");
    assert_eq!(amm_state_acc.owner, AMM_ID);

    // ─── 7. Decode + assert on the stored fields ─────────────────────────
    let market_state: sooth_market::state::Market = decode_anchor(&market_acc.data);
    assert_eq!(market_state.creator, creator.pubkey());
    assert_eq!(market_state.adjudicator, creator.pubkey());
    assert_eq!(market_state.yes_mint, yes_mint);
    assert_eq!(market_state.no_mint, no_mint);
    assert_eq!(market_state.vault, vault);
    assert_eq!(market_state.lock_vault, lock_vault);
    assert!(matches!(
        market_state.lifecycle,
        sooth_market::state::MarketLifecycle::Open
    ));
    assert_eq!(market_state.vault_authority_bump, vault_authority_bump);
    assert_eq!(market_state.lock_authority_bump, lock_authority_bump);

    let amm: sooth_amm::state::AmmState = decode_anchor(&amm_state_acc.data);
    assert_eq!(amm.market, market);
    assert_eq!(amm.b as u128, INITIAL_B_WAD);
    assert_eq!(amm.q_yes, 0);
    assert_eq!(amm.q_no, 0);
    assert!(!amm.is_graduated);

    // `trial_end_at = now + min(0.3 × (deadline - now), default_trial_period)`.
    // window = 7 days = 604_800s, default = 7 days, so trial = 30% × window
    // = 181_440s. ±60s tolerance for chain-time sampling drift inside the
    // create_market handler.
    let expected_trial_end = NOW_TS + (7 * 24 * 60 * 60 * 3) / 10;
    assert!(
        (amm.trial_end_at - expected_trial_end).abs() <= 60,
        "trial_end_at {} too far from expected {}",
        amm.trial_end_at,
        expected_trial_end
    );

    // Silence unused locals.
    let _ = mint_authority;
}

// ─── Helpers (slimmed-down mirror of sooth_market/tests/common/mod.rs) ────

/// Resolve the workspace `target/deploy/` from this file's location.
fn target_deploy() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../../..");
    p.push("target/deploy");
    p.canonicalize()
        .expect("target/deploy not found; run `cargo build-sbf` for each program first")
}

/// Pubkey-only `Accounts` struct → `ToAccountMetas`; args struct →
/// `InstructionData`. Together they specify a complete top-level Solana
/// `Instruction`.
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
