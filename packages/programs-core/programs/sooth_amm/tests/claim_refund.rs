mod common;

use common::*;

#[test]
fn pre_dismiss_fails() {
    let mut fixture = setup_market(0x81);
    let trader = setup_trader(&mut fixture);
    buy_yes(&mut fixture, &trader, 5 * one_share());

    let ix = claim_refund_ix(&fixture, &trader);
    let res = try_send_ixs(&mut fixture.svm, &trader.keypair, &[ix]);

    assert_anchor_error(
        res.expect_err("claim_refund before dismissal must fail"),
        "MarketNotDismissed",
    );
}

#[test]
fn happy_path() {
    let mut fixture = setup_market(0x82);
    let trader = setup_trader(&mut fixture);
    let locked_cost = buy_yes(&mut fixture, &trader, 5 * one_share());
    dismiss_market(&mut fixture);

    let user_before = fetch_token_amount(&fixture.svm, trader.usdc_ata);
    let vault_before = fetch_token_amount(&fixture.svm, fixture.pdas.vault);
    let ix = claim_refund_ix(&fixture, &trader);
    send_ixs(&mut fixture.svm, &trader.keypair, &[ix]);

    assert_eq!(
        fetch_token_amount(&fixture.svm, trader.usdc_ata),
        user_before + locked_cost
    );
    assert_eq!(
        fetch_token_amount(&fixture.svm, fixture.pdas.vault),
        vault_before - locked_cost
    );
    assert!(is_closed(&fixture.svm, &trader.position_pda));
}

#[test]
fn double_call_fails() {
    let mut fixture = setup_market(0x83);
    let trader = setup_trader(&mut fixture);
    buy_yes(&mut fixture, &trader, 5 * one_share());
    dismiss_market(&mut fixture);

    let ix = claim_refund_ix(&fixture, &trader);
    send_ixs(&mut fixture.svm, &trader.keypair, &[ix]);

    fixture.svm.expire_blockhash();
    let ix = claim_refund_ix(&fixture, &trader);
    let res = try_send_ixs(&mut fixture.svm, &trader.keypair, &[ix]);
    assert!(res.is_err(), "second claim_refund must fail after close");
}

#[test]
fn after_sell_and_dismiss() {
    let mut fixture = setup_market(0x84);
    let trader = setup_trader(&mut fixture);
    let buy_cost = buy_yes(&mut fixture, &trader, 10 * one_share());
    let sell = sell_yes(&mut fixture, &trader, 3 * one_share());
    let residual = buy_cost - sell.vault_outflow_usdc;
    let position = read_position(&fixture.svm, &trader.position_pda);
    assert_eq!(position.locked_cost_usdc, residual);

    dismiss_market(&mut fixture);
    let user_before = fetch_token_amount(&fixture.svm, trader.usdc_ata);
    let vault_before = fetch_token_amount(&fixture.svm, fixture.pdas.vault);
    let ix = claim_refund_ix(&fixture, &trader);
    send_ixs(&mut fixture.svm, &trader.keypair, &[ix]);

    assert_eq!(
        fetch_token_amount(&fixture.svm, trader.usdc_ata),
        user_before + residual
    );
    assert_eq!(
        fetch_token_amount(&fixture.svm, fixture.pdas.vault),
        vault_before - residual
    );
}

#[test]
fn direct_close_dismissed_position_rejected() {
    let mut fixture = setup_market(0x85);
    let trader = setup_trader(&mut fixture);
    buy_yes(&mut fixture, &trader, 5 * one_share());
    dismiss_market(&mut fixture);

    let ix = direct_close_ix(&fixture, &trader);
    let res = try_send_ixs(&mut fixture.svm, &trader.keypair, &[ix]);

    assert_anchor_error(
        res.expect_err("direct close_dismissed_position must fail"),
        "InvalidParentInstruction",
    );
    assert!(!is_closed(&fixture.svm, &trader.position_pda));
}
