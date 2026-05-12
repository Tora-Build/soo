mod common;

use common::*;

use solana_sdk::compute_budget::ComputeBudgetInstruction;
use sooth_amm::math::WAD_U;

#[test]
fn sell_emits_nonzero_fee() {
    let mut fixture = setup_market(0x91);
    let trader = setup_trader(&mut fixture);
    buy_yes(&mut fixture, &trader, 20 * one_share());

    let quote = quote_sell_yes(&fixture, &trader, 7 * one_share());
    assert!(quote.fee_usdc > 0, "test sell must produce nonzero fee");

    let fee_pool_before = fetch_token_amount(&fixture.svm, fixture.market_fee_pool);
    let lock_vault_before = fetch_token_amount(&fixture.svm, fixture.pdas.lock_vault);
    let vault_before = fetch_token_amount(&fixture.svm, fixture.pdas.vault);

    let actual = sell_yes(&mut fixture, &trader, 7 * one_share());
    assert_eq!(actual, quote);

    assert_eq!(
        fetch_token_amount(&fixture.svm, fixture.market_fee_pool),
        fee_pool_before + quote.fee_usdc
    );
    assert_eq!(
        fetch_token_amount(&fixture.svm, fixture.pdas.lock_vault),
        lock_vault_before + quote.net_proceeds_usdc
    );
    assert_eq!(
        fetch_token_amount(&fixture.svm, fixture.pdas.vault),
        vault_before - quote.vault_outflow_usdc
    );

    let lock_entry = read_lock_entry(&fixture.svm, &quote.lock_entry);
    assert_eq!(lock_entry.amount_usdc, quote.net_proceeds_usdc);
}

#[test]
fn buy_sell_round_trip_collects_fee_on_both_legs() {
    let mut fixture = setup_market(0x92);
    let trader = setup_trader(&mut fixture);
    let shares = 9 * one_share();

    let fee_pool_before = fetch_token_amount(&fixture.svm, fixture.market_fee_pool);
    let buy_quote = quote_buy_yes(&fixture, shares);
    buy_yes(&mut fixture, &trader, shares);

    fixture.svm.expire_blockhash();
    let sell_quote = quote_sell_yes(&fixture, &trader, shares);
    sell_yes(&mut fixture, &trader, shares);

    assert_eq!(
        fetch_token_amount(&fixture.svm, fixture.market_fee_pool) - fee_pool_before,
        buy_quote.fee_usdc + sell_quote.fee_usdc
    );
}

#[test]
fn sell_with_zero_fee_skips_fee_cpi() {
    let mut fixture = setup_market(0x93);
    let trader = setup_trader(&mut fixture);
    let tiny_shares: i128 = 3_000_000_000_000;

    buy_yes(&mut fixture, &trader, tiny_shares);
    fixture.svm.expire_blockhash();

    let quote = quote_sell_yes(&fixture, &trader, tiny_shares);
    assert!(quote.fee_wad > 0, "test sell must charge a WAD-level fee");
    assert_eq!(quote.fee_usdc, 0, "fee must floor below one base unit");
    assert_eq!(
        quote.net_proceeds_usdc, quote.gross_proceeds_usdc,
        "base-unit lock amount should equal gross when the fee floors to zero"
    );

    let fee_pool_before = fetch_token_amount(&fixture.svm, fixture.market_fee_pool);
    let lock_vault_before = fetch_token_amount(&fixture.svm, fixture.pdas.lock_vault);
    let actual = sell_yes(&mut fixture, &trader, tiny_shares);
    assert_eq!(actual, quote);

    assert_eq!(
        fetch_token_amount(&fixture.svm, fixture.market_fee_pool),
        fee_pool_before,
        "zero-base-unit fee must not transfer into market_fee_pool"
    );
    assert_eq!(
        fetch_token_amount(&fixture.svm, fixture.pdas.lock_vault),
        lock_vault_before + quote.net_proceeds_usdc
    );
}

#[test]
fn sell_fee_gate_rejects_direct_call() {
    let mut fixture = setup_market(0x94);
    let ix = transfer_fee_to_market_pool_ix(&fixture, 1);
    let res = try_send_ixs(&mut fixture.svm, &fixture.creator, &[ix]);

    assert_anchor_error(
        res.expect_err("direct transfer_fee_to_market_pool must fail"),
        "InvalidParentInstruction",
    );
}

#[test]
fn sell_fee_gate_rejects_wrong_amm_discriminator() {
    let mut fixture = setup_market(0x95);
    let trader = setup_trader(&mut fixture);

    let buy_ix = buy_yes_ix(&fixture, &trader, one_share(), 2 * WAD_U);
    let fee_ix = transfer_fee_to_market_pool_ix(&fixture, 1);
    let res = try_send_ixs(
        &mut fixture.svm,
        &trader.keypair,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(500_000),
            buy_ix,
            fee_ix,
        ],
    );

    assert_anchor_error(
        res.expect_err("trade_positions parent must not satisfy sell fee gate"),
        "InvalidParentInstruction",
    );
}
