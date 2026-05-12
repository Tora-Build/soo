# W5 dispatch — per-market `distribute_fees` + legacy global drain

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop after the
> acceptance gates pass; Claude reviews + pushes; do not push to
> origin from inside Codex.

W5 is small — one ix refactor + one new sibling ix on `sooth_launchpad`. The 4-way bps split math stays unchanged; only the source-of-funds shifts from singleton to per-market, and a one-shot legacy drain handles the migration. Estimated runtime: 12–20 minutes.

---

## Context (read first)

1. **`docs/spec/sooth_book.md`** §9.5 — the canonical W5 scope. **`DistributeFees` accounts struct adds `market` + `market_fee_pool`; drain source = `market_fee_pool.amount`; 4-way bps split unchanged.** Plus `distribute_fees_legacy` — one-shot, drains the global pool, replay-protected.
2. **`docs/spec/sooth_book.md`** §11 W5 row — acceptance: "Per-market crank works end-to-end; legacy drain works exactly once (idempotency tested); 4-way bps split numerically unchanged from current; replay protection on legacy ix".
3. **`packages/programs-core/programs/sooth_launchpad/src/instructions/distribute_fees.rs`** — current implementation. Read end-to-end. The 4-way split body (lines 146 onward in W2a-shipped code) is the math that stays.
4. **`packages/programs-core/programs/sooth_launchpad/src/state/protocol_config.rs`** — `ProtocolConfig` shape. The 4-way `*_share_bps` fields are unchanged.
5. **W2a's `init_market_fee_pool.rs`** — the helper that creates per-market pools. Already on main.
6. **W2a + W2b changes**: AMM buys + sells now route their fees to per-market `market_fee_pool` accounts. So per-market pools accumulate fees from the moment a market trades. The legacy `fee_pool_vault` only holds whatever was accrued **before** the W2a/W2b cutover landed on devnet/mainnet.

---

## Scope

### A. `distribute_fees` redesigned per-market

Modify `programs/sooth_launchpad/src/instructions/distribute_fees.rs`:

#### A.1 Accounts struct

Replace `fee_pool_vault` (the global singleton USDC ATA) with two new fields:

```rust
pub struct DistributeFees<'info> {
    /// The market whose per-market fee pool gets drained.
    /// Bound by has_one or seed check against `market_fee_pool`.
    pub market: Account<'info, Market>,  // from sooth_market

    /// The per-market USDC ATA at PDA [b"market_fee_pool", market.market_id].
    /// Owner: fee_pool_authority singleton PDA.
    #[account(
        mut,
        seeds = [b"market_fee_pool", market.market_id.as_ref()],
        bump,
        seeds::program = sooth_launchpad::ID,
        // mint validated against BASE_TOKEN_MINT (the existing init constraint)
    )]
    pub market_fee_pool: Account<'info, TokenAccount>,

    // ... existing recipients (b_base, lp_yield, adjudicator, treasury ATAs)
    // ... fee_pool_authority signer PDA (unchanged seeds)
    // ... protocol_config singleton, token_program, system_program
}
```

Keep the existing 4-way recipient ATAs. Authority signing seeds stay `[b"fee_pool_authority"]`.

#### A.2 Body

The split math is byte-identical to the current implementation. Only one thing changes: `total = ctx.accounts.market_fee_pool.amount` instead of `ctx.accounts.fee_pool_vault.amount`. And the four transfers source from `market_fee_pool` not `fee_pool_vault`.

Add a `MarketFeesDistributed` event (or extend the existing one) carrying `market.market_id` for indexer consumption.

#### A.3 Permissionless cranker

`cranker: Signer<'info>` stays (anyone can crank any market independently). Pay tx fee.

#### A.4 Zero-balance behavior

The existing `require!(total > 0, NothingToDistribute)` stays. Per-market means: trying to crank an empty market is a no-op error; legitimate.

### B. `distribute_fees_legacy` — one-shot global drain

New file `programs/sooth_launchpad/src/instructions/distribute_fees_legacy.rs`. Same body shape as `distribute_fees` but drains the global `fee_pool_vault` and is **single-shot via a replay-protection flag**.

#### B.1 Replay protection

Add a new singleton account `LegacyFeeDrainMarker` at seed `[b"legacy_fee_drain_marker"]`:

```rust
#[account]
pub struct LegacyFeeDrainMarker {
    pub drained_at: i64,           // unix seconds; 0 == never drained
    pub bump: u8,
}
impl LegacyFeeDrainMarker {
    pub const SPACE: usize = 8 + 8 + 1;
}
```

The `distribute_fees_legacy` ix:

```rust
pub struct DistributeFeesLegacy<'info> {
    #[account(
        init_if_needed,
        payer = cranker,
        space = LegacyFeeDrainMarker::SPACE,
        seeds = [b"legacy_fee_drain_marker"],
        bump,
    )]
    pub legacy_marker: Account<'info, LegacyFeeDrainMarker>,

    /// The global fee_pool_vault — only field NOT changed from the pre-W2a struct.
    #[account(
        mut,
        // existing seeds/owner constraints
    )]
    pub fee_pool_vault: Account<'info, TokenAccount>,

    // ... same 4-way recipients
    // ... fee_pool_authority signer
    // ... cranker signer
    // ... protocol_config, token_program, system_program
}

pub fn handler(ctx: Context<DistributeFeesLegacy>) -> Result<()> {
    let marker = &mut ctx.accounts.legacy_marker;
    require!(marker.drained_at == 0, SoothLaunchpadError::LegacyDrainAlreadyExecuted);

    let total: u64 = ctx.accounts.fee_pool_vault.amount;
    // No "require nonzero" — a zero-balance drain is still a legitimate one-shot
    // that flips the marker. Idempotency depends on the marker, not the balance.

    // Same 4-way split body as distribute_fees (factor into a shared helper if
    // the duplication feels right; otherwise inline). Use the same
    // floor-div + remainder-to-protocol semantics.

    marker.drained_at = Clock::get()?.unix_timestamp;
    Ok(())
}
```

Add `SoothLaunchpadError::LegacyDrainAlreadyExecuted`.

**Note: do NOT delete the legacy `fee_pool_vault` Anchor account or its `initialize_fee_pool` ix.** Per spec §3.4 (sooth_book.md), the legacy pool stays allocated post-drain (it just permanently holds 0). Removing it would break account-derivation symmetry for any client that still references the historical PDA. Mark `initialize_fee_pool` as deprecated in a doc comment.

### C. Wire into `lib.rs`

```rust
pub use instructions::distribute_fees::*;
pub use instructions::distribute_fees_legacy::*;
```

Add to `#[program]`:

```rust
pub fn distribute_fees(ctx: Context<DistributeFees>) -> Result<()> { ... }
pub fn distribute_fees_legacy(ctx: Context<DistributeFeesLegacy>) -> Result<()> { ... }
```

### D. `sooth-protocol-types` discriminator

Add `DISTRIBUTE_FEES_LEGACY_DISCRIMINATOR` via `sha256("global:distribute_fees_legacy")[..8]`. The existing `distribute_fees` discriminator stays (the ix name is unchanged; only the accounts struct shape changed).

### E. Tests

`programs/sooth_launchpad/tests/distribute_fees_per_market.rs` (or extend an existing test file):

1. **`distribute_fees_drains_market_fee_pool`** — fund a `market_fee_pool` with 10,000 USDC (use a fixture helper or direct mint to the pool). Crank `distribute_fees(market=A)`. Assert the 4-way split lands at the recipients with the expected bps, and `market_fee_pool` balance is 0.
2. **`distribute_fees_bps_split_unchanged`** — for a known total (say 10_000 base units) and known ProtocolConfig bps, assert exact recipient amounts match the pre-W5 behavior (lift the assertion values from any existing test fixture so the numerical-parity rule is enforced).
3. **`distribute_fees_two_markets_independent`** — fund pools for market A and market B with different totals. Crank A, assert only A's pool drains. Crank B, assert only B's pool drains. No cross-contamination.
4. **`distribute_fees_zero_balance_rejects`** — crank an empty market pool → `NothingToDistribute`.
5. **`distribute_fees_legacy_drains_global_pool_once`** — fund the global `fee_pool_vault`, crank legacy, assert recipients credited, marker flipped, balance 0.
6. **`distribute_fees_legacy_rejects_replay`** — call legacy a second time → `LegacyDrainAlreadyExecuted`. Marker is the gate; balance state irrelevant.
7. **`distribute_fees_legacy_idempotent_on_zero_balance`** — even with 0 balance in `fee_pool_vault`, the first legacy call succeeds and flips the marker; second call still rejects.

### F. Update existing tests

W2a updated some launchpad tests for the new `market_fee_pool`. Any `distribute_fees` test that still passes `fee_pool_vault` as the source needs the field renamed to `market_fee_pool` + the added `market` field. Existing assertion logic on the 4-way split stays.

---

## Acceptance gates

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test -p sooth_launchpad
NO_DNA=1 cargo test -p sooth_amm
NO_DNA=1 cargo test -p sooth_market
NO_DNA=1 anchor build
```

The numerical-parity test (B-2 above) is the load-bearing assertion — 4-way bps split must produce byte-identical recipient amounts pre/post-W5.

---

## Out of scope

- `MarketFeePool` lifecycle (lazy init) — W2a already shipped `init_market_fee_pool`.
- `mint_complete_set_for_orderbook` etc. — W6.
- SDK / demo updates (per-market `distributeFees` builder) — W7.
- E2E test fixes — W8.
- Devnet redeploy.

---

## Operational rules

- Branch: `feat/sooth_book-w5-distribute-fees` off current `main`.
- Suggested commit split:
  1. `feat(sooth-protocol-types): add distribute_fees_legacy discriminator`
  2. `feat(sooth_launchpad): redesign distribute_fees per-market`
  3. `feat(sooth_launchpad): distribute_fees_legacy ix + replay protection`
  4. `test(sooth_launchpad): per-market crank + legacy drain idempotency`
- **Do NOT push, tag, amend, use `--no-verify`.** `NO_DNA=1` prefix.
- Stop and ask if:
  - The 4-way bps split has any pre-W5 behavior that conflicts with a "numerically unchanged" assertion (an off-by-one rounding choice that needs preservation).
  - The legacy ix should also distribute to `market_fee_pool` of some "default market" instead of the same 4-way recipients — spec says NO (recipients unchanged), but flag if the existing fixture suggests otherwise.

## When done

One-line per-gate pass/fail summary. Stop.
