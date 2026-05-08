# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning once tags are cut.

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
