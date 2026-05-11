# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning once tags are cut.

## [Unreleased]

> Tracking `main` (W1-W6 merged via PRs #1-#6 on 2026-05-10 → 2026-05-11).
> Will become `[0.4.0]` once the orderbook is mainnet-ready.

### Added

- W3-W6 + UI cohort (PRs #1-#6, `ddfb032 → 263f5a1`):
  - W3 sportsbook strip-down (~5400 LOC removed from vendored Monaco).
  - W4 probability·WAD price ladder (u128 prices; `MarketLiquidities`
    depth=30 per side, bounded by Solana's 10240-byte realloc cap).
  - W5 cross-program `Market` PDA bind to `sooth_market`; 4 new ix
    (`mint_into_book`, `settle_resting_orders`, `fee_route_hook`, plus
    the cross-program seed); `sooth_market`
    `mint_complete_set_to_program_owned` / `redeem_from_program_owned`
    variants.
  - W6 SDK builders (`buildOrderbookBuy/Sell/Cancel`) + chain-shim
    dispatch (`buyYes/buyNo/cancelById`/`cancel`/`isMarketRegistered`/
    `getBalance`/synth `getLogs`) so upstream `SoothBookTerminal` drives
    real on-chain orders via the LocalKeypairAdapter.
- 6 new e2e specs (19 adapter-direct, 20 UI-click place, 21 UI-cancel,
  22 dynamic create→graduate→trade); UI health invariants enforced
  suite-wide.
- CI: Surfpool Playwright E2E job now runs on every PR (previously
  `main`-only and broken since v0.3.0).

### Changed

- `usePublicClient` (chain-shim) wrapped in `useMemo` so consumers'
  `useCallback` deps stay stable; without this the orderbook panel
  loading state thrashed forever.
- Chain-shim `waitForTransactionReceipt` returns `status:"success"`;
  upstream `useOrderbookTrade.executeWrite` threw "Transaction reverted
  on-chain" on `undefined !== "success"` even when the tx confirmed.
- `seed-localnet.mjs` writes `VITE_USE_INDEXER=false`; the Ponder
  indexer at `localhost:42069` only exists on the EVM upstream.

### Fixed

- W2 Box-wrap pass missed `CancelOrder`; new CI Surfpool E2E gate
  caught the latent SBF stack-offset overflow (`+8` over the 4096
  cap) and PR #6 Box-wrapped the remaining large `Account<T>` fields.
- spec 12 race against `__lastCreatedMarketPda` (chain-shim stashes
  pre-confirm; spec now polls `fetchMarket` to 30s).
- CI `Anchor build` job failed with `duplicate symbol: entrypoint` on
  `cpi_create_market` test target — `spl-associated-token-account` dev
  dep needed `no-entrypoint` feature; applied to all 4 program crates.
- Cargo fmt drift on W5 `sooth_market` program-owned variants.

### Removed

- Vendored `protocol_product` (Monaco mainnet program-id placeholder;
  zero usages in `sooth_book/src` after W3 strip). 13 files, ~60 KB.
- Spec 18 (`orderbook-gated-state`) obsolete post-W6: the primary
  gate it asserted no longer fires.

---

> Pre-PR-#1 entries below cover the W1-W2 work that landed on the
> `feature/sooth_book-monaco-fork` branch before its first merge.

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
