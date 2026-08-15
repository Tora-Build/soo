# programs-core

> The Anchor program behind Sooth on Solana. One program, `sooth_core`, deployed
> to devnet at `EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw`.

Market lifecycle, the LMSR AMM, the on-chain order book, LP and fee flows, and
adjudication are Rust modules inside a single program, calling each other as
ordinary functions. There is no cross-program CPI, no shared workspace crate,
and one IDL.

For the design — accounts, the dual-venue lifecycle, the book arena, the
constraints that shaped it — read [`docs/architecture.md`](./docs/architecture.md).

## Layout

```
packages/programs-core/programs/sooth-core/src/
├── lib.rs             # declare_id!, the 256 KB bump allocator, 30 ix handlers
├── constants.rs       # venue mints, veto bounds, account byte offsets
├── error.rs           # SoothCoreError — append-only, ABI-stable discriminants
├── events.rs          # 28 #[event] types
├── bitmap.rs
├── instructions/      # one file per handler
├── state/             # Market, AmmState, Position, LockEntry, LpPosition,
│                      #   ProtocolConfig, AdjudicatorEntry, lifecycle
├── book/              # account.rs, arena.rs, matcher.rs, settlement.rs
└── math/              # lmsr.rs, wad.rs, book.rs
```

## Instructions

| Group | Instructions |
| ----- | ------------ |
| Protocol | `initialize_protocol`, `pause`, `unpause` |
| Creation | `create_market`, `init_market_fee_pool`, `seed_lp` |
| AMM | `trade_positions`, `sell_positions`, `claim_unlocked` |
| Book | `book_init`, `book_grow`, `book_place`, `book_cancel`, `book_withdraw` |
| Fees / LP | `distribute_fees_amm`, `distribute_fees_book`, `redeem_lp` |
| Adjudication | `register_adjudicator`, `request_lock`, `lock_for_resolution`, `attest_outcome`, `dispute`, `settle` |
| End of life | `redeem_amm_position`, `redeem_book_seat`, `claim_refund`, `dismiss_market`, `reclaim_subsidy`, `sweep_residual`, `close_market` |

## Two things every caller must know

**Prepend `ComputeBudgetInstruction::request_heap_frame(256 * 1024)` to every
transaction.** The program installs a custom 256 KB bump allocator and the
runtime maps that region only when the transaction asks for it. Without the
frame the first allocation aborts with "Access violation in heap section" —
on any instruction, not just multi-fill buys. `@sooth/sdk-solana` does this on
every path it builds.

**Both venue tokens are compile-time constants.** `constants.rs` pins
`AMM_TOKEN_MINT` and `BOOK_TOKEN_MINT`, and `address =` constraints enforce them
throughout, so a mismatch is a hard transaction failure. Devnet uses
project-controlled mocks; `--features mainnet` switches the book to real Circle
USDC and refuses to compile until `AMM_TOKEN_MINT` is set. One deployment per
instance.

| Role | Devnet mint |
| ---- | ----------- |
| AMM venue (mock "EAST") | `CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu` |
| Book venue (mock USDC) | `ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX` |

Mint authorities for both live untracked in `apps/demo/.localnet/`. Losing one
means the constant changes and the program is redeployed.

## Build and test

```bash
anchor build                      # from the repo root → target/deploy/sooth_core.so
cargo test -p sooth_core          # 120 in-crate unit tests
pnpm -F @sooth/sdk-solana test    # on-chain behaviour, LiteSVM
```

`Anchor.toml` lives at the repo root and lists
`packages/programs-core/programs/sooth-core` as its single workspace member,
pinning the same program ID for devnet and localnet. Toolchain is Anchor 0.30.1
with the vendored `anchor-syn` patch at `vendor/anchor-syn-0.30.1-fork` for
rustc compatibility during IDL generation.

Unit tests live in `#[cfg(test)]` modules rather than a `tests/` directory —
120 of them, concentrated in `book/matcher.rs`, `book/settlement.rs`,
`book/arena.rs`, and `math/`. On-chain behaviour is exercised from TypeScript
against LiteSVM in `packages/sdk-solana/tests/`, which loads the built `.so`
directly, and end to end by the Playwright suite in `apps/demo/e2e/onchain/`.

## Companions

- [`../sdk-solana/`](../sdk-solana/) — `@sooth/sdk-solana`, which consumes this program's IDL
- [`../../docs/design/orderbook-redesign.md`](../../docs/design/orderbook-redesign.md) — the study behind the single-account book
- [`../../docs/design/dual-token-venues.md`](../../docs/design/dual-token-venues.md) — why the venues hold different tokens
- [`../../docs/decision-log.md`](../../docs/decision-log.md) — what is settled and what is open
