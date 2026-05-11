# W1 dispatch — `sooth_book` skeleton + TickBitmap + MarketBook + types

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop after the
> acceptance gates pass; Claude reviews + pushes; do not push to
> origin from inside Codex.

---

## Context (read first, in this order)

1. **`docs/spec/sooth_book.md`** — the canonical W1 scope and acceptance criteria live in §11 row W1 + §3.1 (MarketBook) + §4.4 (composite `order_id` codec) + §6.3 (TickBitmap port notes). Read the whole file once; you'll reference §3.1, §4.4, §6.3, §9.1, §9.2, §11 directly.
2. **`docs/decision-log.md`** — D13 (Monaco fork retired in favor of EVM-direct port), D14 (Path A only), D15 (split position model), D16 (per-market fee pools). You don't act on D15/D16 in W1, but you must understand why the Monaco vendor is being deleted.
3. **`packages/programs-core/programs/sooth_book/Cargo.toml`** — current state. `name = "sooth_book"`, declare_id `DKxaVqA38Y2zvtM2fqoAJJQUPCefSoCL41dCjeACgo5X`. Preserve both (§9.2 of the spec).
4. **`packages/programs-core/crates/sooth-protocol-types/src/{ids.rs,discriminators.rs}`** — where you add the new constants. Mirror the existing comment style.
5. **`.claude/skills/solana-dev`** — toolchain norms (NO_DNA=1, Anchor 0.30.1, Solana 1.18.26, SBF stack 4 KB).
6. **EVM source for the bitmap port:** `/Users/danieltang/GitHub/sooth-alpha/packages/contracts-core/src/libraries/TickBitmap.sol`. The Solana version collapses the two-level structure to a flat `[u64; 16]` per §6.3.

---

## Scope (do exactly these, nothing more)

### 1. Delete Monaco vendor

- `git rm` everything under `packages/programs-core/programs/sooth_book/src/` (the entire Monaco-sportsbook codebase).
- `git rm packages/programs-core/programs/sooth_book/LICENSE` and `NOTICE` (Monaco's Apache-2.0 attribution).
- `git rm -rf packages/programs-core/programs/sooth_book/tests/` (Monaco-shaped tests).
- Check for and remove any `packages/programs-core/programs/sooth_book/vendor/` directory if it exists.
- Keep `Cargo.toml` (you'll edit it in step 2, not delete it).

### 2. New `sooth_book` skeleton

Replace `Cargo.toml` with a clean Sooth-shaped one. Mirror `programs/sooth_amm/Cargo.toml` for dependency versions (Anchor 0.30.1, Solana 1.18.26, no `rust_decimal`, no `protocol_product`). Description: "Sooth Solana on-chain CLOB — EVM `SoothBook.sol` direct port. See docs/spec/sooth_book.md." Version `0.4.0`. License Apache-2.0.

Create `src/lib.rs`:

- `declare_id!("DKxaVqA38Y2zvtM2fqoAJJQUPCefSoCL41dCjeACgo5X")` (preserved).
- `const _: () = assert!(crate::ID == sooth_protocol_types::ids::SOOTH_BOOK_PROGRAM_ID)` — drift assertion mirroring the other programs' pattern.
- Empty `#[program] pub mod sooth_book { use super::*; }` block (no ix yet — W3+ adds them).
- Module declarations: `pub mod state; pub mod math; pub mod bitmap; pub mod error;` (only the modules W1 needs; no `instructions` module yet — W3).

Create empty-but-typed modules:

- `src/error.rs` with a `CoreError` enum carrying at minimum `InvalidTick`, `InvalidOrderId`, `OrderIdSeedMismatch`, `MathOverflow`. Add others later as W3+ needs them.
- `src/math.rs` with `pub const NUM_TICKS: u16 = 1000; pub const MIN_TICK: u16 = 1; pub const MAX_TICK: u16 = 999; pub const BASE_UNIT_WAD: u128 = 1_000_000_000_000;` and nothing else (W4 adds `compute_cost_base`, `wad_to_base`, etc.).

### 3. Port `TickBitmap` library to `src/bitmap.rs`

Follow §6.3 of the spec. Specifically:

- `pub struct TickBitmap([u64; 16])` — flat 1024-bit, ticks 1..999.
- `pub fn set_bit(&mut self, tick: u16)` / `clear_bit(&mut self, tick: u16)` / `is_set(&self, tick: u16) -> bool`.
- `pub fn find_next_down(&self, start: u16) -> u16` — returns the largest set tick `< start`, or `0` if none (sentinel). Mirrors `TickBitmap.sol:findNextDown`.
- `pub fn find_next_up(&self, start: u16) -> u16` — returns the smallest set tick `> start`, or `MAX_TICK + 1` if none. Mirrors `TickBitmap.sol:findNextUp`.
- Use `u64::leading_zeros` / `u64::trailing_zeros` for bit-scan. Do NOT translate the EVM assembly verbatim — re-derive on top of Rust primitives.

Unit tests in the same file (`#[cfg(test)] mod tests`):

- Set + get round-trip across all 1..999 ticks.
- `find_next_down` / `find_next_up` against **1000 random patterns** with a known oracle (a `BTreeSet<u16>` reference implementation). Use a fixed seed (e.g. `rand::SeedableRng::seed_from_u64(0xS00TH)`). Each pattern: insert 0..50 random ticks, then verify `find_next_down(t)` matches the oracle for every `t` in 1..NUM_TICKS, similarly for `find_next_up`.

### 4. `MarketBook` PDA in `src/state/market_book.rs`

Layout per §3.1, exactly:

```rust
#[account]
pub struct MarketBook {
    pub market: Pubkey,
    pub base_token_mint: Pubkey,
    pub registrar: Pubkey,
    pub next_order_id: u64,
    pub bitmap_for: [u64; 16],
    pub bitmap_against: [u64; 16],
    pub pending_fees: u128,
    pub pending_taker_payout: u128,
    pub _reserved: [u8; 32],
}
```

- `impl MarketBook { pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 128 + 128 + 16 + 16 + 32; /* 432 */ }`
- Helper `pub fn bitmap(&self, side: u8) -> &TickBitmap` and `pub fn bitmap_mut(&mut self, side: u8) -> &mut TickBitmap` switching on side bit (0 = against, 1 = for). Define `pub const SIDE_FOR: u8 = 1; pub const SIDE_AGAINST: u8 = 0;` in `state/mod.rs`.

Create `src/state/mod.rs` that re-exports `market_book`. No other state files in W1.

### 5. Composite `order_id` codec in `src/state/order_id.rs`

Implement exactly the codec from §4.4:

```rust
pub fn encode_order_id(side: u8, tick: u16, seq: u64) -> u64 { /* per spec */ }
pub fn decode_order_id(id: u64) -> Result<(u8, u16, u64)> { /* per spec */ }
```

Use `CoreError::InvalidOrderId` on out-of-range. Unit tests:

- Round-trip on every valid `(side ∈ {0,1}, tick ∈ 1..=999, seq)` triple for `seq ∈ {0, 1, 2^39, 2^40 - 1}` (5 representative seq values × 999 ticks × 2 sides = 9990 cases; brute-force).
- Reject `tick = 0`, `tick = 1000`, `side = 2`.
- `seq >= 2^40` should debug_assert (test under `debug_assertions` only).

### 6. Add constants to `sooth-protocol-types`

In `crates/sooth-protocol-types/src/ids.rs` (note: `USDC_MINT_DEVNET` already exists at `:47-48` as `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` — keep it, don't redeclare). Add:

```rust
pub const SOOTH_BOOK_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("DKxaVqA38Y2zvtM2fqoAJJQUPCefSoCL41dCjeACgo5X");

/// Canonical mainnet USDC mint. Used when `sooth-protocol-types` is built
/// with `--features mainnet`.
pub const USDC_MINT_MAINNET: Pubkey =
    anchor_lang::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// The base-token mint the protocol resolves to at compile time. Toggle via
/// the `mainnet` build feature on `sooth-protocol-types`.
#[cfg(feature = "mainnet")]
pub const BASE_TOKEN_MINT: Pubkey = USDC_MINT_MAINNET;
#[cfg(not(feature = "mainnet"))]
pub const BASE_TOKEN_MINT: Pubkey = USDC_MINT_DEVNET;
```

In `crates/sooth-protocol-types/Cargo.toml`, add `[features]\nmainnet = []`. Default empty.

In `crates/sooth-protocol-types/src/discriminators.rs`, add the four sooth_book ix discriminators. **The actual byte values must be computed as `sha256("global:<ix_name>")[..8]`**. Names: `buy_yes`, `buy_no`, `cancel`, `cancel_by_id`. Run a one-off script (or `cargo expand` on an Anchor stub) to get the right bytes — do NOT make them up.

```rust
pub const SOOTH_BOOK_BUY_YES_DISCRIMINATOR: [u8; 8] = [/* computed */];
pub const SOOTH_BOOK_BUY_NO_DISCRIMINATOR: [u8; 8] = [/* computed */];
pub const SOOTH_BOOK_CANCEL_DISCRIMINATOR: [u8; 8] = [/* computed */];
pub const SOOTH_BOOK_CANCEL_BY_ID_DISCRIMINATOR: [u8; 8] = [/* computed */];
```

### 7. Add `sooth_book` to the workspace's drift assertion chain

Same pattern as the other programs: `const _: () = assert!(crate::ID == sooth_protocol_types::ids::SOOTH_BOOK_PROGRAM_ID)` somewhere in `sooth_book/src/lib.rs`. Already covered in step 2, just confirming the chain is closed.

---

## Acceptance gates (run in order, must all pass before stopping)

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test -p sooth_book --lib  # bitmap + order_id round-trip tests
NO_DNA=1 anchor build  # confirms IDL emission still works for all 5 programs
```

Each command must exit 0. The `--features mainnet` build must produce the same artifacts but with `BASE_TOKEN_MINT` resolving to `EPjFW...t1v`. Confirm by adding a test:

```rust
#[test]
fn base_token_mint_matches_feature_cfg() {
    #[cfg(feature = "mainnet")]
    assert_eq!(sooth_protocol_types::ids::BASE_TOKEN_MINT, sooth_protocol_types::ids::USDC_MINT_MAINNET);
    #[cfg(not(feature = "mainnet"))]
    assert_eq!(sooth_protocol_types::ids::BASE_TOKEN_MINT, sooth_protocol_types::ids::USDC_MINT_DEVNET);
}
```

---

## Out of scope (DO NOT do in W1)

- Any `BookSide`, `OrderbookPosition`, `MarketFeePool` state — W2.
- Any `buy_yes` / `buy_no` / `cancel` ix bodies — W3 / W4.
- Any change to `sooth_market`, `sooth_amm`, `sooth_launchpad`, `sooth_adjudicator` — W2+.
- SDK / demo updates — W6+.
- Anchor.toml changes (program ID stays the same; no devnet redeploy).
- Devnet redeploy or tag.

---

## Operational rules

- Branch: `feat/sooth_book-w1-skeleton` off current `main` (`8c7bb58`).
- Commits: clean and small. Suggested split:
  1. `chore(sooth_book): delete Monaco vendor`
  2. `feat(sooth-protocol-types): add SOOTH_BOOK_PROGRAM_ID + USDC mints + BASE_TOKEN_MINT cfg + sooth_book discriminators`
  3. `feat(sooth_book): skeleton + Cargo.toml + lib.rs + drift assert`
  4. `feat(sooth_book): TickBitmap port + unit tests`
  5. `feat(sooth_book): MarketBook PDA layout`
  6. `feat(sooth_book): composite order_id codec + tests`
- **Do NOT push** to origin. Claude pushes after review.
- **Do NOT tag**.
- **Do NOT skip pre-commit hooks** (`--no-verify` is forbidden).
- **Do NOT amend** previously-pushed commits.
- `NO_DNA=1` prefix on all CLI invocations.
- If a step is ambiguous, **stop and print a question to stdout**. Do not guess on architectural decisions.

## When done

Print a one-line summary per acceptance gate (pass/fail + the command), then stop. Claude will read the branch and decide on the PR.
