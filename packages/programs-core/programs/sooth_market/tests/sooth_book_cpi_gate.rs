use anchor_lang::error::Error;
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::sysvar::instructions::{
    construct_instructions_data, store_current_index, BorrowedAccountMeta, BorrowedInstruction,
};

use sooth_market::error::SoothMarketError;
use sooth_market::instruction_introspection::{
    require_sooth_book_cpi_parent_from_data, SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
    SOOTH_BOOK_BUY_YES_DISCRIMINATOR, SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR,
    SOOTH_BOOK_CANCEL_DISCRIMINATOR,
};
use sooth_market::instructions::orderbook_common::require_before_deadline_at;
use sooth_market::state::{Market, MarketLifecycle};
use sooth_market::{SOOTH_AMM_PROGRAM_ID, SOOTH_BOOK_PROGRAM_ID};
use sooth_protocol_types::{
    SOOTH_LAUNCHPAD_INIT_MARKET_FEE_POOL_DISCRIMINATOR,
    SOOTH_MARKET_CREDIT_SHARES_FOR_ORDER_DISCRIMINATOR,
    SOOTH_MARKET_DEBIT_SHARES_FOR_ORDER_BEFORE_DEADLINE_DISCRIMINATOR,
    SOOTH_MARKET_DEPOSIT_FOR_ORDER_DISCRIMINATOR, SOOTH_MARKET_FILL_ORDER_DISCRIMINATOR,
    SOOTH_MARKET_WITHDRAW_FOR_ORDER_DISCRIMINATOR,
};

#[track_caller]
fn assert_invalid_parent(res: Result<(), SoothMarketError>, ctx: &str) {
    match res {
        Err(SoothMarketError::InvalidParentInstruction) => {}
        other => panic!("{ctx}: expected InvalidParentInstruction, got {other:?}"),
    }
}

fn anchor_disc(name: &str) -> [u8; 8] {
    use anchor_lang::solana_program::hash::hash;
    let preimage = format!("global:{name}");
    let h = hash(preimage.as_bytes()).to_bytes();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

fn build_sysvar_data(ixs: &[Instruction], current_index: u16) -> Vec<u8> {
    let borrowed: Vec<BorrowedInstruction> = ixs
        .iter()
        .map(|ix| BorrowedInstruction {
            program_id: &ix.program_id,
            accounts: ix
                .accounts
                .iter()
                .map(|m| BorrowedAccountMeta {
                    pubkey: &m.pubkey,
                    is_signer: m.is_signer,
                    is_writable: m.is_writable,
                })
                .collect(),
            data: &ix.data,
        })
        .collect();
    let mut data = construct_instructions_data(&borrowed);
    store_current_index(&mut data, current_index);
    data
}

fn make_ix(program_id: Pubkey, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![AccountMeta::new(Pubkey::new_unique(), true)],
        data,
    }
}

fn filler_allowlist(name: &str) -> Vec<[u8; 8]> {
    match name {
        "fill_order" | "deposit_for_order" | "debit_shares_for_order_before_deadline" => {
            vec![
                SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
                SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
            ]
        }
        "withdraw_for_order" => vec![
            SOOTH_BOOK_CANCEL_DISCRIMINATOR,
            SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR,
        ],
        "credit_shares_for_order" => vec![
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
            SOOTH_BOOK_CANCEL_DISCRIMINATOR,
            SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR,
        ],
        _ => unreachable!("unknown filler"),
    }
}

#[test]
fn sooth_book_cpi_gate_discriminators_match_anchor_hashes() {
    assert_eq!(
        SOOTH_MARKET_FILL_ORDER_DISCRIMINATOR,
        anchor_disc("fill_order")
    );
    assert_eq!(
        SOOTH_MARKET_DEPOSIT_FOR_ORDER_DISCRIMINATOR,
        anchor_disc("deposit_for_order")
    );
    assert_eq!(
        SOOTH_MARKET_WITHDRAW_FOR_ORDER_DISCRIMINATOR,
        anchor_disc("withdraw_for_order")
    );
    assert_eq!(
        SOOTH_MARKET_CREDIT_SHARES_FOR_ORDER_DISCRIMINATOR,
        anchor_disc("credit_shares_for_order")
    );
    assert_eq!(
        SOOTH_MARKET_DEBIT_SHARES_FOR_ORDER_BEFORE_DEADLINE_DISCRIMINATOR,
        anchor_disc("debit_shares_for_order_before_deadline")
    );
    assert_eq!(
        SOOTH_LAUNCHPAD_INIT_MARKET_FEE_POOL_DISCRIMINATOR,
        anchor_disc("init_market_fee_pool")
    );
}

#[test]
fn sooth_book_cpi_gate_accepts_allowed_current_index_parent() {
    let parent = make_ix(
        SOOTH_BOOK_PROGRAM_ID,
        SOOTH_BOOK_BUY_YES_DISCRIMINATOR.to_vec(),
    );
    let data = build_sysvar_data(&[parent], 0);
    let res = require_sooth_book_cpi_parent_from_data(
        &data,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
        ],
    );
    assert!(res.is_ok(), "buy_yes parent must be accepted: {res:?}");
}

#[test]
fn sooth_book_cpi_gate_rejects_direct_call_for_all_filler_ixs() {
    let fillers = [
        ("fill_order", SOOTH_MARKET_FILL_ORDER_DISCRIMINATOR.to_vec()),
        (
            "deposit_for_order",
            SOOTH_MARKET_DEPOSIT_FOR_ORDER_DISCRIMINATOR.to_vec(),
        ),
        (
            "withdraw_for_order",
            SOOTH_MARKET_WITHDRAW_FOR_ORDER_DISCRIMINATOR.to_vec(),
        ),
        (
            "credit_shares_for_order",
            SOOTH_MARKET_CREDIT_SHARES_FOR_ORDER_DISCRIMINATOR.to_vec(),
        ),
        (
            "debit_shares_for_order_before_deadline",
            SOOTH_MARKET_DEBIT_SHARES_FOR_ORDER_BEFORE_DEADLINE_DISCRIMINATOR.to_vec(),
        ),
    ];

    for (name, disc) in fillers {
        let direct = make_ix(sooth_market::ID, disc);
        let data = build_sysvar_data(&[direct], 0);
        let allow = filler_allowlist(name);
        let res = require_sooth_book_cpi_parent_from_data(&data, &allow);
        assert_invalid_parent(res, name);
    }
}

#[test]
fn sooth_book_cpi_gate_rejects_wrong_program_parent() {
    let wrong_program_parent = make_ix(
        SOOTH_AMM_PROGRAM_ID,
        SOOTH_BOOK_BUY_YES_DISCRIMINATOR.to_vec(),
    );
    let data = build_sysvar_data(&[wrong_program_parent], 0);
    let res = require_sooth_book_cpi_parent_from_data(
        &data,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
        ],
    );
    assert_invalid_parent(res, "sooth_amm parent must not satisfy sooth_book gate");
}

#[test]
fn sooth_book_cpi_gate_rejects_wrong_discriminator_from_sooth_book_id() {
    let impersonating_fixture = make_ix(SOOTH_BOOK_PROGRAM_ID, [0xAA; 8].to_vec());
    let data = build_sysvar_data(&[impersonating_fixture], 0);
    let res = require_sooth_book_cpi_parent_from_data(
        &data,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
        ],
    );
    assert_invalid_parent(res, "sooth_book id with wrong discriminator must reject");
}

#[test]
fn sooth_book_cpi_gate_rejects_scan_bypass_attempt() {
    let earlier_legitimate_book_ix = make_ix(
        SOOTH_BOOK_PROGRAM_ID,
        SOOTH_BOOK_BUY_YES_DISCRIMINATOR.to_vec(),
    );
    let later_direct_filler_ix = make_ix(
        sooth_market::ID,
        SOOTH_MARKET_FILL_ORDER_DISCRIMINATOR.to_vec(),
    );
    let data = build_sysvar_data(&[earlier_legitimate_book_ix, later_direct_filler_ix], 1);
    let res = require_sooth_book_cpi_parent_from_data(
        &data,
        &[
            SOOTH_BOOK_BUY_YES_DISCRIMINATOR,
            SOOTH_BOOK_BUY_NO_DISCRIMINATOR,
        ],
    );
    assert_invalid_parent(
        res,
        "earlier sooth_book ix must not satisfy current-index-only gate",
    );
}

#[test]
fn sooth_book_cpi_gate_deadline_guard_rejects_deadline_plus_one() {
    let market = Market {
        market_id: [7; 16],
        creator: Pubkey::new_unique(),
        adjudicator: Pubkey::new_unique(),
        question_hash: [9; 32],
        yes_mint: Pubkey::new_unique(),
        no_mint: Pubkey::new_unique(),
        vault: Pubkey::new_unique(),
        lock_vault: Pubkey::new_unique(),
        start_time: 100,
        deadline: 200,
        lifecycle: MarketLifecycle::Open,
        winning_outcome: 0,
        bump: 1,
        vault_authority_bump: 2,
        lock_authority_bump: 3,
        yes_mint_bump: 4,
        no_mint_bump: 5,
    };

    match require_before_deadline_at(&market, 201) {
        Err(Error::AnchorError(err)) => assert_eq!(err.error_name, "TradingClosed"),
        other => panic!("expected TradingClosed at deadline+1, got {other:?}"),
    }
}
