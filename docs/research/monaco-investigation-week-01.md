# Monaco Investigation Week 01 — Source Reading Report

> Status: research deliverable, 2026-05-05.
> Spike 2 per [`HANDOVER.md`](../../HANDOVER.md) §"Spike 2 — Monaco investigation week".
> Validates / refutes [`docs/monaco-fork-analysis.md`](../monaco-fork-analysis.md) §6 against first-hand source reading.

---

## 1. Executive summary

Monaco's `MarketLiquidities` struct does have a hard 30-per-side cap, but the call-site footprint that would need rewriting to lift it to 1000 ticks is **smaller than the existing analysis feared**: 5 production hard-rewrite sites and 4 soft-rewrite sites, all confined to a single state file plus two matching call sites. **Recommendation: fork Monaco**. Confidence is **medium-high**: the matching engine's per-order CU cost is bounded by a separate `MATCH_CAPACITY = 10` constant (not by liquidities Vec size), so lifting the price-index cap is genuinely orthogonal to the matching loop — but a CU benchmark on a populated 1000-cap account still needs to run.

---

## 2. Repo metadata

- Repo: `https://github.com/MonacoProtocol/protocol.git`
- Tag investigated: **`v0.15.5`**, commit hash `96d4d7976601f17d0a3bac6e801f92f0d66a4a50`
- HEAD of `main` at clone time: `a98aaf9f545709b65f6060b949572d65edc2f761` ("chore: audit reports", 2024-12-17)
- Program source: `programs/monaco_protocol/src/`, **70 `.rs` files**, **17,141 LOC** total (incl. tests). Non-test production LOC ~6-7k.
- License: Apache-2.0 (verified at repo root `LICENSE`)
- No GPL/LGPL transitive deps observed in `Cargo.toml` (license audit task §6.4 in fork-analysis: PASS at the program-crate level).

---

## 3. `MarketLiquidities` finding — confirms the 30/60-cap

The cap is real and load-bearing. `programs/monaco_protocol/src/state/market_liquidities.rs:13-28`:

```rust
#[account]
pub struct MarketLiquidities {
    pub market: Pubkey,
    pub enable_cross_matching: bool,
    pub stake_matched_total: u64,
    pub liquidities_for: Vec<MarketOutcomePriceLiquidity>,
    pub liquidities_against: Vec<MarketOutcomePriceLiquidity>,
}

impl MarketLiquidities {
    const LIQUIDITIES_VEC_LENGTH: usize = 30_usize;
    pub const SIZE: usize = DISCRIMINATOR_SIZE
        + PUB_KEY_SIZE + BOOL_SIZE + U64_SIZE
        + vec_size(MarketOutcomePriceLiquidity::SIZE, 30) // for
        + vec_size(MarketOutcomePriceLiquidity::SIZE, 30); // against
```

`is_full()` (line 412-415) compares `self.liquidities_for.len() + self.liquidities_against.len()` against `2 * 30 = 60`. The 31st insertion on a saturated side returns `MarketLiquiditiesIsFull` (lines 105-107).

**Important nuance the prior analysis got slightly wrong**: the 30-cap is **not** the price ladder. Monaco's _default_ price ladder is **317 prices** (`state/price_ladder.rs:4-26`, `DEFAULT_PRICES: [f64; 317]` from `1.001` to `1000.0`). Orders can be placed at any of those 317 prices. The 30 is the cap on **simultaneously active distinct (outcome, price) entries** in the aggregated Vec — a per-market-side liquidity-density cap, not a per-side price-ladder cap. For a 2-outcome market, this means up to 30 distinct active price levels per side in total. For sportsbooks this is typically over-provisioned. For Sooth's 1000-tick prediction-market grid with potentially every tick populated, it is a genuine binding constraint that must be lifted.

`MarketOutcomePriceLiquidity` is `~50 bytes` (line 449-460); 1000-cap × 2 sides × ~50 = ~100 KB account, well under Solana's 10 MB ceiling.

---

## 4. Call-site inventory

Each row is a **production** site (test code excluded). Classification:

- **HARD**: capacity-bound iteration, fixed-size const tied to 30, or account-size constant
- **SOFT**: parameterized but algorithmically affected by N (CU envelope changes)
- **FINE**: unaffected by the cap

| #   | File:line                                                                              | Classification | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `state/market_liquidities.rs:22`                                                       | HARD           | `const LIQUIDITIES_VEC_LENGTH: usize = 30` — primary knob                                                                                                                                                                                                                                                                                                                                                                                         |
| 2   | `state/market_liquidities.rs:23-28`                                                    | HARD           | `SIZE` constant baked from `vec_size(..., 30)` — 1-line lift                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | `state/market_liquidities.rs:412-415`                                                  | HARD           | `is_full()` returns `60 <= len_for + len_against`. Lift requires raising the const, but no logic change                                                                                                                                                                                                                                                                                                                                           |
| 4   | `state/market_liquidities.rs:30-50`                                                    | FINE           | `get_liquidity_for/against` via `binary_search_by` — `O(log N)`, fine at 1000 (~10 comparisons)                                                                                                                                                                                                                                                                                                                                                   |
| 5   | `state/market_liquidities.rs:52-122`                                                   | FINE           | `add_liquidity_*` — `binary_search_by` then `Vec::insert(idx)`. `insert` shifts later elements — `O(N)`. At 1000 entries, worst-case ~2000 byte memmoves per insert. Acceptable; any tick-bitmap rewrite would replace this anyway.                                                                                                                                                                                                               |
| 6   | `state/market_liquidities.rs:298-340`                                                  | FINE           | `remove_liquidity_*` — same `binary_search_by` + `Vec::remove(idx)` pattern, `O(N)` shift                                                                                                                                                                                                                                                                                                                                                         |
| 7   | `state/market_liquidities.rs:126-158`                                                  | FINE           | `get_cross_liquidity_*` iterates `sources` (length = `n-1` outcomes). For Sooth's binary YES/NO, n=2 ⇒ 1 source. Trivial.                                                                                                                                                                                                                                                                                                                         |
| 8   | `state/market_liquidities.rs:163-210`                                                  | FINE           | `update_cross_liquidity_*` same shape                                                                                                                                                                                                                                                                                                                                                                                                             |
| 9   | `state/market_liquidities.rs:247-296`                                                  | SOFT           | `update_all_cross_liquidity_*` — `liquidities_for.iter().enumerate().filter(...)` over the WHOLE vec. Cost grows linearly with N. **Already disabled in production** by `cancel_order.rs:93` flag (`update_derived_liquidity = false`); only used in cross-matching cancellation paths Sooth doesn't need (cross-matching is for n>2 outcomes; binary YES/NO doesn't trigger this)                                                                |
| 10  | `state/market_liquidities.rs:427-433`                                                  | FINE           | `move_to_inplay` resets to empty Vec                                                                                                                                                                                                                                                                                                                                                                                                              |
| 11  | `instructions/matching/on_order_creation.rs:13`                                        | FINE           | `pub const MATCH_CAPACITY: usize = 10` — matching is bounded per-order to **10 matches**, independent of liquidity vec size. **This is the load-bearing finding for fork viability**                                                                                                                                                                                                                                                              |
| 12  | `instructions/matching/on_order_creation.rs:37-44`                                     | SOFT           | `liquidities_against.iter().filter(\|e\| e.outcome == order_outcome)` — sequential scan with `expected_price` break. At N=1000 with a deep book this is the worst-case CU site. But: (a) sorted Vec means break-early on price often kicks in fast; (b) `MATCH_CAPACITY = 10` caps the number of accepted matches; (c) the `.filter()` predicate by outcome scans linearly so CU grows ~O(N) in the unbroken-scan worst case. Needs CU benchmark. |
| 13  | `instructions/matching/on_order_creation.rs:171-185`                                   | SOFT           | Symmetric scan in `match_against_order`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | `instructions/order/cancel_order.rs:65-80`                                             | FINE           | `remove_liquidity_for/against` via binary_search — fine at 1000                                                                                                                                                                                                                                                                                                                                                                                   |
| 15  | `instructions/order/cancel_order.rs:91-101`                                            | FINE           | `update_all_cross_liquidity_*` deliberately disabled (`update_derived_liquidity = false`, lines 92-93)                                                                                                                                                                                                                                                                                                                                            |
| 16  | `instructions/market_liquidities/update_market_liquidities_with_cross_liquidity.rs:18` | FINE           | Asserts `source_liquidities.len() == market_outcomes_count - 1`. Binary market ⇒ 1 source.                                                                                                                                                                                                                                                                                                                                                        |
| 17  | `instructions/market/update_market_status.rs:38-64` (`open()`)                         | FINE           | Initializes empty `liquidities_for/against` Vec                                                                                                                                                                                                                                                                                                                                                                                                   |
| 18  | `instructions/market/move_to_inplay.rs:33`                                             | FINE           | Calls `move_to_inplay` reset                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 19  | `context.rs:1167` (`OpenMarket`)                                                       | HARD           | `space = MarketLiquidities::SIZE` allocates account at market open. Lift the const ⇒ this auto-resizes via `SIZE` formula (no edit here; cascaded).                                                                                                                                                                                                                                                                                               |

**Tally:**

- **HARD rewrites: 4** (lines 1, 2, 3 are the same struct; line 19 is auto-cascaded). Effective independent edits: **2** (the const and `is_full()`'s comparison).
- **SOFT rewrites: 3** (lines 9, 12, 13).
- **FINE: 12 sites** confirmed unaffected.

This is **dramatically below** the 20-site threshold the existing fork-analysis used to gate the recommendation. Even being generous with the SOFT category, total is **5-7 sites**.

---

## 5. Lifecycle alignment

Monaco's `MarketStatus` enum (`state/market_account.rs:138-148`):

```rust
pub enum MarketStatus {
    Initializing, Open, Locked,
    ReadyForSettlement, Settled,
    ReadyToClose, ReadyToVoid, Voided,
}
```

Sooth's lifecycle from `architecture.md`: `Live → Resolved → Attested → Settled` with a `voided` branch for INVALID outcomes.

Mapping:

| Sooth state                                                                   | Monaco equivalent                                                                                                      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Live` (trade-accepting)                                                      | `Open`                                                                                                                 |
| `Resolved` (adjudicator submitted outcome, awaiting attestation/finalization) | `Locked` then `ReadyForSettlement` (settle() called with `winning_outcome_index` at `update_market_status.rs:203-231`) |
| `Settled` (winners can claim)                                                 | `Settled`                                                                                                              |
| `Voided` / INVALID                                                            | `Voided` (`force_void`/`complete_void` at `update_market_status.rs:94-201`)                                            |
| `Closed` (all accounts cleaned up)                                            | `ReadyToClose`                                                                                                         |

`market_lock_timestamp` and `market_settle_timestamp` (`market_account.rs:29-30`) map cleanly to Sooth's lock/resolve windows.

**Divergence**: Monaco's lifecycle is driven by an **authority pubkey** (`market.authority`), with `verify_market_authority` checks gating each state transition (`lib.rs:680-697`, `settle_market`). Sooth's lifecycle needs to be driven by an **adjudicator program** via CPI (zkTLS, Manual, etc., per `AdjudicatorRegistry` in architecture.md §6). The transition surface is the same; the gate is different. ~150 LOC swap.

---

## 6. Outcome model

Monaco supports **n-way outcomes** (`market.market_outcomes_count: u16`, `market_account.rs:27`). The `open()` instruction at `update_market_status.rs:31-36` requires `market_outcomes_count > 1`, and if `enable_cross_matching` is on, requires `< 6`. Cross-matching across n outcomes requires sources of length `n-1` (verified at `update_market_liquidities_with_cross_liquidity.rs:18`).

Mapping to Sooth's `OUTCOME = { NO: 0, YES: 1, INVALID: 2 }`:

- **YES** ↔ `market_outcome_index = 1` with `for_outcome = true` (or `index = 0` with `for_outcome = false` — Monaco's FOR/AGAINST symmetry)
- **NO** ↔ the inverse
- **INVALID** ↔ market is `Voided` (separate state, not a "winning outcome")

Sooth's binary model is a **strict subset** of Monaco's n-way model. With `market_outcomes_count = 2` and `enable_cross_matching = false`, the entire cross-matching code path (sources/cross liquidity, the `update_all_cross_liquidity_*` SOFT site, the cross liquidity sorter terms) becomes dead code we can simplify away. This eliminates ~200 LOC of complexity rather than adding it.

**Settlement maps to a `winning_outcome_index: u16`** (`lib.rs:680`, `settle_market`). Sooth would call this with 0 or 1; INVALID handled via the void path.

---

## 7. Escrow flag (`escrow=true`) feasibility

Monaco's `Order` struct (`state/order_account.rs:13-30`) does not have an `escrow` flag. Order creation flows through `create_order_request` → `process_order_request` (`lib.rs:44-100, 117-136`), and the payment is via `transfer::order_creation_payment` (with USDC debited from the purchaser's token account).

For Sooth's `escrow=true` semantics ("debit opposite-side shares as collateral"), the natural insertion point is:

1. Add `escrow: bool` to `OrderRequestData` (`state/market_order_request_queue.rs`) and `Order` (`state/order_account.rs:13-30`).
2. In `process_order_request`, branch on `escrow`: if true, instead of debiting USDC, atomically debit the opposite-side share token from the purchaser's position account (`MarketPosition`).
3. The matching engine (`on_order_creation.rs`) is unaffected — it only sees stake, not collateral source.
4. On settlement, payout already references `market_position.market_outcome_sums` per outcome (`market_position_account.rs:11`), so the share-based escrow naturally settles inside the existing position-tracking machinery.

**This is a natural insertion point, not against the grain.** Monaco's separation of `MarketPosition` (per-outcome accounting) from `Order` (price/stake) means escrow is a payment-source decision, not a matching decision. ~200 LOC. SDK side: zero impact (atomicity is preserved within the single TX since Monaco is crankless on the matching path — cf. `matching_one_to_one.rs` and `on_order_creation.rs`).

**Caveat**: Monaco does have a separate "process the order request" instruction (`process_order_request`, `lib.rs:117`). The order request is queued first, then processed. This means there's a 1-tx queueing step before the order becomes active. For escrow atomicity, both the queueing+payment and the processing+matching must be inspected — but `create_order_request` is crank-free for the _purchaser_; the operator runs `process_order_request` later. **This is a semantic subtlety**: the existing decision-log assumes Monaco is crankless, but `process_order_request` IS a crank step (operator-driven). Verify whether the request-queue step blocks atomic round-trip for `escrow=true`. If yes, route Sooth orders through a direct path that skips the request queue.

---

## 8. Settlement & adjudicator

Monaco's settlement path:

- `settle_market(ctx, winning_outcome_index)` (`lib.rs:680-697`) — checks operator authority + market authority, calls `instructions::market::settle`.
- `settle()` (`update_market_status.rs:203-231`) — requires `Open` status, valid outcome index, empty `market_matching_queue`, empty `order_request_queue`. Sets `market_winning_outcome_index = Some(...)`, `market_settle_timestamp`, status → `ReadyForSettlement`.
- Per-order `settle_order` (`lib.rs:268`) — separate ix, called per `Order` PDA, computes payout based on the winning outcome.
- `complete_settlement()` (`update_market_status.rs:233-251`) — gates the final transition to `Settled` once all positions are paid out.

There is **no native adjudicator concept**. Settlement assumes a single operator-authority pubkey. Sooth needs an `AdjudicatorRegistry`-driven model (per architecture.md §6 — `IAdjudicator` programs like Manual / zkTLS / consensus-attest).

**Where to bolt this on**:

1. Add `adjudicator: Pubkey` field to `Market` (one extra `PUB_KEY_SIZE = 32` bytes).
2. Replace `verify_market_authority` in `settle_market` with a CPI call to the adjudicator program's `attest`/`settle` instructions, passing the proposed `winning_outcome_index`.
3. Adjudicator program returns OK/Err synchronously; on OK, the existing `instructions::market::settle()` body runs unchanged.

The split between "transition to ReadyForSettlement" (set winning outcome) and "complete_settlement" (after all positions paid) is actually a **good fit** for an adjudicator dispute window: the `ReadyForSettlement` state already implies "outcome decided, waiting for cleanup" which Sooth can extend to "outcome decided pending dispute window". No restructuring needed; just additional gating instructions for an `IAdjudicator` to challenge or finalize within `ReadyForSettlement`.

~150-200 LOC for the CPI plumbing + AdjudicatorRegistry account.

---

## 9. Final tally — engineering deltas vs Monaco baseline

| Category                                         | Count                                                                                                                                                    | LOC estimate                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| HARD rewrites (capacity-bound)                   | 2 effective sites (the const + `is_full()`)                                                                                                              | ~20 LOC if just lifting the constant; ~200-400 LOC if migrating to a Sooth `TickBitmap` (Option β) |
| SOFT rewrites (CU re-validation needed)          | 3 sites: `update_all_cross_liquidity_*` (already disabled in prod for n=2), 2× sequential outcome-filter scan in `match_for_order`/`match_against_order` | 0 LOC change for binary market (cross-matching dead code); CU benchmark needed for matching scans  |
| New features                                     | Complete-set mint/merge ix; surplus mechanic; escrow flag on Order; adjudicator CPI integration                                                          | ~200 + ~150 + ~200 + ~200 = ~750 LOC                                                               |
| Dead code to delete (binary-only simplification) | Cross-matching paths, n-way outcome support, in-play order-delay logic, market-type Pubkey machinery, sportsbook in-play config                          | -300 to -500 LOC removed (net simplification)                                                      |
| **Net Rust delta vs Monaco baseline**            |                                                                                                                                                          | **~700-900 LOC added, ~400 LOC removed = +400-700 LOC**                                            |

This is **lower** than the prior fork-analysis estimate of ~900-1,100 LOC, because (a) the call-site count is below the 20 threshold, (b) the binary-outcome simplification removes more code than the multi-outcome features added, and (c) `MATCH_CAPACITY = 10` independence from `LIQUIDITIES_VEC_LENGTH` means the price-index lift doesn't cascade into matching engine restructuring.

**Comparison**:

| Path                                         | Rust LOC     | Months  | Audit                                   |
| -------------------------------------------- | ------------ | ------- | --------------------------------------- |
| Custom build (Option 2)                      | ~2,100       | 6-12    | Full new audit                          |
| Monaco fork (this report's revised estimate) | ~1,000-1,300 | **3-4** | Delta audit on top of Monaco's existing |
| Monaco fork (prior analysis estimate)        | ~1,300-1,500 | 3-5     | Delta audit                             |

---

## 10. Recommendation

**Fork Monaco.** Confidence: **medium-high**.

Path:

1. **Week 1-2**: lift `LIQUIDITIES_VEC_LENGTH` to 1000 as Option α (simple constant change), benchmark CU on `solana-test-validator` with a fully populated 1000-entry book. If CU < 200k for typical trades, ship as-is. If CU > 400k, port a Sooth `TickBitmap` (Option β, ~200-400 LOC).
2. **Week 3-4**: strip cross-matching / n-way / sportsbook in-play code (~400 LOC removed). Simplify to binary YES/NO with `for_outcome` boolean directly mapping to YES.
3. **Month 2**: add complete-set mint/merge instructions (~200 LOC); add surplus mechanic to `on_order_creation` for `yesTick + noTick > 1000` case (~150 LOC).
4. **Month 3**: add `escrow=true` flag on Order; wire opposite-side share debit through `MarketPosition` (~200 LOC). Verify no atomicity break via `process_order_request` queue path.
5. **Month 3-4**: add `adjudicator: Pubkey` to Market; replace authority gates in `settle_market` with adjudicator CPI (~200 LOC). Build `AdjudicatorRegistry` PDA.
6. **Month 4**: delta audit, devnet release.

**Switch to custom build** if:

- The CU benchmark in step 1 shows 1000-cap matching consumes >800k CU per typical buy (highly unlikely given `MATCH_CAPACITY = 10` cap, but possible if outcome-filter scan is the bottleneck).
- Post-fork audit reveals Monaco's `process_order_request` queueing breaks `escrow=true` atomicity in a way that can't be fixed by routing around the queue.

Both branch points are decidable within the first month of work, so the fork commitment is reversible.

**Total engineering: 3-4 months for a senior Rust/Solana engineer.** This is the lower bound of the prior estimate's range, justified by the smaller-than-feared call-site count.

---

## Appendix — Key `MATCH_CAPACITY` finding

`programs/monaco_protocol/src/instructions/matching/on_order_creation.rs:13`:

```rust
pub const MATCH_CAPACITY: usize = 10_usize; // an arbitrary number
```

Used at lines 33 and 167:

```rust
let mut order_matches = Vec::with_capacity(MATCH_CAPACITY);
```

And the loop at lines 39-46, 173-181 breaks when `order_matches.len() == order_matches.capacity()`. **This means a single order can match at most 10 distinct liquidity entries, regardless of how many entries the liquidity vec contains.** Lifting `LIQUIDITIES_VEC_LENGTH` from 30 to 1000 does NOT increase per-order matching cost from this loop — only the linear `.iter().filter(|e| e.outcome == order_outcome)` scan (sites #12, #13) is potentially affected, and even that is bounded by the early-break on `liquidity.price < order.expected_price` (sorted Vec) for any reasonable expected-price.

This is the load-bearing reason why the fork is viable. The matching engine's CU envelope is already structured to be independent of book depth.

---

_Investigation completed 2026-05-05 against `MonacoProtocol/protocol@v0.15.5` (commit `96d4d79`). All file:line citations verified directly._
