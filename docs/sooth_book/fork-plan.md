# SoothBook Monaco Fork Plan

> Status: P1 resolved 2026-05-08 (decision-log D7). Fork active on
> `feature/sooth_book-monaco-fork` as of 2026-05-09. Replaces the prior
> 1-page record now that the port is in motion.

## Decision

Sooth forks [Monaco Protocol](https://github.com/MonacoProtocol/protocol)
at tag `v0.15.5` (commit `96d4d79`) under Apache-2.0. Rationale: Monaco's
binary-outcome shape, sortable price ladder, and settlement hooks map
cleanly to Sooth's prediction-market semantics; the alternative paths
(Phoenix integration, custom build, off-chain matching + on-chain
settlement) were rejected for license, fit, and timeline respectively
(decision-log D7, comparison in this plan §7).

## 1. Scope

**In scope for v1 (`v0.4.0` ship target):**

- Limit orders (place / cancel / reduce)
- Atomic match-on-place (Monaco's existing crankless path)
- Binary YES/NO outcomes wired through Sooth's `sooth_market` complete-set
- Adjudicator-driven settlement of resting orders via parent-ix
  introspection on `sooth_adjudicator`
- Fee router integration (Sooth's `distribute_fees` consumes `sooth_book`
  per-trade fees)
- Capacity lift (`MarketLiquidities` 30 → 1000 entries per side)
- Price ladder translation (Monaco's decimal-odds 1.001-1000.0 →
  Sooth's probability-WAD 0-1·WAD)

**Deferred to v2 (`v0.5.0`):**

- Surplus mechanics (Monaco's matched-stake redistribution)
- `escrow = true` share-backed orders (vs cash-backed)
- Cross-matching across multiple outcomes (binary case is degenerate;
  re-enable for n-way markets if Sooth ever supports them)

**Out of scope (will not port from Monaco):**

- Sportsbook-shaped n-way market types
- "In-play" market state transitions
- Manual cranking paths Monaco preserved for legacy compatibility

## 2. Hard rewrite sites (from `monaco-investigation-week-01.md`)

| #   | File:line                                       | Site                                              | Touch                                          |
| --- | ----------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| 1   | `state/market_liquidities.rs:22`                | `LIQUIDITIES_VEC_LENGTH = 30`                     | Lift to 1000                                   |
| 2   | `state/market_liquidities.rs:23-28`             | `SIZE` const baked from `vec_size(..., 30)`       | Recompute                                      |
| 3   | `state/market_liquidities.rs:412-415`           | `is_full()` returns `60 <= len_for + len_against` | Lift threshold                                 |
| 4   | `state/price_ladder.rs:4-26`                    | `DEFAULT_PRICES: [f64; 317]` decimal-odds ladder  | Replace with WAD-probability ladder            |
| 5   | `instructions/matching/on_order_creation.rs:13` | `MATCH_CAPACITY = 10` per-order match cap         | Confirm via CU benchmark; raise only if needed |

The investigation doc identifies 4 additional **soft** rewrite sites
(filter-scans whose CU envelope grows with N). Their behavior at 1000-cap
gates the W3 capacity decision.

## 3. Sooth-specific additions on top of Monaco

These are NEW instructions/state that don't exist in Monaco upstream.
They get added as Sooth's contribution.

- **`mint_into_book`** — mint complete-set USDC → YES + NO directly into
  the book. Wraps `sooth_market::mint_complete_set` + escrow into resting
  orders. Eliminates the round-trip through user's wallet for makers.
- **`settle_resting_orders`** — adjudicator-driven cleanup after market
  settlement. Resting orders for the winning side redeem 1:1 USDC; losing
  side returns 0. Parent-ix introspection on `sooth_adjudicator::settle`
  gates this.
- **`fee_route_hook`** — every fill increments `sooth_book`'s
  `fee_b_base_wad` accumulator (mirroring `sooth_amm`). The launchpad's
  `distribute_fees` ix already routes the 4-way bps split (b-base /
  lp-yield / adjudicator / treasury); this hook just feeds it.
- **`adjudicator-CPI auth`** — `settle_resting_orders` requires parent-ix
  program-id == `market.adjudicator` (canonical `sooth_adjudicator`
  program). Same pattern as `sooth_market::lock_for_resolution` /
  `settle`.

## 4. Week-by-week migration (W1–W16)

```
W1 (in-flight)   Vendor + compile + parity tests + IDL
                 ├─ Fork branch off main
                 ├─ Vendor Monaco programs/monaco_protocol/src at v0.15.5
                 ├─ Rename program identity (monaco_protocol → sooth_book)
                 ├─ cargo build green against sooth-solana toolchain
                 ├─ Run Monaco's own test suite for parity baseline
                 └─ anchor build → IDL → SDK anchor/sooth_book.json

W2               CU benchmark + capacity-lift decision + W1 cleanup
                 ├─ LiteSVM bench: populate 1000-entry MarketLiquidities,
                 │  measure CU per match against MATCH_CAPACITY=10
                 ├─ If CU < 600k: lift Vec to 1000 (item §2.1-2.3)
                 ├─ If CU > 600k: tick-bitmap rewrite (full replacement
                 │  of MarketLiquidities Vec with bitmap + per-tick
                 │  liquidity nodes)
                 ├─ anchor-syn IDL-gen fix: anchor-syn 0.30.1 calls
                 │  proc_macro2::Span::source_file() (removed in
                 │  rustc 1.95). Either upgrade Anchor to 1.0.x
                 │  workspace-wide (heavier; touches all 5 programs)
                 │  or [patch.crates-io] anchor-syn with the local
                 │  fix codex applied (lighter; reproducible).
                 │  cargo build-sbf works without this fix; anchor
                 │  build does not.
                 ├─ SBF stack-offset warnings: ProcessOrderMatchMaker
                 │  (8 over), MatchOrders (1504 over), CreateMarket
                 │  (224 over), OpenMarket (544 over) all exceed
                 │  Solana's 4096-byte SBF stack ceiling. Fix via
                 │  Box<>-wrapping large fields in Accounts structs.
                 │  Non-fatal in build but real UB risk on-chain;
                 │  audit-blocker.
                 ├─ protocol_product cleanup: declare_id! still points
                 │  at Monaco's mainnet program-id (mppFrYmM…JEE).
                 │  In library-only usage this is dead code, but
                 │  should be replaced with sooth_book's id or removed.
                 └─ Audit-firm RFP draft (OtterSec / Neodyme / Halborn)

W3               Sportsbook strip-down
                 ├─ Remove n-way outcome paths (binary-only)
                 ├─ Remove in-play state transitions
                 ├─ Remove cross-matching code (defer to v2)
                 └─ Tests pass on the reduced surface

W4               Price ladder translation
                 ├─ Replace DEFAULT_PRICES[317] decimal-odds ladder with
                 │  WAD-probability ladder (1000 ticks, 0.001-WAD per
                 │  tick from 0 to 1·WAD)
                 ├─ Update all Order/Liquidity sites to use
                 │  probability·WAD instead of decimal odds
                 └─ Round-trip tests vs sooth_amm's LMSR pricing

W5–W6            Sooth instruction surface
                 ├─ mint_into_book ix + accounts + tests
                 ├─ settle_resting_orders ix + parent-ix auth
                 ├─ fee_route_hook + accumulator wiring
                 └─ Cross-program coordination tests with sooth_market,
                    sooth_adjudicator, sooth_launchpad

W7               First Surfpool deployable
                 ├─ deploy 5 programs to local Surfpool (amm, market,
                 │  launchpad, adjudicator, book)
                 ├─ Demo dapp /orderbook/:market wired to real ix's
                 │  (replaces gated-state copy)
                 └─ Smoke spec: place YES limit order, fill it via
                    counter-order, settle via attestation

W8               Integration + e2e specs
                 ├─ 8-12 new Playwright specs covering book flow:
                 │  place / cancel / fill / partial-fill / settlement /
                 │  redeem / cross-program with AMM coexistence
                 ├─ CU profiling on the populated-book happy path
                 └─ Audit RFP responses → firm selected

W9               Audit prep
                 ├─ Codex-pass review (2 passes, like sooth_amm)
                 ├─ Documentation pass (rustdoc + arch.md sooth_book §)
                 ├─ Threat model write-up (book vs amm differences)
                 └─ Audit handoff package

W10–W12          External audit window
                 ├─ Fix-and-respond cadence (~2-week iteration)
                 ├─ Re-audit findings until clean
                 └─ Surplus mechanics / escrow=true / cross-matching
                    re-introduction (deferred features, parallel track
                    with audit so not on critical path)

W13              Devnet deploy + soak
                 ├─ Deploy sooth_book to devnet with 5gAMj…UTxkH
                 ├─ Bootstrap singletons via seed-devnet.mjs --with-book
                 ├─ Concurrent-user soak test (20-50 simulated traders)
                 │  on devnet
                 └─ Indexer integration spike (Helius webhook → Postgres)

W14              Mainnet ship (`v0.4.0`)
                 ├─ Mainnet deploy with finalized program-id
                 ├─ Protocol-config bootstrap + LP yield vault funding
                 ├─ Demo dapp pointed at mainnet, /orderbook live
                 └─ v0.4.0 tag + CHANGELOG

W15-W16          Post-ship hardening + v2 prep
                 ├─ Production observability: indexer, alerting, oncall
                 ├─ v2 backlog grooming (surplus, escrow=true,
                 │  cross-matching when n-way markets land)
                 └─ Initial market-maker incentives if liquidity is thin
```

## 5. Risks tracked

| Risk                                                                               | Likelihood               | Impact                                        | Mitigation                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| CU benchmark fails (1000-cap doesn't fit budget)                                   | Low (math says ~250k CU) | High (forces tick-bitmap rewrite, +2-3 weeks) | W2 first task. Bounded by `MATCH_CAPACITY=10` cap.                                            |
| Anchor version mismatch between Monaco v0.15.5 and sooth-solana 0.30.1             | High                     | Medium (mechanical upgrade)                   | W1 item 4. Codex investigates; STOP-and-report if upgrade requires source-level changes.      |
| Audit slot booking lead-time                                                       | Medium                   | High (delays mainnet 4-6 weeks)               | W2 RFP. Book early, pay deposit if needed.                                                    |
| Adjudicator settlement of resting orders has edge cases not in EVM SoothBook       | Medium                   | High (re-architecture)                        | W5-6 design phase. Mirror `sooth_market::redeem` pattern. Threat model in W9.                 |
| Sooth-specific fee accumulator double-counts when AMM and book both touch a market | Low                      | Medium                                        | W6 cross-program test. Each program owns its own accumulator; `distribute_fees` reads both.   |
| Monaco's mainnet usage is minimal (no battle-tested under adversarial load)        | High                     | Medium                                        | Audit + soak make up for it. Monitor mainnet for first 3 months post-ship.                    |
| Solana CLOB engineer not available                                                 | Medium                   | High (slips W3-W6 by 4-6 weeks)               | Hire decision deferred to user; if no, engineering pace assumes existing team + Claude/Codex. |

## 6. Keypair escrow

`target/deploy/sooth_book-keypair.json` (program-id
`5gAMjRCaZfb4NtHmBf2RZHFJVLAAZQ1PBP6dRNPUTxkH`) is gitignored and
machine-local on the development machine that ran the W0 placeholder
work. **Before mainnet deploy in W14**, the keypair must be:

- Stored in a multi-sig-controlled location (1Password, Bitwarden, or
  SOPS-encrypted in repo with the SOPS key in a hardware token)
- OR regenerated, with all references (`declare_id!`, Anchor.toml,
  dev-surfpool.sh, CI workflow, devnet/mainnet seed scripts) updated to
  point at the new program-id

Decision deferred to founder; prerequisite for W14, not for W1-W13.

## 7. Why not Phoenix / OpenBook / sequencer / custom

Recorded for the decision-log; full evaluation in chat history
2026-05-09.

- **Phoenix v1**: BUSL-1.1, no Additional Use Grant. Production use
  requires commercial license from Ellipsis Labs OR wait until
  2027-02-13 GPL-v2 conversion. Disqualifying for shipping in 2026.
- **OpenBook v2**: Apache-2.0, generic CLOB. Same shape mismatch as
  Phoenix (no native binary-outcome / settlement / adjudicator hooks).
  Would require Sooth-specific layer on top, similar effort to Monaco
  fork without Monaco's prediction-market-shaped state machine.
- **Sequencer (off-chain matching + on-chain settlement)**: faster
  initial ship but founder-runs-infrastructure liability. Trust model
  shifts away from "fully on-chain" story. Reconsider in v2 if the fork
  proves over-engineered for actual flow.
- **Custom build from scratch**: 6-12 month timeline; no prior code to
  benchmark against; recreates known-solved problems. Rejected for
  timeline.

## 8. Cross-references

- Source reading: [`../research/monaco-investigation-week-01.md`](../research/monaco-investigation-week-01.md)
- Architecture overview: [`../../packages/programs-core/docs/architecture.md`](../../packages/programs-core/docs/architecture.md)
- Decision-log entry: [`../decision-log.md`](../decision-log.md) D7 (P1 resolution)
- Original Monaco fork analysis: [`../monaco-fork-analysis.md`](../monaco-fork-analysis.md)
- Monaco upstream: <https://github.com/MonacoProtocol/protocol>
