mod common;

use common::*;

#[test]
fn buy_sets_locked_cost() {
    let mut fixture = setup_market(0x71);
    let trader = setup_trader(&mut fixture);

    let cost_usdc = buy_yes(&mut fixture, &trader, 5 * one_share());
    let position = read_position(&fixture.svm, &trader.position_pda);

    assert_eq!(position.locked_cost_usdc, cost_usdc);
}

#[test]
fn sell_decreases_locked_cost() {
    let mut fixture = setup_market(0x72);
    let trader = setup_trader(&mut fixture);

    let cost_usdc = buy_yes(&mut fixture, &trader, 10 * one_share());
    let vault_before = fetch_token_amount(&fixture.svm, fixture.pdas.vault);
    let sell = sell_yes(&mut fixture, &trader, 5 * one_share());
    let vault_after = fetch_token_amount(&fixture.svm, fixture.pdas.vault);
    let position = read_position(&fixture.svm, &trader.position_pda);

    assert_eq!(
        position.locked_cost_usdc,
        cost_usdc - sell.vault_outflow_usdc
    );
    assert_eq!(vault_after, vault_before - sell.vault_outflow_usdc);
}

#[test]
fn multi_buy_accumulates() {
    let mut fixture = setup_market(0x73);
    let trader = setup_trader(&mut fixture);

    let first = buy_yes(&mut fixture, &trader, 2 * one_share());
    fixture.svm.expire_blockhash();
    let second = buy_yes(&mut fixture, &trader, 3 * one_share());
    fixture.svm.expire_blockhash();
    let third = buy_yes(&mut fixture, &trader, 4 * one_share());

    let position = read_position(&fixture.svm, &trader.position_pda);
    assert_eq!(position.locked_cost_usdc, first + second + third);
}

#[test]
fn saturating_sub_floors_to_zero() {
    let mut fixture = setup_market(0x74);
    let trader = setup_trader(&mut fixture);
    let whale = setup_trader(&mut fixture);

    let locked_cost = buy_yes(&mut fixture, &trader, one_share());
    fixture.svm.expire_blockhash();
    buy_yes(&mut fixture, &whale, 500 * one_share());

    let sell = sell_yes(&mut fixture, &trader, one_share());
    let position = read_position(&fixture.svm, &trader.position_pda);

    assert!(
        sell.vault_outflow_usdc > locked_cost,
        "test setup must create price impact: proceeds={} locked={locked_cost}",
        sell.vault_outflow_usdc
    );
    assert_eq!(position.locked_cost_usdc, 0);
}
