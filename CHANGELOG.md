# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning once tags are cut.

## [Unreleased]

> Tracking `develop`. Becomes `[0.4.0]` when the protocol is mainnet-ready.

### Added

- `create_market` takes the question text, verifies it against its sha256 hash,
  and emits it in `MarketCreated`; the account keeps the hash and `market_id`
  defaults to its first 16 bytes. Titles no longer need an indexer.
- End-of-life instructions: `sweep_residual` moves the settled remainder to the
  treasury, `close_market` reclaims rent behind an `MKTCLOSD` tombstone, and
  `reclaim_subsidy` returns the creator's unspent LMSR subsidy.
- `redeem_book_seat` pays out winning book positions; `redeem_amm_position`
  pays out AMM positions.
- Per-market `lp_yield_amm` and `lp_yield_book` vaults, with
  `distribute_fees_amm` / `distribute_fees_book` as separate cranks.
- `apps/demo` gains two surfaces: the Eastboard shell at `/options`, wrapping
  the classic pages, and the Arena play deck at `/play`.

### Changed

- The six programs became one: `sooth_core` holds market lifecycle, the LMSR
  AMM, the order book, LP/fee flows, and adjudication as Rust modules. No
  cross-program CPI, no parent-instruction gates, one IDL.
- The order book is one dynamically grown account per market on a single
  YES-price axis in ticks `1..=999`, matched on-chain. Capacity is a 4,096-block
  arena shared between resting orders and one seat per seated trader; empty
  seats are reclaimed. Cancelling credits the owner's seat, withdrawn via
  `book_withdraw`.
- The venues hold different tokens: the AMM prices in the deployment's instance
  token, the book in USDC, with the book gated closed until graduation.
- `attest_outcome` no longer settles. It records the outcome and opens a veto
  window for `dispute`; a permissionless `settle` finalizes afterwards.
- `seed_lp` requires and transfers the `b·ln(2)` LMSR subsidy, so a market's
  liquidity is funded at creation.
- Every transaction must request a 256 KB heap frame; the program runs a custom
  bump allocator to fit multi-fill matching.

### Removed

- The vendored Monaco fork and the per-tick `BookSide` / `MarketBook` /
  `OrderbookPosition` account model, along with complete-set mint/merge and SPL
  outcome tokens.

---

> `apps/pulse`, a standalone shim-free frontend, also sat here unreleased. It was
> dropped in favour of the two surfaces `apps/demo` now carries, so it has no
> entry above.

> The Monaco-fork line of work (vendored Monaco Protocol as `sooth_book`, the
> sportsbook strip-down, the probability-WAD price ladder, and the cross-program
> book/market wiring) sat here unreleased between 0.3.0 and this entry. It was
> superseded by the direct book redesign above and deleted, so its entries are
> not carried forward.

## [0.3.0] - 2026-05-08

### Added

- T58-T64 AMM lifecycle completion across `sooth_amm`, `sooth_market`, and `sooth_launchpad`: fee-b accumulator, graduation flip, creator dismiss-market, dismissed-position closeout, claim-refund, and LP redemption.
- Cargo coverage for the new lifecycle paths, including fee-accumulator graduation, dismiss-market, claim-refund, and `redeem_lp` flows.
- SDK adapter support for graduation progress, dismiss-market, claim-refund, and redeem-LP submit paths, with refreshed IDLs and error classification.
- Demo portfolio panels for dismiss-market, claim-refund, and redeem-LP, plus UI-driven Playwright specs for create-market, faucet, trade-to-graduate, dismiss-market, claim-refund, redeem-LP, and the gated orderbook state.

### Changed

- Demo chain-shim and portfolio bridges now surface all launch-critical Solana writes through the forked app instead of relying on operator-only fixtures.
- Local Surfpool validation now covers 19/19 on-chain Playwright specs with video capture and walkthrough generation.
- Status, roadmap, handover, and architecture docs now describe the shipped AMM lifecycle rather than the earlier partial-program state.

### Fixed

- `Position.locked_cost_usdc` now preserves the refund basis needed for dismissed-market refunds.
- Dismissed positions close only through the `sooth_market::claim_refund` parent instruction path.
- Freshly-created market PDAs persist across demo page navigations via session storage, keeping the launchpad and portfolio flows connected during E2E runs.
- `/orderbook/:market` renders a gated SoothBook state directly instead of crashing through an unavailable inner hook.
