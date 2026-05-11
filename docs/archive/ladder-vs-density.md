# Ladder × Density — `sooth_book` Coordinated Sizing Analysis

> **SUPERSEDED (2026-05-11).** This analysis was input to the
> Monaco-fork capacity-lift decision under [`docs/archive/sooth_book-fork-plan.md`](./sooth_book-fork-plan.md).
> Both the fork direction and the density-lift question were retired
> per decision-log D13. The current `sooth_book` direction is the
> EVM-direct port at [`docs/spec/sooth_book.md`](../spec/sooth_book.md),
> which uses a two-level bitmap + per-tick `BookSide` PDAs instead of
> the `MarketLiquidities` aggregate this analysis sized.
>
> The arithmetic and findings remain accurate as historical record;
> the corrected `MarketLiquidities` entry size (26 B, not 50 B) is
> moot post-Monaco-retirement since `MarketLiquidities` is deleted in
> W1 per [`docs/spec/sooth_book.md`](../spec/sooth_book.md) §9.1.
>
> Do not implement against the recommendations below.
>
> ---
>
> _Original status: research deliverable, 2026-05-10._
> _Original framing: Inputs to W2 follow-up (capacity lift) per [`docs/archive/sooth_book-fork-plan.md`](./sooth_book-fork-plan.md) §2. Refined [`docs/sooth_book/cu-analysis.md`](../sooth_book/cu-analysis.md) and corrected an entry-size error in [`packages/programs-core/programs/sooth_book/src/state/market_liquidities.rs:13-22`](../../packages/programs-core/programs/sooth_book/src/state/market_liquidities.rs)._

---

## 1. Executive summary

"1000 vs 100" was conflating two independent axes:

- **Ladder resolution** — distinct WAD-probability ticks on the price grid (`PRICE_TICK`).
- **Density cap** — concurrent populated price levels per side (`LIQUIDITIES_VEC_LENGTH`).

Recommended action: bump **density 30 → 100** at unchanged **ladder = 1000**. One-line constant change; fits single-CPI init at ~5.3 KB; 3.3× depth headroom; +0.026 SOL rent/market; D1 integrator contract untouched. End-state remains 1000/1000 but is gated on a realloc-up helper (or the bitmap rewrite from [`docs/archive/monaco-fork-analysis.md`](./monaco-fork-analysis.md) §3 Option β). Do not drop the ladder to 100 under any condition — that violates D1 with no upside.

---

## 2. Axes

| Axis              | What                                       | Current value | Where set                                                   |
| ----------------- | ------------------------------------------ | ------------- | ----------------------------------------------------------- |
| Ladder resolution | Distinct WAD-probability ticks             | 1000          | `instructions/math.rs:7` (`PRICE_TICK = 1e15 = WAD/1000`)   |
| Density cap       | Concurrent populated price levels per side | 30            | `state/market_liquidities.rs:22` (`LIQUIDITIES_VEC_LENGTH`) |

**EVM SoothBook reference**: `(ladder = 1000, density = ∞)`.

- `MAX_TICK = 999`, `NUM_TICKS = 1000` (`packages/contracts-core/src/SoothBook.sol:47-49`)
- `NUM_WORDS = 4` bitmap, `MAX_TICK = 999` (`packages/contracts-core/src/libraries/TickBitmap.sol:31-33`)
- Per-tick storage is unbounded `Order[]` queue: `_orders[marketKey][side][tick]`. No cap on concurrent populated ticks.

---

## 3. Storage math (corrected)

`MarketOutcomePriceLiquidity` is **26 bytes**, not 50 (`u16 + u128 + u64` per `state/market_liquidities.rs:224-234`). The revert comment at `:13-22` cites "50 bytes × 2 sides ≈ 100 KB"; reality is 26 bytes → ~51 KB at 1000/side. The verdict (doesn't fit single-CPI init) is still right; the rationale overstates by 2×.

| density (per side) | account size | rent (≈ SOL) | single-CPI init? | reallocs to grow from 30 |
| ------------------ | ------------ | ------------ | ---------------- | ------------------------ |
| 30 (current)       | ~1.6 KB      | ~0.011       | ✓                | n/a                      |
| **100**            | **~5.3 KB**  | **~0.037**   | **✓**            | **n/a**                  |
| 500                | ~26 KB       | ~0.18        | ✗                | 3                        |
| 1000 (EVM-parity)  | ~51 KB       | ~0.36        | ✗                | 5                        |

10240 cap = `MAX_PERMITTED_DATA_INCREASE` from `solana_program::entrypoint`; applies to both init-via-CPI and per-call realloc. Solana's account-data hard cap is 10 MB, so multi-step realloc to 51 KB is unconstrained on the upper bound.

Header: 8 (disc) + 32 (market) + 8 (`stake_matched_total`) + 4 (vec_len for) + 4 (vec_len against) = 56 bytes. Account size = `56 + 52·N` for density N per side.

---

## 4. CU not binding

[`docs/sooth_book/cu-analysis.md`](../sooth_book/cu-analysis.md) upper-bounds `match_orders` against a 1000-populated book at ~210k CU under `MATCH_CAPACITY = 10` (`instructions/matching/on_order_creation.rs:13`). Per-tx budget 1.4M CU → ~6.6× headroom.

Filter-scan cost is ~10-50 CU per entry. 100 → 1000 swing is ~5-45k CU. None of the combos in this doc blow the CU budget.

---

## 5. Ladder: 1000 vs 100

| Property               | 1000-tick           | 100-tick                                                              |
| ---------------------- | ------------------- | --------------------------------------------------------------------- |
| `PRICE_TICK`           | 1e15 (WAD/1000)     | 1e16 (WAD/100)                                                        |
| Probability resolution | 0.1pp               | 1pp                                                                   |
| EVM parity (D1)        | ✓                   | ✗ — integrator-contract violation                                     |
| SDK shim required      | none                | tick×10 quantizer + `actualTick` on receipts (integrator contract §6) |
| LMSR ↔ book boundary   | continuous          | rounding seam at AMM/book join                                        |
| Crossing rule          | `yesT + noT ≥ 1000` | `yesT + noT ≥ 100`                                                    |

D1 disqualifies hidden semantic differences ([`docs/decision-log.md:21-25`](../decision-log.md)). Dropping ladder to 100 violates that unless explicitly documented, shimmed in the SDK, and surfaced on every receipt.

---

## 6. 4-quadrant verdict

| (ladder/density) | Feasibility                                                    | EVM parity           | When to ship                                                                        |
| ---------------- | -------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| 100/30           | trivial                                                        | ✗ ✗                  | never — dual D1 hit, zero upside                                                    |
| 100/100          | trivial; ~5.3 KB single init                                   | ✗                    | only as v1 stopgap with SDK quantizer; locks coarse semantic into the audit surface |
| 1000/30          | live now (W4)                                                  | partial              | today (current state)                                                               |
| **1000/100**     | **one-line `LIQUIDITIES_VEC_LENGTH = 100`**                    | **partial → better** | **next wave — recommended**                                                         |
| 1000/1000        | needs realloc-up helper (~5 grow steps); +0.35 SOL/market rent | full                 | end-state, gated on bitmap-vs-realloc decision                                      |

---

## 7. Recommendation

Bump density to **100** at ladder = 1000:

1. Edit one constant: `state/market_liquidities.rs:22` → `LIQUIDITIES_VEC_LENGTH = 100`.
2. `MarketLiquidities::SIZE` recomputes automatically from the existing `vec_size` formula.
3. Single-CPI init still works (5.3 KB < 10240 cap); no realloc plumbing required.
4. Rent delta: ~0.026 SOL/market (~$3.6 at $140/SOL).
5. D1 untouched; LMSR/book boundary untouched; audit delta is one constant.

This buys runway to design the proper end-state without a depth crisis on Surfpool integration tests or devnet soak.

**Do not** drop the ladder to 100. The W4 1000-tick choice is load-bearing for the integrator contract, and the only saving (~36 KB account at full density) is irrelevant once density and ladder are recognized as independent.

---

## 8. End-state options (out of scope, recorded for follow-up)

The 1000/1000 EVM-parity end-state has two architecturally different paths. Picking one is a separate research question.

### 8a. Realloc-up helper (incremental Vec grow)

Init at 30/side; expose `increase_market_liquidities_size(steps: u8)` that calls Anchor's `realloc` constraint with `realloc::zero = false` (already used for `PriceLadder` at `context.rs:952`). Each step adds up to 10240 bytes. Five steps total to reach 1000/side.

- Pros: minimal new architecture; reuses Monaco's sorted-Vec mental model
- Cons: ~$50/market rent; per-market write-lock contention on a 51 KB hot account; auditor-visible incremental-grow path is novel

### 8b. Bitmap rewrite (Option β from [`monaco-fork-analysis.md`](./monaco-fork-analysis.md) §3)

Replace `MarketLiquidities` Vec with a 4-word `[u64; 16]` bitmap (128 bytes) plus per-`(market, side, tick)` PDA liquidity nodes. Bit-scan via `u64::leading_zeros()` for next-tick discovery. Mirrors EVM `TickBitmap.findNextDown`/`findNextUp`.

- Pros: no density cap; sparse access at fixed cost; per-tick PDAs unblock Sealevel parallelism
- Cons: refactors matching engine call sites; ~200-400 LOC + cascade through `instructions/matching/*` and `instructions/order/*`
- See `monaco-fork-analysis.md` §3 Option β and `monaco-investigation-week-01.md` §4 for site-count budget

The bitmap path is the higher-leverage answer if density > 500 becomes load-bearing. The realloc-up path is the lower-risk answer if 100/side proves sufficient through W14.

---

## 9. Action items

- [ ] Fix entry-size comment at [`state/market_liquidities.rs:13-22`](../../packages/programs-core/programs/sooth_book/src/state/market_liquidities.rs) — current text says "50 bytes" / "100 KB"; should say "26 bytes" / "~51 KB".
- [ ] Decide whether to land density = 100 in the next wave (recommended) or hold pending the W2 LiteSVM bench (deferred per [`cu-analysis.md`](../sooth_book/cu-analysis.md) §"Why deferred").
- [ ] Open a separate research note on §8a vs §8b before W14 audit prep — the end-state path is load-bearing for the audit RFP scope.

---

## 10. Cross-references

- [`docs/decision-log.md`](../decision-log.md) D1 (integrator contract), D7 (fork direction)
- [`docs/archive/monaco-fork-analysis.md`](./monaco-fork-analysis.md) §3 (three options for handling 1000 ticks)
- [`docs/research/monaco-investigation-week-01.md`](./monaco-investigation-week-01.md) §3-4 (60-cap finding, call-site classification)
- [`docs/sooth_book/cu-analysis.md`](../sooth_book/cu-analysis.md) (CU upper bound at 1000-pop)
- [`docs/archive/sooth_book-fork-plan.md`](./sooth_book-fork-plan.md) §2 (hard rewrite sites, including `LIQUIDITIES_VEC_LENGTH`)
- EVM reference: `sooth-alpha/packages/contracts-core/src/SoothBook.sol:47-49`, `sooth-alpha/packages/contracts-core/src/libraries/TickBitmap.sol:31-33`

---

_Last updated: 2026-05-10._
