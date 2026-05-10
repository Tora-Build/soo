# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning once tags are cut.

## [Unreleased]

> Tracking the `feature/sooth_book-monaco-fork` branch (P1 → fork Monaco
> for `sooth_book`, see `docs/sooth_book/fork-plan.md` for the W1-W16
> roadmap). Will become `[0.4.0]` once the orderbook is mainnet-ready.

### Added

- W1: vendored Monaco Protocol v0.15.5 source as `sooth_book` (Apache-2.0
  attribution preserved); 282/282 inline parity tests pass against the
  vendored copy.
- W1: `sooth_book` IDL committed at `packages/sdk-solana/src/anchor/sooth_book.json`
  (55 instructions, ~7500 lines).
- W1: W1-W16 migration plan at `docs/sooth_book/fork-plan.md`.
- W2: CU analysis bound at `docs/sooth_book/cu-analysis.md` — populated
  1000-entry `MarketLiquidities` matches against the LMSR loop within
  ~150-210k CU (~6.6× headroom under Solana's 1.4M per-tx budget).
- W2: portable `[patch.crates-io]` for `anchor-syn` 0.30.1 vendored at
  `vendor/anchor-syn-0.30.1-fork/` to fix `Span::source_file()` removal
  in rustc 1.95+. `anchor build` regenerates IDLs cleanly without
  per-machine registry edits.
- W2: PR-time `anchor-build` CI job catches stack-offset + IDL-gen
  regressions (per-program `cargo build-sbf` misses 2 of 6 cases that
  surface only during anchor's combined build).

### Changed

- W2: lifted `MarketLiquidities::LIQUIDITIES_VEC_LENGTH` from 30 to
  1000 entries per side. Account size grows from ~6KB to ~200KB; rent
  cost per market creation grows ~35× (~0.04 SOL → ~1.4 SOL at current
  rates) — to be folded into the launchpad's create-market fee in W6.
- W2: e2e CI workflow's build step replaces 5 per-program
  `cargo build-sbf` invocations with a single `anchor build` to catch
  stack-offset errors that only surface during the combined pipeline.
- `protocol_product` (Monaco's commission/affiliate state) vendored as
  library-only — not deployed as a separate program. Full strip-down
  scheduled for W3 sportsbook reduction.

### Fixed

- W2: SBF stack-offset overflows in 6 `sooth_book` Accounts structs
  (`CreateOrderRequest` +504, `ProcessOrderRequest` +1200, `MatchOrders`
  +1504, `OpenMarket` +544, `CreateMarket` +224, `ProcessOrderMatchMaker`
  +8) — Box-wrapped large account fields, plus a code-gen-level fix in
  the vendored `anchor-syn` to wrap `init`-constraint bodies in
  result-returning closures so init temporaries don't remain in the
  parent `try_accounts` stack frame.

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
