//! Shared LiteSVM harness for the runtime CPI integration tests.
//!
//! Boots a fresh `LiteSVM` with the four `.so` binaries (`sooth_market`,
//! `sooth_amm`, `sooth_launchpad`, `sooth_adjudicator`) pre-loaded at their
//! `declare_id!` placeholder addresses, hand-writes the canonical USDC mint
//! account, funds a creator keypair, and seeds the singletons that
//! `initialize_market` requires (adjudicator allowlist + protocol config).
//! The optional `bootstrap_market` helper drives the four-leg create flow
//! to completion (Market + outcome mints + vaults + AmmState all live) and
//! the optional `register_adjudicator` helper layers the per-market
//! `Adjudicator` PDA on top so the adjudicator-side ixs can run.
//!
//! This file is intentionally NOT a `#[test]` binary — `tests/common/mod.rs`
//! is a Cargo convention for shared module code; the actual `#[test]` fns
//! live in the sibling `tests/cpi_*.rs` files which `mod common;` it in.
//!
//! ## Why LiteSVM (not solana-program-test/BanksClient)
//!
//! Both work on this toolchain. LiteSVM 0.2.x pins to `solana-program ~1.18`
//! (matches our Anchor 0.30.1 envelope), runs synchronously (no tokio
//! runtime needed in tests), and ships a single dependency line. The Wave 5C
//! agent recommended BanksClient; both options were spiked, LiteSVM 0.2.1
//! compiled cleanly without any version-pin gymnastics so we adopted it.
//!
//! ## Why each binary path lookup checks for `target/deploy`
//!
//! The on-chain `.so` binaries are produced by `cargo build-sbf` per
//! program (workspace-build emits stub `.so` files with no entrypoint —
//! same caveat documented in each program's `Cargo.toml` toolchain notes).
//! If the binaries are missing the harness fails fast with a clear error
//! pointing at the build step.

#![allow(dead_code)]

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar;
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account, compute_budget::ComputeBudgetInstruction, message::Message,
    signature::Keypair, signer::Signer, sysvar::clock::Clock, transaction::Transaction,
};
use solana_sdk::program_pack::Pack;
use spl_associated_token_account::get_associated_token_address;
use spl_token::state::Mint;

pub const USDC_MINT: Pubkey = sooth_market::USDC_MINT_DEVNET;

/// Address-of-truth program ids — re-exported from each program crate's
/// `declare_id!`. Kept here as locals so the test code reads cleanly.
pub const MARKET_ID: Pubkey = sooth_market::ID;
pub const AMM_ID: Pubkey = sooth_amm::ID;
pub const LAUNCHPAD_ID: Pubkey = sooth_launchpad::ID;
pub const ADJ_ID: Pubkey = sooth_adjudicator::ID;

/// Wall-clock baseline used by every CPI test. Mirrors the SDK bankrun
/// fixtures' `1_000_000` so the deadline math stays consistent.
pub const NOW_TS: i64 = 1_000_000;

/// Default initial LMSR liquidity parameter `b` in WAD. Matches the SDK
/// fixture default (`1_000 * WAD`) — pinned so any future arithmetic
/// regression in `initialize_amm_state` shows up under the same input.
pub const INITIAL_B_WAD: u128 = 1_000u128 * 1_000_000_000_000_000_000u128;

/// Resolves the workspace's `target/deploy/` from this file's location.
fn target_deploy() -> PathBuf {
    // tests/common/mod.rs → tests/ → sooth_market/ → programs/ →
    // programs-core/ → packages/ → repo-root
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../../..");
    p.push("target/deploy");
    p.canonicalize()
        .expect("target/deploy not found; run `cargo build-sbf` for each program first")
}

/// Bootstrap state produced by `boot_with_singletons` — held by every
/// downstream helper. Owns the SVM (mutable, all writes go through it).
pub struct Harness {
    pub svm: LiteSVM,
    pub creator: Keypair,
    pub allowlist_pda: Pubkey,
    pub protocol_config_pda: Pubkey,
}

impl Harness {
    /// Boot LiteSVM, load all four .so binaries at their declare_id!
    /// addresses, stand up the canonical USDC mint, fund the creator,
    /// initialise the adjudicator allowlist, add the creator as an
    /// allowlisted adjudicator, and initialise the launchpad's
    /// `ProtocolConfig`. After this returns the cluster is ready to dispatch
    /// `create_market` (as in `cpi_create_market.rs`) or the per-leg flow
    /// (as in the sooth_market/tests/cpi_*.rs files).
    pub fn boot() -> Self {
        let mut svm = LiteSVM::new();

        // Load .so binaries. add_program_from_file panics on missing file
        // with a clear path-context message.
        let dir = target_deploy();
        for (name, id) in [
            ("sooth_market.so", MARKET_ID),
            ("sooth_amm.so", AMM_ID),
            ("sooth_launchpad.so", LAUNCHPAD_ID),
            ("sooth_adjudicator.so", ADJ_ID),
        ] {
            let path = dir.join(name);
            assert!(
                path.exists(),
                "missing {}; run `cargo build-sbf` for each program first",
                path.display()
            );
            svm.add_program_from_file(id, &path).unwrap();
        }

        // Hand-write the canonical USDC mint at USDC_MINT_DEVNET. The
        // on-chain Accounts entries pin `usdc_mint` to that exact address;
        // we can't use real devnet USDC under LiteSVM. The mint authority
        // is a throwaway (we don't mint test USDC in any of these tests).
        let mint_authority = Pubkey::new_unique();
        write_mint(&mut svm, USDC_MINT, mint_authority);

        // Funded creator. Doubles as allowlist authority + adjudicator
        // authority + market creator + protocol config authority — same
        // collapsed-role convention as the bankrun fixtures.
        let creator = Keypair::new();
        svm.airdrop(&creator.pubkey(), 50_000_000_000).unwrap();

        // Warp the clock to NOW_TS so `compute_trial_end_at` etc. don't
        // collapse to zero. LiteSVM's default clock starts at unix_ts = 0.
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW_TS;
        svm.set_sysvar(&clock);

        // Singleton bootstrap — adjudicator allowlist.
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

        // Singleton bootstrap — launchpad ProtocolConfig. `create_market`
        // reads `default_trial_period` from this PDA.
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

        Self {
            svm,
            creator,
            allowlist_pda,
            protocol_config_pda,
        }
    }
}

/// PDAs for one market — derived once and threaded through the per-leg ixs.
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
    pub adjudicator_pda: Pubkey,
}

impl MarketPdas {
    /// Derive every per-market PDA from a 16-byte market id seed.
    pub fn derive(market_id: [u8; 16]) -> Self {
        let (market, _) = Pubkey::find_program_address(&[b"market", &market_id], &MARKET_ID);
        let (vault_authority, _) =
            Pubkey::find_program_address(&[b"vault", &market_id], &MARKET_ID);
        let (lock_authority, _) = Pubkey::find_program_address(&[b"lock", &market_id], &MARKET_ID);
        let (yes_mint, _) =
            Pubkey::find_program_address(&[b"mint", &market_id, b"y"], &MARKET_ID);
        let (no_mint, _) =
            Pubkey::find_program_address(&[b"mint", &market_id, b"n"], &MARKET_ID);
        let vault = get_associated_token_address(&vault_authority, &USDC_MINT);
        let lock_vault = get_associated_token_address(&lock_authority, &USDC_MINT);
        let (amm_state, _) = Pubkey::find_program_address(&[b"amm", &market_id], &AMM_ID);
        let (adjudicator_pda, _) = Pubkey::find_program_address(
            &[sooth_adjudicator::state::ADJUDICATOR_SEED, market.as_ref()],
            &ADJ_ID,
        );
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
            adjudicator_pda,
        }
    }
}

/// Fully bring a market to `Open` lifecycle by dispatching the 4-way init via
/// `sooth_launchpad::create_market`. Mirrors the canonical happy path that
/// the SDK adapter and the localnet seed script both use.
///
/// Uses a deterministic 16-byte market id derived from the call site so each
/// test file gets a unique market without stepping on others. Returns the
/// derived PDAs.
pub fn bootstrap_market(harness: &mut Harness, market_id: [u8; 16]) -> MarketPdas {
    let pdas = MarketPdas::derive(market_id);
    let now = current_clock_ts(&harness.svm);
    let deadline = now + 7 * 24 * 60 * 60;
    let create_args = sooth_launchpad::instructions::CreateMarketArgs {
        market_id,
        question_hash: [0u8; 32],
        start_time: now,
        deadline,
        adjudicator: harness.creator.pubkey(),
        initial_b: INITIAL_B_WAD,
    };
    let accounts = sooth_launchpad::accounts::CreateMarket {
        config: harness.protocol_config_pda,
        market: pdas.market,
        adjudicator_allowlist: harness.allowlist_pda,
        vault_authority: pdas.vault_authority,
        yes_mint: pdas.yes_mint,
        no_mint: pdas.no_mint,
        lock_authority: pdas.lock_authority,
        usdc_mint: USDC_MINT,
        vault: pdas.vault,
        lock_vault: pdas.lock_vault,
        amm_state: pdas.amm_state,
        creator: harness.creator.pubkey(),
        sooth_market_program: MARKET_ID,
        sooth_amm_program: AMM_ID,
        token_program: spl_token::ID,
        associated_token_program: spl_associated_token_account::ID,
        system_program: solana_sdk::system_program::ID,
        rent: solana_sdk::sysvar::rent::ID,
    };
    let ix = build_ix(
        LAUNCHPAD_ID,
        accounts,
        sooth_launchpad::instruction::CreateMarket { args: create_args },
    );
    let creator_kp = clone_keypair(&harness.creator);
    // `create_market` chains four CPIs (init_market + outcome mints + vaults +
    // amm_state) and easily blows past the default 200k CU per top-level ix.
    // The TS bankrun harness sets `computeMaxUnits = 1_400_000` globally;
    // we lift the per-tx limit via a ComputeBudget ix instead so the rest of
    // the cluster keeps the default. 1.4M is the runtime maximum.
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    send_ixs(&mut harness.svm, &creator_kp, &[cu, ix]);
    pdas
}

/// Layer the per-market `Adjudicator` PDA on top of an already-bootstrapped
/// market. v1 Manual variant; the creator is both market.creator (signs
/// register) and the adjudicator authority (signs request_lock /
/// attest_outcome later). Mirrors `seed-localnet.mjs`'s collapsed roles.
pub fn register_adjudicator(harness: &mut Harness, pdas: &MarketPdas) {
    let ix = build_ix(
        ADJ_ID,
        sooth_adjudicator::accounts::RegisterAdjudicator {
            adjudicator: pdas.adjudicator_pda,
            market: pdas.market,
            signer: harness.creator.pubkey(),
            system_program: solana_sdk::system_program::ID,
        },
        sooth_adjudicator::instruction::RegisterAdjudicator {
            authority: harness.creator.pubkey(),
            kind: sooth_adjudicator::AdjudicatorKind::Manual,
        },
    );
    let creator_kp = clone_keypair(&harness.creator);
    send_ixs(&mut harness.svm, &creator_kp, &[ix]);
}

/// Build a `request_lock` ix — the legitimate adjudicator-side trigger for
/// `Open → Locked`. The `sooth_market_program` and `instruction_sysvar`
/// metas are required by the CPI plumbing on the adjudicator side.
pub fn build_request_lock_ix(harness: &Harness, pdas: &MarketPdas) -> Instruction {
    build_ix(
        ADJ_ID,
        sooth_adjudicator::accounts::RequestLock {
            adjudicator: pdas.adjudicator_pda,
            market: pdas.market,
            authority: harness.creator.pubkey(),
            sooth_market_program: MARKET_ID,
            instruction_sysvar: sysvar::instructions::ID,
        },
        sooth_adjudicator::instruction::RequestLock {},
    )
}

/// Build an `attest_outcome` ix — the legitimate adjudicator-side trigger
/// for `Locked → Settled`. `winning_outcome` ∈ {NO=0, YES=1, INVALID=2}.
pub fn build_attest_outcome_ix(
    harness: &Harness,
    pdas: &MarketPdas,
    winning_outcome: u8,
) -> Instruction {
    build_ix(
        ADJ_ID,
        sooth_adjudicator::accounts::AttestOutcome {
            adjudicator: pdas.adjudicator_pda,
            market: pdas.market,
            authority: harness.creator.pubkey(),
            sooth_market_program: MARKET_ID,
            instruction_sysvar: sysvar::instructions::ID,
        },
        sooth_adjudicator::instruction::AttestOutcome { winning_outcome },
    )
}

/// Anchor's pubkey-only `Accounts` struct (`accounts::*`) implements
/// `ToAccountMetas`; the args struct (`instruction::*`) implements
/// `InstructionData`. Together they fully specify a top-level Solana
/// `Instruction`. This wrapper keeps every test ix one line.
pub fn build_ix<A, D>(program_id: Pubkey, accounts: A, data: D) -> Instruction
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

/// Submit a tx with the given ixs, signed by `signer` (also the fee payer).
/// Panics on tx failure — these tests treat failures as bugs unless the
/// caller explicitly uses `try_send_ixs`.
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

/// Same as `send_ixs` but returns the result instead of panicking. Used by
/// the rejection tests where failure is the expected path.
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

/// Borsh-deserialize a `Market` PDA from the live cluster. Strips the
/// 8-byte Anchor discriminator before decoding.
pub fn fetch_market(svm: &LiteSVM, pda: Pubkey) -> sooth_market::state::Market {
    let acc = svm
        .get_account(&pda)
        .expect("market pda missing from cluster");
    decode_anchor(&acc.data)
}

pub fn fetch_amm_state(svm: &LiteSVM, pda: Pubkey) -> sooth_amm::state::AmmState {
    let acc = svm
        .get_account(&pda)
        .expect("amm_state pda missing from cluster");
    decode_anchor(&acc.data)
}

pub fn fetch_adjudicator(
    svm: &LiteSVM,
    pda: Pubkey,
) -> sooth_adjudicator::state::Adjudicator {
    let acc = svm
        .get_account(&pda)
        .expect("adjudicator pda missing from cluster");
    decode_anchor(&acc.data)
}

/// Strip the 8-byte Anchor discriminator and decode the rest with Borsh.
fn decode_anchor<T: anchor_lang::AccountDeserialize>(data: &[u8]) -> T {
    T::try_deserialize(&mut &data[..]).expect("anchor decode failed")
}

fn current_clock_ts(svm: &LiteSVM) -> i64 {
    let clock: Clock = svm.get_sysvar();
    clock.unix_timestamp
}

/// LiteSVM's `Account` is the regular `solana_sdk::account::Account`. Hand-
/// write a Mint account at the canonical address. Mirrors the bankrun
/// fixture's `writeMint` — same fixture-not-bypass rationale.
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

/// `Keypair` doesn't impl `Clone` in solana-sdk 1.18; round-trip through
/// the bytes representation. Used when a helper needs to pass the creator
/// to `send_ixs` while still mutably borrowing the SVM through `Harness`.
pub fn clone_keypair(kp: &Keypair) -> Keypair {
    Keypair::from_bytes(&kp.to_bytes()).expect("keypair round-trip")
}

/// Generate a deterministic 16-byte market id for a test. The byte pattern
/// is just `0..16` so the seed is reproducible across runs; tests that need
/// distinct markets pass a salt in `salt` to differentiate.
pub fn market_id(salt: u8) -> [u8; 16] {
    let mut id = [0u8; 16];
    for (i, b) in id.iter_mut().enumerate() {
        *b = i as u8 ^ salt;
    }
    id
}
