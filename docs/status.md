# Status — sooth-solana

> Short snapshot of what exists and what is open. For orientation and layout see
> [`HANDOVER.md`](../HANDOVER.md); for decisions see
> [`decision-log.md`](./decision-log.md).

## Shipped

| Layer                | State                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sooth_core` program | Single Anchor program. Protocol lifecycle (`initialize_protocol`, `pause`/`unpause`), `create_market` (question text verified against its sha256 hash and emitted in `MarketCreated`; the `Market` account keeps the hash), LMSR AMM (`trade_positions`, `sell_positions` with cooldown escrow, `claim_unlocked`), LP (`seed_lp` funding the `b·ln(2)` subsidy, `redeem_lp` against per-market `lp_yield_amm` / `lp_yield_book` vaults), fees (`init_market_fee_pool`, `distribute_fees_amm`, `distribute_fees_book`), CLOB (`book_init`, `book_grow`, `book_place`, `book_cancel`, `book_withdraw`), adjudication (`register_adjudicator`, `register_zk_adjudicator`, `request_lock`, `attest_outcome`, `attest_outcome_zk`, `dispute`, `settle`), and end-of-life (`redeem_amm_position`, `redeem_book_seat`, `claim_refund`, `dismiss_market`, `reclaim_subsidy`, `sweep_residual`, `close_market` with the `MKTCLOSD` tombstone). |
| Order book           | One account per market holding both sides on a single YES-price axis, ticks `1..=999`. Matching runs on-chain; the caller passes no maker bundles. Arena capacity is 4,096 blocks, shared between orders and one seat per seated trader.                                                                                                                                                                                       |
| `@sooth/sdk-solana`  | `buildCreateMarket` (market id defaults to the first 16 bytes of `sha256(question)`; `marketIdForQuestion` exported), `buildSeedLp`, `buildTrade` / `buildSell`, `buildBookPlace` / `buildBookCancel` / `buildBookWithdraw`, `buildClaim`, `buildRedeemLp`, `buildRedeemAmmPosition` / `buildRedeemBookSeat`, `buildReclaimSubsidy`, `buildSweepResidual`, `buildCloseMarket`, `buildDistributeFees`, `buildBookCancelMany`, adjudicator builders including `buildRegisterZkAdjudicator` / `buildAttestOutcomeZk`, plus readers: `readQuote`, `readSnapshot`, `readBook`, `readMarketQuestion`, `readMarketTrades`, `readMarketPlays`, `readBookHistory`, `readGraduationProgress`, `readPendingUnlocks`, `readVenueFeeBps`. |
| `apps/demo`          | Two surfaces. Arena: `/play` plus `/explore`, `/forge`, `/locker`, `/power`, `/vault`, and the shared `/amm/:market`, `/orderbook/:market`, `/operator`, `/learn`, `/geek`, `/lp-forecast`. Eastboard: `/eastboard/options`, `/eastboard/positions`, and the same shared pages under `/eastboard/*`. The pre-arena paths (`/options`, `/markets`, `/faucet`, `/portfolio`, `/liquidity`, `/create`, `/launchpad`) redirect into the arena.                                                                             |
| `infra`              | `rpc-proxy` (Cloudflare Worker fronting the RPC provider key), `arena-api` (Worker + D1 behind the arena's profile / leaderboard / social calls), `zk-resolver` (Node service that watches registered markets and submits `attest_outcome_zk`).                                                                                                                     |
| `packages/sooth-data`| Account and CPI-event indexer over `sooth_core`. Not wired into `apps/demo`, which reads accounts over RPC.                                                                                                                                                                                                                                                        |

## Deployment

Devnet. One program id for the whole protocol:

| Program      | ID                                             |
| ------------ | ---------------------------------------------- |
| `sooth_core` | `EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw` |

Both venue tokens are compile-time constants, so a deployment is bound to its
token pair (`packages/programs-core/programs/sooth-core/src/constants.rs`):

- Both venue roles resolve to the same devnet mock USDC:
  `ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX` (`AMM_TOKEN_MINT = USDC_MINT_DEVNET`)
- Mainnet builds (`--features mainnet`) use real Circle USDC for the book and
  require `AMM_TOKEN_MINT` to be set before they will compile.

Mint authorities for both devnet mocks live untracked in
`apps/demo/.localnet/`; losing them means the constants have to change and the
program has to be redeployed. Protocol singletons are bootstrapped by
`apps/demo/scripts/seed-localnet.mjs`, which seeds any cluster via
`SOLANA_RPC_URL`.

## Tests

- `cargo test -p sooth_core` — program unit and LiteSVM tests.
- `pnpm -F @sooth/sdk-solana test` — Vitest over `litesvm`.
- `pnpm -F @sooth/demo test` — demo unit tests; `pnpm -F @sooth/demo e2e` runs
  the Playwright on-chain suite against a local validator or Surfpool.

## Open

- The veto is held by a single `dispute_authority`, not a guardian allowlist.
- Three-outcome / MAYBE markets are not implemented; markets are binary.
- Off-chain signed orders (EVM "Path B"), retroactive `T*` settlement, and
  `invalidate()` parity are out of scope.
- `packages/sooth-data` indexes accounts and CPI events, but no instance is
  deployed. `apps/demo` reads accounts directly over RPC, which is adequate at
  demo scale but bounds order history to what the RPC retains.
