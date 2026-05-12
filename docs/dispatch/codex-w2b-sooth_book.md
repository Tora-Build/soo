# W2b dispatch — sell-path fee port

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop after the
> acceptance gates pass; Claude reviews + pushes; do not push to
> origin from inside Codex.

W2b is materially smaller than W2a — one new helper ix on `sooth_market`, one body edit on `sooth_amm::sell_positions`, one new discriminator, and a fee round-trip test. Estimated runtime: 10–15 minutes.

---

## Context (read first)

1. **`docs/spec/sooth_book.md`** §9.4 "Sell-path fee wiring (separate W2 sub-task)" — the canonical W2b scope. **The fee-transfer helper MUST live in `sooth_market`** because only it can sign for `vault_authority` (the market USDC vault's PDA authority).
2. **`packages/programs-core/programs/sooth_amm/src/instructions/sell_positions.rs`** — read end-to-end. Currently has zero fee logic. Note the existing CPI into `sooth_market::transfer_to_lock` at `:298` — that's the pattern to mirror.
3. **`packages/programs-core/programs/sooth_market/src/instructions/transfer_to_lock.rs`** — the existing PDA-signed transfer-out helper, parent-ix-gated against `sooth_amm::sell_positions` via the **scan-window** `require_parent_ix_from_program` helper. Use the **same scan-window helper** for the new fee-transfer ix (single-load is for `sooth_book` CPIs only).
4. **`packages/programs-core/programs/sooth_amm/src/instructions/trade_positions.rs:467-477`** — the buy-path fee CPI added in W2a. Mirror the field names (`market_fee_pool`).
5. **EVM `FeeRouter._quoteFee`** at `/Users/danieltang/GitHub/sooth-alpha/packages/contracts-core/src/FeeRouter.sol:415-423`:
   ```solidity
   uint16 bps = isGraduated ? postGradFeeBps : preGradFeeBps;
   fee = (baseCost * uint256(bps)) / BPS_DENOMINATOR;
   netAmount = isBuy ? baseCost + fee : (baseCost > fee ? baseCost - fee : 0);
   ```
   Solana's `ProtocolConfig` collapses `preGradFeeBps`/`postGradFeeBps` to a single `fee_bps` field (architecture §8). The pre/post difference is in the _destination_ split, applied at `distribute_fees`, not at fee computation.

---

## Scope

### 1. `sooth_market` — new filler-only ix `transfer_fee_to_market_pool`

File: `packages/programs-core/programs/sooth_market/src/instructions/transfer_fee_to_market_pool.rs`.

Mirrors `transfer_to_lock` exactly except destination is `market_fee_pool` instead of `lock_vault`, and the parent-ix gate is against `SELL_POSITIONS_DISCRIMINATOR` only (not the buy discriminator — buys still pull fee from user's ATA inline).

```rust
pub fn handler(ctx: Context<TransferFeeToMarketPool>, amount: u64) -> Result<()> {
    require_parent_ix_from_program(
        &ctx.accounts.instructions_sysvar,
        &SOOTH_AMM_PROGRAM_ID,
        &SELL_POSITIONS_DISCRIMINATOR,
    )?;
    // Transfer market_vault → market_fee_pool signed by vault_authority PDA
    // (same signing pattern as transfer_to_lock).
    // ...
}
```

`TransferFeeToMarketPool` Accounts struct: `market`, `market_vault`, `market_fee_pool`, `vault_authority` (the existing seeds-derived PDA for the market), `instructions_sysvar`, `token_program`. Bind `market_fee_pool` seeds to `[b"market_fee_pool", market.market_id.as_ref()]` against `sooth_launchpad::ID`. Bind `market_vault` to `market.vault`.

Wire into `instructions/mod.rs` and `lib.rs`. Discriminator constant `TRANSFER_FEE_TO_MARKET_POOL_DISCRIMINATOR` added to `sooth-protocol-types::discriminators` via `sha256("global:transfer_fee_to_market_pool")[..8]`.

### 2. `sooth_amm::sell_positions` — fee computation + CPI

Modify `sell_positions.rs`:

- Read `ProtocolConfig.fee_bps` (the protocol_config Accounts struct field already exists for buy path; mirror).
- Compute `proceeds_wad` as today.
- Compute `fee_wad = (proceeds_wad * fee_bps as u128) / 10_000` (floor div, mirrors EVM `_quoteFee`).
- Compute `net_proceeds_wad = proceeds_wad.saturating_sub(fee_wad)` (mirrors EVM `baseCost > fee ? baseCost - fee : 0`).
- **Slippage check**: existing `min_proceeds_wad` slippage gate now compares against `net_proceeds_wad`, NOT `proceeds_wad`. This is the EVM-parity rule — slippage is on the net the user actually receives.
- Convert: `net_proceeds_usdc = wad_to_usdc_floor(net_proceeds_wad)`, `fee_usdc = wad_to_usdc_floor(fee_wad)`. Sum-invariant check: `net_proceeds_usdc + fee_usdc ≤ proceeds_usdc_pre_split` (the rounding residue stays in the vault per canon `law/numeric-domain.md`).
- Replace the single `sooth_market::cpi::transfer_to_lock(proceeds_usdc)` with TWO CPIs in order:
  1. `sooth_market::cpi::transfer_fee_to_market_pool(fee_usdc)` if `fee_usdc > 0`.
  2. `sooth_market::cpi::transfer_to_lock(net_proceeds_usdc)`.
- Update the `LockEntry.amount_usdc` to `net_proceeds_usdc` (was `proceeds_usdc`).
- Update the `SellPositions` Accounts struct to include `market_fee_pool` (mirror the buy-path field naming).
- Update the docstring at lines 60–73 of `trade_positions.rs` (the sell-fee TODO that lived in the buy file as docstring) — remove the "explicitly excludes the sell path" note since it's no longer true. Or delete the docstring section entirely if it duplicates the now-current `sell_positions.rs` behavior.

**`fee_usdc == 0` case (small sells where bps × proceeds floors to 0):** skip the fee CPI, send 100% to lock. No error.

### 3. Tests

Three new tests + update existing.

#### LiteSVM / cargo test additions (`programs/sooth_amm/tests/`)

Add `tests/sell_fee_split.rs` (or extend existing fee tests):

1. **`sell_emits_nonzero_fee`** — execute a sell large enough that `fee_usdc > 0`. Assert `market_fee_pool.amount` increases by `fee_usdc` and `lock_entry.amount_usdc` equals `net_proceeds_usdc`.
2. **`buy_sell_round_trip_collects_fee_on_both_legs`** — execute a buy and a sell on the same market with identical share counts. Assert `market_fee_pool.amount` ≈ `buy_fee + sell_fee` (within rounding tolerance — both legs floor independently per §7.3).
3. **`sell_with_zero_fee_skips_fee_cpi`** — very small sell where `wad_to_usdc_floor(fee_wad) == 0`. Assert no CPI into `transfer_fee_to_market_pool` (check via `market_fee_pool.amount` unchanged), full `proceeds_usdc` goes to lock.
4. **`sell_fee_gate_rejects_direct_call`** — calling `sooth_market::transfer_fee_to_market_pool` as a top-level tx (no `sell_positions` parent) → `InvalidParentInstruction`.
5. **`sell_fee_gate_rejects_wrong_amm_discriminator`** — putting a `trade_positions` (buy) ix at index 0 followed by a top-level `transfer_fee_to_market_pool` at index 1 → reject. (The scan-window helper accepts only `SELL_POSITIONS_DISCRIMINATOR`.)

#### Update existing tests

The 17 existing `sooth_amm --lib` tests and any `tests/*.rs` integration tests in sooth_amm + sooth_market that touch the sell path must be updated for the new `SellPositions` accounts struct + the net-proceeds-instead-of-gross slippage semantics. Mirror W2a's pattern of in-place test updates.

### 4. CU envelope check

Add a comment in `sell_positions.rs` updating the CU budget breakdown. Current estimate is ~75–80k CU; the new SPL CPI adds ~5k. Target: ≤ 100k CU per dispatch acceptance.

`anchor build` doesn't measure CU directly. If the existing test harness has a CU measurement helper, use it. Otherwise document the addition in the commit message and defer measurement to W8.

---

## Acceptance gates (run in order, all must pass)

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test -p sooth_amm
NO_DNA=1 cargo test -p sooth_market
NO_DNA=1 cargo test -p sooth_launchpad
NO_DNA=1 anchor build
```

The new sell-fee tests must pass. Existing tests must pass after their account-struct updates.

CI E2E will still fail (SDK lags) — same as W2a, expected, not blocking.

---

## Out of scope

- SDK / demo updates → W7.
- `distribute_fees` rewrite → W5.
- `BookSide` / matching → W3 / W4.
- Devnet redeploy.

---

## Operational rules

- Branch: `feat/sooth_book-w2b-sell-fee` off current `main`.
- Commits: clean, small. Suggested split:
  1. `feat(sooth-protocol-types): add transfer_fee_to_market_pool discriminator`
  2. `feat(sooth_market): transfer_fee_to_market_pool ix (CPI-only)`
  3. `feat(sooth_amm): wire sell-path fee per EVM _quoteFee parity`
  4. `test(sooth_amm): sell-fee split + round-trip + gate negative cases`
- **Do NOT push**. Claude pushes after review.
- **Do NOT tag**.
- **Do NOT skip pre-commit hooks**.
- **Do NOT amend** previously-pushed commits.
- `NO_DNA=1` prefix on all CLI invocations.
- If the slippage-semantics change (net vs gross) is unclear or there's an existing test that asserts the old gross-slippage rule, **stop and print a question to stdout**. The semantics flip is intentional (EVM parity) but it's a behavior change in user-visible slippage messages.

## When done

Print one-line per-gate pass/fail summary, then stop. Claude reviews + pushes.
