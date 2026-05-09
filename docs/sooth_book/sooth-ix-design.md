# SoothBook — Sooth-specific instruction surface (W5-W6 design notes)

> Status: design draft, 2026-05-09. Codex is concurrently doing W3
> (sportsbook strip-down) + W4 (price ladder translation). This doc
> specifies the four new ix that get layered on top of the
> stripped/translated codebase, plus the cross-program coordination
> contracts. Once W3+W4 land, codex implements per these specs.

## Overview

After W3+W4, sooth_book has Monaco's order-lifecycle ix surface
adapted to binary-outcome / probability-WAD shape. W5-W6 adds the
four ix that wire it into the rest of the Sooth protocol:

1. **`mint_into_book`** — mint complete-set USDC → YES + NO directly
   into resting limit orders. Eliminates wallet round-trip for makers.
2. **`settle_resting_orders`** — adjudicator-driven cleanup after
   market settlement. Resting YES orders for the winning side redeem
   1:1 USDC; losing side returns 0; INVALID returns half-pay.
3. **`fee_route_hook`** — every fill increments sooth_book's
   `fee_b_base_wad` accumulator (mirrors `sooth_amm`). The launchpad's
   `distribute_fees` ix already routes the 4-way bps split (b-base,
   lp-yield, adjudicator, treasury); this hook just feeds it.
4. **Adjudicator-CPI auth gate on `settle_resting_orders`** — parent-ix
   program-id == `market.adjudicator` (the canonical
   `sooth_adjudicator` program). Same pattern as
   `sooth_market::lock_for_resolution` and `sooth_amm::trade_positions`'s
   graduation flip.

## 1. `mint_into_book` instruction

### Intent

A maker wants to provide liquidity at price `p` for `n` shares without
first holding the YES/NO tokens. Without this ix, the flow is:

```
1. user.mint_complete_set(n)  → wallet +n YES, +n NO, -n·USDC
2. user.create_order_request(YES, p, n)  → places YES sell order
3. user.create_order_request(NO, 1-p, n)  → places NO sell order
```

Three transactions, two of which sit YES/NO in user wallet only to
immediately escrow into the orderbook. `mint_into_book` collapses
this to one tx that:

- Pulls `n·USDC` from user
- Mints `n·YES` and `n·NO` directly into `market_escrow` (sooth_book's
  escrow vault)
- Creates two `Order` PDAs at `(market, p, YES)` and `(market, 1-p, NO)`,
  each with stake_unmatched = n
- Pushes both into `market_liquidities` (the price ladder)

### Account list

```rust
#[derive(Accounts)]
#[instruction(price_yes: u128, stake: u64, distinct_seed_yes: u64, distinct_seed_no: u64)]
pub struct MintIntoBook<'info> {
    pub user: Signer<'info>,

    // Source funds
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,
    pub usdc_mint: Box<Account<'info, Mint>>,

    // sooth_market state — for mint_complete_set CPI
    #[account(constraint = market_pda.lifecycle == MarketLifecycle::Open)]
    pub market_pda: Box<Account<'info, sooth_market::state::Market>>,
    pub yes_mint: Box<Account<'info, Mint>>,  // sooth_market YES mint
    pub no_mint: Box<Account<'info, Mint>>,   // sooth_market NO mint
    pub vault_authority: AccountInfo<'info>,  // sooth_market vault PDA

    // sooth_book market — must reference the same `market_pda` via
    // market.event_account == market_pda OR a dedicated link account
    // (see "Cross-program market binding" below)
    #[account(mut)]
    pub book_market: Box<Account<'info, sooth_book::state::Market>>,

    // sooth_book escrow — receives both YES and NO mints
    #[account(mut, token::authority = book_market_escrow_authority)]
    pub market_escrow_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = book_market_escrow_authority)]
    pub market_escrow_no: Box<Account<'info, TokenAccount>>,
    pub book_market_escrow_authority: AccountInfo<'info>,  // PDA, [b"escrow", book_market.key()]

    // sooth_book order PDAs (init)
    #[account(init, payer = user, space = Order::SIZE,
              seeds = [b"order", book_market.key().as_ref(), &distinct_seed_yes.to_le_bytes()],
              bump)]
    pub order_yes: Box<Account<'info, Order>>,

    #[account(init, payer = user, space = Order::SIZE,
              seeds = [b"order", book_market.key().as_ref(), &distinct_seed_no.to_le_bytes()],
              bump)]
    pub order_no: Box<Account<'info, Order>>,

    // Liquidities (mut for ladder insertion)
    #[account(mut)]
    pub market_liquidities: Box<Account<'info, MarketLiquidities>>,

    // Position tracking
    #[account(init_if_needed, payer = user, space = MarketPosition::SIZE,
              seeds = [b"position", book_market.key().as_ref(), user.key().as_ref()],
              bump)]
    pub market_position: Box<Account<'info, MarketPosition>>,

    // CPIs
    pub sooth_market_program: Program<'info, SoothMarket>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
```

### Handler logic

```rust
pub fn handler(
    ctx: Context<MintIntoBook>,
    price_yes: u128,    // probability·WAD, 0 < price_yes < 1·WAD
    stake: u64,         // shares (= USDC, since 1 share = 1 USDC at parity)
    distinct_seed_yes: u64,
    distinct_seed_no: u64,
) -> Result<()> {
    require!(stake > 0, SoothBookError::ZeroStake);
    require!(
        price_yes > 0 && price_yes < WAD,
        SoothBookError::PriceOutOfRange
    );

    // 1. CPI: sooth_market::mint_complete_set(stake) — but mint INTO
    //    sooth_book's escrow vaults, not the user's wallet
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.sooth_market_program.to_account_info(),
        sooth_market::cpi::accounts::MintCompleteSet {
            // mint_to_yes = book_market.escrow_yes_ata
            // mint_to_no = book_market.escrow_no_ata
            // funded_by = user.usdc_ata
            ...
        },
        signer_seeds,  // sooth_book's market authority signs for the deposit
    );
    sooth_market::cpi::mint_complete_set(cpi_ctx, stake)?;

    // 2. Initialize Order PDAs (already init'd by Anchor constraint;
    //    just populate fields)
    let order_yes = &mut ctx.accounts.order_yes;
    *order_yes = Order::new(
        market: ctx.accounts.book_market.key(),
        outcome: OUTCOME_YES,
        price: price_yes,
        stake_unmatched: stake,
        purchaser: ctx.accounts.user.key(),
        for_outcome: false,  // selling YES = providing liquidity for buyers
    );
    let order_no = &mut ctx.accounts.order_no;
    *order_no = Order::new(
        market: ctx.accounts.book_market.key(),
        outcome: OUTCOME_NO,
        price: WAD - price_yes,  // price symmetry: 1 - p
        stake_unmatched: stake,
        purchaser: ctx.accounts.user.key(),
        for_outcome: false,
    );

    // 3. Push into ladder
    ctx.accounts.market_liquidities.add_liquidity_against(
        OUTCOME_YES, price_yes, stake
    )?;
    ctx.accounts.market_liquidities.add_liquidity_against(
        OUTCOME_NO, WAD - price_yes, stake
    )?;

    // 4. Update position
    let position = &mut ctx.accounts.market_position;
    position.unmatched_stake_yes = position.unmatched_stake_yes.checked_add(stake).unwrap();
    position.unmatched_stake_no = position.unmatched_stake_no.checked_add(stake).unwrap();

    emit!(LiquidityMintedIntoBook {
        market: ctx.accounts.book_market.key(),
        user: ctx.accounts.user.key(),
        stake,
        price_yes,
    });

    Ok(())
}
```

### Open design questions for codex+claude

- **Cross-program market binding:** sooth_book's Market and sooth_market's Market are different PDAs (different programs). For `mint_into_book` to work, the book Market needs to know which sooth_market Market it serves. Two options:
  - (a) Add `pub sooth_market_pda: Pubkey` field to sooth_book's Market state, set at `create_market` time, validated via constraint
  - (b) Derive book Market PDA seeds to include sooth_market Market pubkey: `[b"market", sooth_market_market.key()]`
  - **Recommend (b)** — derivation makes the binding tamper-proof at the PDA level
- **Escrow authority:** sooth_book has `market_escrow` (Monaco-style) but Sooth needs YES + NO escrow vaults, not USDC. The escrow PDA stays the same authority but now manages two SPL token accounts (YES + NO mints from sooth_market).
- **Pre-mint vs post-mint state:** does the user's complete-set get minted to user's wallet first, then transferred to escrow (two-step), or directly to escrow (one-step CPI with sooth_market)? **Recommend one-step** — sooth_market::mint_complete_set already takes a destination ATA; we just point both at sooth_book's escrows.

## 2. `settle_resting_orders` instruction

### Intent

After `sooth_adjudicator` settles the market (sets winning_outcome on
sooth_market.Market), all resting orders on sooth_book need cleanup:

- Winning-side resting orders: redeem 1:1 USDC from escrow (book burns
  the YES/NO held in escrow, returns USDC equal to stake_unmatched)
- Losing-side resting orders: return 0 (the YES/NO held in escrow has
  no claim; tokens are burned)
- INVALID outcome: half-pay each side (return stake/2 USDC per resting
  order, mirroring `sooth_market::redeem`'s INVALID branch)

### Auth gate

Parent-ix introspection on `Instructions` sysvar:

```rust
let parent_ix_program_id = get_parent_ix_program_id(&instructions_sysvar)?;
require!(
    parent_ix_program_id == market.adjudicator,
    SoothBookError::Unauthorized
);
```

Same pattern as `sooth_market::lock_for_resolution` / `settle`.

### Account list

```rust
#[derive(Accounts)]
pub struct SettleRestingOrders<'info> {
    // Adjudicator authority (parent-ix gate verifies program-id)
    /// CHECK: validated via parent-ix program-id check
    pub adjudicator: AccountInfo<'info>,

    // sooth_market state — must be Settled, with winning_outcome set
    #[account(constraint = sooth_market_pda.lifecycle == Settled)]
    pub sooth_market_pda: Box<Account<'info, sooth_market::state::Market>>,

    // sooth_book market
    #[account(mut, constraint = book_market.sooth_market_pda == sooth_market_pda.key())]
    pub book_market: Box<Account<'info, Market>>,

    // The order being settled (one ix per order — caller iterates)
    #[account(mut, close = order_purchaser)]  // close to refund rent
    pub order: Box<Account<'info, Order>>,
    pub order_purchaser: SystemAccount<'info>,  // gets the rent refund

    // Escrow holdings (book's YES/NO ATAs)
    #[account(mut)]
    pub market_escrow_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub market_escrow_no: Box<Account<'info, TokenAccount>>,
    pub market_escrow_authority: AccountInfo<'info>,  // PDA signer for burn + transfer

    // sooth_market for the redeem CPI (winner gets 1:1 USDC from sooth_market.vault)
    pub sooth_market_program: Program<'info, SoothMarket>,
    pub yes_mint: Box<Account<'info, Mint>>,
    pub no_mint: Box<Account<'info, Mint>>,
    pub sooth_market_vault: Box<Account<'info, TokenAccount>>,
    pub sooth_market_vault_authority: AccountInfo<'info>,

    // Purchaser's USDC ATA (gets the payout)
    #[account(mut, token::authority = order_purchaser)]
    pub purchaser_usdc_ata: Box<Account<'info, TokenAccount>>,

    // Sysvar for parent-ix introspection
    /// CHECK: read-only sysvar
    #[account(address = solana_program::sysvar::instructions::id())]
    pub instructions_sysvar: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
```

### Handler logic

```rust
pub fn handler(ctx: Context<SettleRestingOrders>) -> Result<()> {
    // Parent-ix gate
    require!(
        get_parent_ix_program_id(&ctx.accounts.instructions_sysvar)?
            == ctx.accounts.sooth_market_pda.adjudicator,
        SoothBookError::Unauthorized
    );

    let order = &ctx.accounts.order;
    let stake_unmatched = order.stake_unmatched;
    let outcome = order.outcome;
    let winning = ctx.accounts.sooth_market_pda.winning_outcome;

    let payout: u64 = match (winning, outcome) {
        (OUTCOME_YES, OUTCOME_YES) => stake_unmatched,
        (OUTCOME_NO, OUTCOME_NO) => stake_unmatched,
        (OUTCOME_INVALID, _) => stake_unmatched / 2,
        _ => 0,
    };

    // CPI sooth_market::redeem to convert escrow's YES/NO tokens to USDC
    // (the same flow user's wallet would do post-settlement)
    if payout > 0 {
        // Burn the escrow's YES/NO tokens, transfer USDC from sooth_market.vault
        ...
    }

    // Order is closed by Anchor `close` constraint, rent refunds to purchaser

    emit!(RestingOrderSettled {
        order: order.key(),
        purchaser: order.purchaser,
        outcome,
        winning,
        payout,
    });

    Ok(())
}
```

## 3. `fee_route_hook` (helper, not a separate ix)

Not a standalone ix — it's a function called from `match_orders` /
`process_order_match_*` whenever a fill happens. Mirrors
`sooth_amm::trade_positions`'s fee_b_base_wad increment.

```rust
fn record_fee(
    market_state: &mut Market,
    fill_value_wad: u128,
    fee_bps: u16,
) -> Result<()> {
    let fee_wad = fill_value_wad
        .checked_mul(fee_bps as u128)
        .map(|v| v / 10_000)
        .ok_or(SoothBookError::MathOverflow)?;
    market_state.fee_b_base_wad = market_state
        .fee_b_base_wad
        .checked_add(fee_wad)
        .ok_or(SoothBookError::MathOverflow)?;
    Ok(())
}
```

The launchpad's existing `distribute_fees` ix doesn't need changes
— it already routes from `fee_pool_vault` (a singleton sooth_launchpad
PDA), which is fed by both `sooth_amm::trade_positions` and now
`sooth_book::match_orders` via direct SPL transfers.

## 4. Cross-program coordination contracts

| From                                           | To                                  | Mechanism                                                                |
| ---------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `sooth_book::mint_into_book`                   | `sooth_market::mint_complete_set`   | direct CPI with `book_market_escrow_authority` as destination            |
| `sooth_adjudicator::settle` (or downstream)    | `sooth_book::settle_resting_orders` | parent-ix introspection on Instructions sysvar; one ix per resting order |
| `sooth_book::match_orders` (when fill happens) | per-trade fee transfer              | direct SPL transfer to `fee_pool_vault` (sooth_launchpad PDA)            |
| sooth_book Market binding                      | sooth_market Market                 | PDA seed: book_market = `[b"market", sooth_market_market.key()]`         |

## Implementation order

1. **W4 lands first** (price ladder is u128 probability·WAD) — `mint_into_book`'s `price_yes` arg uses this type
2. **W3 lands** (sportsbook ix removed) — settled-order cleanup is simpler without n-way / cross-matching
3. **`mint_into_book`** — depends on sooth_market::mint_complete_set CPI (which exists)
4. **`settle_resting_orders`** — depends on sooth_market::redeem CPI (which exists)
5. **`fee_route_hook`** — internal helper, called from existing `match_orders` paths
6. **Cross-program market binding** — possibly needs a sooth_book::Market field added during W3 work

## Open questions for the user (Daniel)

- **Maker rebates / negative fees:** sooth_amm has no maker/taker distinction (single fee_bps applies). sooth_book's matching engine can distinguish — should we set maker_fee_bps < taker_fee_bps to incentivize liquidity provision? Default: same fee_bps for both. Decision can be deferred to W6 or post-launch.
- **Settlement crank pricing:** `settle_resting_orders` is called per-order. For a market with 1000 resting orders, that's 1000 ix's. Who pays the rent-refund-paying-CU? Default: each order's purchaser pays via the rent refund (rent comes back to them on close). If purchaser doesn't have SOL for the tx, the order can't be settled — they're locked. Mitigation: settlement crank operator pays, takes refund from a portion of the payout. Decision can be deferred.
- **Permissionless settlement vs gated:** should `settle_resting_orders` be callable by anyone (with parent-ix gate on adjudicator)? Default: YES (permissionless cleanup), gate is just to ensure adjudicator has actually settled.

## Cross-references

- W3+W4 implementation: `feature/sooth_book-monaco-fork` (in flight)
- Source readings: `monaco-investigation-week-01.md`
- AMM reference patterns: `programs/sooth_amm/src/instructions/trade_positions.rs` (fee accumulator), `programs/sooth_market/src/instructions/redeem.rs` (parent-ix gate), `programs/sooth_amm/src/instructions/dismiss_market.rs` (creator-only auth)
