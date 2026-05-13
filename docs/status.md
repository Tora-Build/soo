# Status — sooth-solana

> Snapshot of program / SDK / demo / devnet state. Refresh when a layer
> meaningfully changes. For the moving sources of truth see `git log --oneline`,
> the per-package READMEs, and `programs-core/docs/architecture.md`.

## Program / SDK / demo state

**v0.4 audit-prep milestone: 5/5 production programs are shipped through W8, including the direct EVM-port `sooth_book` Path A orderbook, per-market fee pools, orderbook mint/merge/redeem, SDK/demo orderbook wiring, and W8 CU/e2e coverage. W9 review-only pass is complete with Critical 0 / High 1 / Medium 3 / Low 2. The single High (SDK multi-tx stale maker bundles on deep same-tick crosses) is founder-acknowledged and logged in `docs/audit-prep/findings.md`; fix is deferred post-W9. W9 build/test/doc gates passed on 2026-05-13; e2e was intentionally skipped for W9 per dispatch.**

| Layer                                            | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sooth_amm`                                      | LMSR math + buy + sell + claim_unlocked + fee accrual end-to-end. `trade_positions` (buy with manual CPI into `sooth_launchpad::mint_lp_for_buy` for pre-grad LP minting per architecture §4.2; per-market `fee_b_base_wad` accumulator + `MarketGraduated` flip on `b · ln(2)` threshold), `sell_positions`, `claim_unlocked`, `dismiss_market` (creator-only, post-trial), `close_dismissed_position` (parent-ix introspection on `sooth_market::claim_refund`), `initialize_amm_state`. `Position.locked_cost_usdc` accumulator backs the dismiss-refund flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sooth_market`                                   | Market PDA + lifecycle + custody + mint/merge_complete_set + **redeem** (post-settle 1:1 winner payout, half-pay on INVALID; 4 LiteSVM CPI tests) + **`claim_refund`** (PDA-signed `market_vault → user_usdc_ata` transfer of `Position.locked_cost_usdc`, CPIs into `sooth_amm::close_dismissed_position` to close the Position) + adjudicator-allowlist + `lock_for_resolution` + `settle` (both gated on `sooth_adjudicator` parent-ix CPI introspection).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sooth_launchpad`                                | `initialize_protocol` + `initialize_fee_pool` + `create_market` (composes 4 init CPIs) + `distribute_fees` + `seed_lp` + `mint_lp_for_buy` (PDA-signed mint helper for the AMM buy hook; auth-gap closer via parent-ix introspection on `sooth_amm::trade_positions`) + **`redeem_lp`** (post-graduation LP burn → pro-rata USDC payout from singleton `lp_yield_vault`, signed by `[b"lp_yield_authority"]` PDA).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sooth_adjudicator`                              | Manual variant: `register_adjudicator` + `request_lock` + `attest_outcome` + **`dispute`** (one-shot per market; cargo `cpi_dispute` 3/3 green). ZkTLS variant placeholder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sooth_book`                                     | Direct EVM-port Path A orderbook shipped through W8: two-level bitmap, `MarketBook`, per-tick `BookSide` queues, composite order ids, `buy_yes` / `buy_no`, `cancel` / `cancel_by_id`, `compact_book_side`, `close_book_side`, auto-match with 5-account maker bundles, `match_limit=0` unlimited semantics, dust skip/escrow credit-back, pending payout/fee accumulators, and W8 CU measurement for three-fill worst case. W9 found H1 in SDK orchestration, not in on-chain custody: stale multi-tx bundles are rejected by maker-account validation, but deep same-tick crosses need post-W9 SDK re-plan-after-submit.                                                                                                                                                                                                                                                                                                                                                                                            |
| `@sooth/sdk-solana`                              | Buy + sell + claim (unlock and **redeem**) + create_market + **mint/merge complete-set** + **request_lock / attest_outcome** + **dismissMarket / claimRefund / redeemLp** + `readGraduationProgress` (fee_b_base_wad / b·ln(2) / progressBps) + direct-port orderbook `buildOrderbookBuy/Sell/Cancel`, matching driver, error classifier, PDA helpers, preflight (simulate-before-sign), readAdjudicator, readPendingUnlocks, per-call CU-price salt on `submit()`, and per-program error classifier. W9 Medium follow-up: stale Monaco-era `sooth_book` IDL and legacy builder tests remain as non-canonical SDK surface cleanup.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/demo`                                      | Faithful fork. `chain-shim` routes upstream hooks through the adapter for AMM + Portfolio + Markets list + Faucet (real SPL `MintTo`) + Launchpad (real `createMarket`) + **mint/merge/redeem complete-set CTAs on /portfolio** + **pending-unlocks panel with claim button** + **operator REQUEST LOCK + ATTEST YES/NO/INVALID** + **dismiss-market / claim-refund / redeem-LP panels on /portfolio** (self-gated on creator pubkey, lifecycle, AMM `is_graduated` / `is_dismissed`) + **orderbook BUY/SELL/cancelById via SoothBookTerminal** (chain-shim wires `dispatchOrderbookWrite` -> `adapter.buildOrderbookBuy/Sell/Cancel` and reads `isMarketRegistered` / `getBalance` for the form gate). Newly-launched market PDAs persist across `page.goto` navigations via a `__soothCreatedMarketPdas` sessionStorage mirror. Adjudicator auto-registration on first connect. Header shows "Localnet/Devnet/Mainnet" based on `VITE_SOLANA_RPC_URL`. Indexer poller silenced on the Solana fork (`VITE_USE_INDEXER=false`). |
| `sooth-account-offsets` + `sooth-protocol-types` | Shared workspace crates. The first guards Position/LockEntry layout drift via compile-time `SPACE` asserts (incl. `POSITION_LOCKED_COST_USDC_OFFSET` for the dismiss-refund accumulator); the second centralizes program IDs + USDC mint + cross-program ix discriminators.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Test scoreboard

- **247 cargo tests listed** across the workspace on 2026-05-13. W9 gate passed after `NO_DNA=1 anchor build` generated `target/deploy/*.so` artifacts for LiteSVM tests. Coverage includes cpi_redeem, cpi_dispute, LP-mint flow, dismiss-market, close_dismissed_position, claim_refund, redeem_lp, fee-accumulator + graduation flip, per-market fee distribution, SoothBook matching/place/cancel/CU tests, and parent-ix gate tests.
- **89/89 SDK tests** across 21 Vitest files on 2026-05-13: smoke / sell-flow / claim-flow / refund / LP-redemption / graduation-progress / complete-set / redeem-request / operator-request / create-market / submit-failure / preflight / per-program error-classifier / LMSR / orderbook builders / matching driver / error classifier / PDA helpers.
- 6/6 demo unit tests (Vitest + happy-dom).
- **5 real on-chain UI tx flows** verified end-to-end via real Phantom on localnet (Connect, Buy YES, Buy NO, Sell YES, Faucet mint, Launchpad create-market).
- **27 Playwright on-chain e2e specs** exist against the LocalKeypairAdapter after W8. W9 intentionally skipped e2e because the dispatch is review-only; acceptance was gated on cargo checks/tests, SDK tests, demo typecheck, Anchor build, and audit-prep docs. Existing e2e set covers 00-17 AMM/lifecycle flows, 19-22 orderbook round-trips/dynamic create-graduate-orderbook, plus orderbook dust, escrow, missing-account-error, per-market fee, and per-tick-cap specs.

## W9 acceptance gates (2026-05-13)

| Gate | Result | Notes |
| --- | --- | --- |
| `NO_DNA=1 cargo check --workspace` | PASS | Existing vendored `anchor-syn` warnings only. |
| `NO_DNA=1 cargo check --workspace --features mainnet` | PASS | Existing vendored `anchor-syn` warnings only. |
| `NO_DNA=1 anchor build` from `packages/programs-core` | PASS | Required ignored local `Cargo.lock` pins for Solana platform-tools 1.51 compatibility; produced all five `target/deploy/*.so` artifacts. |
| `NO_DNA=1 cargo test --workspace` | PASS | Initial run failed only because `target/deploy` was absent; rerun after Anchor build passed. |
| `cd packages/sdk-solana && NO_DNA=1 pnpm test` | PASS | 21 files, 89 tests. |
| `cd apps/demo && NO_DNA=1 pnpm typecheck` | PASS | Required `pnpm --filter @sooth/sdk-solana build` first so demo could resolve package `dist` types. |
| audit-prep docs file gate | PASS | Threat model, EVM parity diff, parent-ix checklist, fee-flow delta, findings log, and file-by-file review present. |

## Codex review

Earlier 2-pass review complete. 2 critical, 6 high, 3 medium, 2 low findings were closed in prior waves (commits `68b663b` and `abfcf15..b029129`). W9 re-review on 2026-05-13 produced Critical 0 / High 1 / Medium 3 / Low 2. H1 is acknowledged and deferred post-W9; W9 acceptance PASS is gated on the build/test/docs gates above, not on fixing H1 in this review-only wave.

## Known open items

- H1 post-W9 fix: SDK multi-tx orderbook matching must submit/re-read/re-plan between batches for deep same-tick crosses.
- zkTLS adjudicator variant remains deferred.
- Path B signed orders, T* retroactive settlement, and TruthMarket `invalidate()` parity remain deferred per D14.
- Three-outcome / MAYBE markets are not implemented in v0.4; current `sooth_book` is binary Path A.
- Devnet redeploy remains pending W9 sign-off and deploy-payer funding; no W9 devnet redeploy was attempted.

## Devnet deployment status (2026-05-07)

Three of five production programs are deployed and the protocol singletons
are bootstrapped. `sooth_amm` and `sooth_book` remain pending redeploy after
W9 sign-off/funding. Deploy payer is `apps/demo/.deploy-payer.json`
(gitignored), pubkey `3rrWjQLuUUcxsFjiGDKpBzHW8yfaioMNa88TEKU8dKcY`.

| Program             | Program ID                                     | Status   | Solscan                                                                                           |
| ------------------- | ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `sooth_amm`         | `67zS8M81LATLxEgegm5jyYgwFYNTfbF3FnYqxjbZKp7k` | NOT YET  | [solscan](https://solscan.io/account/67zS8M81LATLxEgegm5jyYgwFYNTfbF3FnYqxjbZKp7k?cluster=devnet) |
| `sooth_market`      | `ByhA86BqTTrsZBDjSURWjRncojE6p7sxUqcWmHxfdd2n` | deployed | [solscan](https://solscan.io/account/ByhA86BqTTrsZBDjSURWjRncojE6p7sxUqcWmHxfdd2n?cluster=devnet) |
| `sooth_launchpad`   | `HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3` | deployed | [solscan](https://solscan.io/account/HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3?cluster=devnet) |
| `sooth_adjudicator` | `4fifRPBFebS12impdMvQGKZ9WZ96GgUunrw6iEx3KKV8` | deployed | [solscan](https://solscan.io/account/4fifRPBFebS12impdMvQGKZ9WZ96GgUunrw6iEx3KKV8?cluster=devnet) |
| `sooth_book`        | `DKxaVqA38Y2zvtM2fqoAJJQUPCefSoCL41dCjeACgo5X` | NOT YET  | [solscan](https://solscan.io/account/DKxaVqA38Y2zvtM2fqoAJJQUPCefSoCL41dCjeACgo5X?cluster=devnet) |

`sooth_amm` deploy was blocked by a devnet faucet rate-limit during the
initial rollout; the keypair at `target/deploy/sooth_amm-keypair.json` is
already wired into every `declare_id!`, IDL, and Anchor.toml entry — running

```
solana program deploy target/deploy/sooth_amm.so \
  --program-id target/deploy/sooth_amm-keypair.json \
  --keypair apps/demo/.deploy-payer.json \
  --use-rpc --url devnet
```

once the payer has ~3 SOL again will land the program at the expected ID
with no further code changes.

Singleton bootstrap (`apps/demo/scripts/seed-devnet.mjs`) is complete:

- `ProtocolConfig` PDA: `5zeukhATu775fSK7tbewDrDvSy9DNkAuXsXLPZrGAeZ8`
- `fee_pool_vault`: `BvoFfmXcEEaKHKzPNTmSbmzBfAWWDoFW197F3BfuEyiZ`
- `AdjudicatorAllowlist` PDA: `C7E2akWKo2ZNHvfT5xMFXqYzRAG1gY8P1H9ZK1q8H8Jc`
- Demo adjudicator (deploy payer): `3rrWjQLuUUcxsFjiGDKpBzHW8yfaioMNa88TEKU8dKcY`

Once `sooth_amm` is deployed, `node apps/demo/scripts/seed-devnet.mjs --keypair apps/demo/.deploy-payer.json --with-market` will seed a market end-to-end (requires the signer to have devnet USDC on hand).

## Sources of truth (in order of recency)

1. `git log --oneline main` — every wave + fix is documented here.
2. `docs/decision-log.md` — D1-D17 resolved entries, append-only.
3. `packages/programs-core/README.md` — per-program status table + toolchain notes.
4. `packages/sdk-solana/README.md` — adapter status (refreshed in commit `ddcd2a2`).
5. `apps/demo/README.md` — dev workflow + what's wired vs stub.
6. `packages/programs-core/docs/architecture.md` — re-synced with implementation reality (commit `482795a`).
