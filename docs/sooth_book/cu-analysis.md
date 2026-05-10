# SoothBook CU Analysis — Populated 1000-Entry MarketLiquidities

> Status: analytical bound, 2026-05-09. Pre-audit; benchmark validation
> deferred to W8 once SBF stack-offset fixes (W2) and Sooth-specific
> instruction surface (W5-W6) land. Replaces the W2 LiteSVM bench task
> that would have generated the same number at higher effort.

## TL;DR

`match_orders` against a populated 1000-entry `MarketLiquidities` is
bounded above by **~210k CU** in the realistic worst case. The Solana
per-tx budget is 1,400,000 CU. Headroom is **~6.6×**.

Conclusion: the W2 capacity-lift decision lands on **lift the Vec to
1000** (3-line change in `state/market_liquidities.rs`), not on a
tick-bitmap rewrite (multi-week). The headroom is large enough that
even pessimistic constants leave the budget intact.

## Inputs

- `MATCH_CAPACITY = 10` per-order match cap
  (`instructions/matching/on_order_creation.rs:13`)
- `MarketLiquidities.liquidities_for` / `liquidities_against` are sorted
  `Vec<MarketOutcomePriceLiquidity>`, ~50 bytes per entry
  (`monaco-investigation-week-01.md` §3)
- Match loop early-breaks on `order_matches.len() == MATCH_CAPACITY`,
  on `liquidity.price < order.expected_price`, or on `stake_unmatched
== 0` (`on_order_creation.rs:46-54`)

## Worst-case decomposition

The realistic worst case is an order that:

1. Targets an outcome where the entire opposing book is on the OTHER
   outcome (so `filter(|e| e.outcome == order_outcome)` skips every
   entry — no early break on outcome match)
2. Has `expected_price` at the price-ladder floor (no early break on
   price)
3. Has `stake_unmatched` large enough to consume all 10 matches
4. Operates against a `MarketLiquidities` populated to 1000 entries
   per side

| Step                                                               | Ops   | CU est.                            | Source                        |
| ------------------------------------------------------------------ | ----- | ---------------------------------- | ----------------------------- |
| `liquidities.iter().filter()` setup                                | 1×    | ~200                               | iterator construction         |
| Filter scan over 1000 entries (outcome mismatch path)              | 1000× | ~50/entry                          | branch + field load           |
| Match loop body (10 successful matches, taking outcome-match path) | 10×   | ~5k/match                          | enqueue + token transfer prep |
| `Vec::remove` × 10 (shift later entries)                           | 10×   | ~50 entries × ~200 CU shift = ~10k | O(N) memmove                  |
| Anchor account loads + bumps                                       | 1×    | ~30k                               | per-instruction overhead      |
| Cross-program signer setup, log emissions                          | 1×    | ~10k                               | misc                          |
| **Total**                                                          |       | **~150-210k**                      |                               |

The 50 CU/entry estimate for outcome-mismatch filter scans is
conservative; actual SBF instruction count for a `u16` field load +
branch is closer to 10-20 CU. The 5k CU/match estimate already includes
account-borrow overhead per Anchor instruction.

## Why the LiteSVM benchmark is deferred

A real LiteSVM benchmark would tighten the number from "~150-210k" to
a precise figure (likely 80-130k based on these conservative ops/CU
estimates). But the budget headroom is so large that even a 2× pessimism
margin leaves us under 30% of the per-tx budget.

The W2 decision (lift Vec vs tick-bitmap rewrite) only flips at CU >
600k. The analytical bound is comfortably under that threshold.

The benchmark IS still owed in **W8 (integration testing + CU
profiling)** per `fork-plan.md`, where it will become an audit-prep
artifact rather than a W2 decision input. Audit firms typically want
empirical CU measurements, not just analytical bounds.

## Pessimistic stress check

If we triple every CU estimate (e.g. SBF instruction counts are 3× the
back-of-envelope above): ~450-630k CU. Still under 1.4M.

If the filter scan is 10× more expensive than estimated (1000 × 500 CU
= 500k CU just for the scan): total ~700-800k CU. Still under 1.4M.

The first design that would actually break the budget is a 5000-entry
book with O(N) shifts, which is past the EVM SoothBook tick range
anyway.

## What the bound assumes

- Stack-offset overflows are fixed (W2 task #70). With the current
  unfixed `MatchOrders` accounts struct (5600-byte stack frame, 1504
  over budget), the program may UB before reaching the matching loop.
- Anchor IDL-gen patch is portable (W2 task #69). Doesn't affect
  runtime CU but blocks regeneration if program source changes.
- `protocol_product` is library-only (W1 architectural choice). If we
  flip back to a sibling deployable program, add ~10k CU for the cross-
  program invocation per match.
- The price ladder is integer ticks (per W4 ladder translation work),
  not f64 decimals. f64 comparisons add ~100 CU each; integer compares
  are ~10 CU. With 1000 entries, that's a ~90k CU swing in the filter
  scan path. Worth measuring after W4 lands.

## Cross-references

- Source-reading investigation: [`../research/monaco-investigation-week-01.md`](../research/monaco-investigation-week-01.md) §4 (call-site classification — sites #11-13 are the matching engine)
- Match loop body: `packages/programs-core/programs/sooth_book/src/instructions/matching/on_order_creation.rs:27-100` (FOR-order match), `:160-245` (AGAINST-order match)
- Liquidity Vec: `packages/programs-core/programs/sooth_book/src/state/market_liquidities.rs:10-50`
- Solana CU budget: 1,400,000 per transaction (Solana validator default; configurable via `ComputeBudgetProgram`)
