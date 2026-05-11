# Monaco Protocol Fork Analysis — Sooth Solana

> **ARCHIVED (2026-05-11).** Monaco fork direction retired per
> decision-log D13; the canonical sooth_book direction is now the
> EVM-direct port at [`../spec/sooth_book.md`](../spec/sooth_book.md).
> This analysis is preserved as the original investigation record.
>
> Status: design analysis, 2026-05-05.
> Companion to [`orderbook-survey.md`](../research/orderbook-survey.md) (broader survey).
> Originally referenced from [`docs/decision-log.md` P1](../decision-log.md), [`programs-core/docs/architecture.md §6`](../../packages/programs-core/docs/architecture.md), and [`sdk-solana/docs/implementation-guide.md §10`](../../packages/sdk-solana/docs/implementation-guide.md).

Monaco Protocol is the closest existing implementation to what Sooth needs on Solana. This doc evaluates it as a fork base — what we'd reuse, what we'd need to add or replace, where the fit breaks down, and the key load-bearing finding (Monaco's 60-cap on `MarketLiquidities` and what it costs to lift it).

---

## §1. Why Monaco

From [`orderbook-survey.md §8`](../research/orderbook-survey.md):

- **Apache-2.0 licensed.** No GPL contamination concerns (unlike OpenBook v2 and Manifest, both GPL-3.0). Sooth fork stays under whatever license operators need.
- **Binary-outcome FOR/AGAINST orderbook.** Maps almost 1:1 to Sooth's YES/NO encoding.
- **FIFO best-price matching.** Matches Sooth's intended SoothBook semantics.
- **Per-`(market, outcome, price, side)` matching pool sharding.** Solves Solana's account-list constraint without us having to design a slab allocator.
- **Lifecycle states map directly.** Monaco's `Initializing → Open → Locked → ReadyForSettlement → Settled` mirrors Sooth's `Live → Resolved → Attested → Settled` (with `voided` for INVALID).
- **Settlement is externally driven.** Authority calls `settle_market` with the outcome — already the pattern Sooth's `IAdjudicator` uses.
- **Active maintenance.** 244 commits on develop, last release v0.15.5 December 2024.

No other surveyed Solana orderbook offers this combination of license, design alignment, and active development.

---

## §2. The 60-cap finding (load-bearing)

Monaco's `MarketLiquidities` account is **the** load-bearing detail of this analysis. It is **not designed to support 1000 price points.**

### The structure

From `programs/monaco_protocol/src/state/market_liquidities.rs` (verified directly):

```rust
pub struct MarketLiquidities {
    pub market: Pubkey,
    pub enable_cross_matching: bool,
    pub stake_matched_total: u64,
    pub liquidities_for: Vec<MarketOutcomePriceLiquidity>,
    pub liquidities_against: Vec<MarketOutcomePriceLiquidity>,
}

const LIQUIDITIES_VEC_LENGTH: usize = 30;  // per side
```

Two **sorted vectors**, one for FOR (Sooth's YES), one for AGAINST (Sooth's NO). Hard-capped at 30 distinct prices per side. `is_full()` returns true at 60 total entries; the 31st insertion returns `MarketLiquiditiesIsFull`.

Best-price discovery is `binary_search_by()` on the sorted vec — not a bitmap LSB/MSB scan like SoothBook's `TickBitmap.findNextDown`.

### Why 30, not 1000

Three reasons compounded:

**(1) Decimal odds vs probability ticks — different price spaces.** Monaco's price is decimal odds with `decimal_limit: u8` precision (e.g. `2.50`, `3.75`). In sportsbook UX, odds range from 1.01 to ~1000 covering implied probabilities ~99% down to ~0.1%. A typical sports market has 5-15 active prices on each side; even Champions League finals rarely cross 30. Sorted Vec with binary search is correct for sparse, unbounded decimal odds.

Sooth's design is the opposite: **a fixed 1000-tick grid in probability space**, where the entire price domain is enumerable upfront. SoothBook's tick bitmap exists _because_ the space is discrete and bounded; you can fit it in 1000 bits.

**(2) Account-cost economics.** `MarketLiquidities` is one account rewritten on every order placement. At ~50 bytes per `MarketOutcomePriceLiquidity`:

- 30-cap: ~3 KB account → rent ~0.03 SOL (~$5 per market created)
- 1000-cap: ~100 KB account → rent ~0.7 SOL (~$100 per market created)

For sportsbooks creating thousands of markets per day (every match, every quarter, every race), the 30× rent multiplier is prohibitive. 30 is sized for that economics.

**(3) Product domain.** Monaco's design partner is BetDEX — a sports betting exchange. Liquidity in sports concentrates around fair value; tail liquidity is rare. The 30-cap is over-provisioned for typical sports usage; it exists to prevent abuse, not because it's a tight binding constraint.

### What this tells us

**Monaco's `MarketLiquidities` is a product-domain artifact, not an engineering compromise.** Their 30-cap is correct for sportsbook UX. Replacing it for Sooth isn't fixing a bug — it's removing a feature that fits their domain to install one that fits ours.

---

## §3. Three options for handling 1000 ticks in a Monaco fork

### Option α — Raise `LIQUIDITIES_VEC_LENGTH` to 1000

**Change**: one constant.

**Cost**: account size grows from ~3 KB to ~100 KB per market. Within Solana's 10 MB account limit, fine. Binary search across 1000 entries: ~10 comparisons, negligible CU.

**Real cost**: **Sealevel write-lock contention**. Every order placement reads/writes this 100 KB account. Monaco's per-pool sharding model (which is otherwise the killer feature) is partly defeated because `MarketLiquidities` becomes a per-market hotspot.

**Verdict**: simplest patch but worst for parallelism. Acceptable only for low-volume markets.

### Option β — Replace sorted Vec with a Sooth-style 1000-bit tick bitmap

**Change**: port `TickBitmap` (16 × `u64` = 128 bytes) into the fork. Best-price discovery becomes `u64::leading_zeros()` (1 CU per word, max 16 words to scan) instead of binary search.

**Cost**: account stays small (128 bytes for the bitmap, plus auxiliary metadata). ~200-400 LOC of Rust. Refactoring `MarketMatchingPool` lookups to consult the bitmap before loading pool PDAs.

**Tricky bit**: every place in Monaco's matching engine that today calls `liquidities.find_best_price()` or iterates the liquidity Vec needs updating to query the bitmap and derive the corresponding `MarketMatchingPool` PDA seed. From the verified Monaco source structure, this is non-trivial — it likely touches `instructions/order_*.rs` and `instructions/match_*.rs` extensively.

**Verdict**: the architecturally correct answer if Sooth's tick semantics are load-bearing. **This is the recommended path** if Monaco's call-site count for the assumption "small liquidities Vec" is bounded.

### Option γ — Quantize Sooth's 1000 ticks to 30

**Change**: in the Solana adapter, round integrator-supplied `tick: number` to one of 30 effective levels (every ~33 ticks rounds together).

**Cost**: zero engineering cost on the program side. SDK adapter handles rounding.

**Verdict**: cheap to ship; loses price granularity. Probably unacceptable for a prediction market that wants 0.1% probability resolution. Only viable as a v1 stopgap with an explicit roadmap to Option β. Per integrator contract §6, the SDK would need to surface `actualTick` on the receipt so consumers can detect rounding.

---

## §4. What else needs to be added on top of Monaco

These are Sooth-specific features Monaco doesn't have. **None affect SDK-level compatibility** — all are net-internal to the forked program + the Solana adapter.

### A. Complete-set `mint` and `merge`

Monaco doesn't have YES + NO complete-set semantics — it just has FOR/AGAINST orders against an outcome.

Sooth needs:

```rust
sooth_book::mint(market, amount)   // burn USDC, mint amount of YES + amount of NO
sooth_book::merge(market, amount)  // burn YES + NO, return USDC
```

**SDK impact**: zero. Already part of the `ChainAdapter` interface; adapter wires through.

### B. Surplus mechanic when `yesTick + noTick > 1000`

When a YES buy at tick 600 crosses a NO buy at tick 500 (sum = 1100), the 100-tick surplus is paid out as a complete-set mint distributed to one or both parties (logic in `OrderEngine.fillOrder`).

In a Monaco fork, the `match_orders` instruction needs to detect surplus and atomically issue the complete-set mint as part of the same TX. Monaco's matching pool shard model **supports this** because the matcher already loads both sides' pools; it just needs to compute surplus and CPI into a `mint_complete_set` instruction.

**SDK impact**: zero. `Fill` event shape already includes `surplus`; the adapter normalizes Monaco's settlement events.

### C. `escrow=true` flag (atomic complete-set debit)

Per [`docs/decision-log.md` D2](../decision-log.md), this is the load-bearing SDK invariant. Monaco doesn't have it natively. **Unlike Phoenix and OpenBook, we control the fork**, so we add an `escrow` boolean to the `Order` PDA and `create_order` instruction.

Atomicity is preserved because the order placement, opposite-side debit, and any subsequent matching all run inside our fork's instructions — same TX, same atomic boundary.

**SDK impact**: zero. `buildSoothBookBuyRequest({ escrow: true })` works identically.

### D. Adjudicator integration

Monaco settlement currently expects an authority pubkey. Sooth replaces this with the `IAdjudicator`-equivalent program (zkTLS, Manual, etc.). The fork adds an `adjudicator: Pubkey` field to Monaco's `Market` and replaces direct authority checks with CPIs to the adjudicator program's `attest`/`settle` instructions.

**SDK impact**: zero. Adapter calls the adjudicator program when needed.

### E. Per-order PDA rent disclosure

Monaco creates one `Order` PDA per active order (~0.0015 SOL rent). EVM SoothBook stores orders inline in tick arrays — no rent. This is a UX disclosure issue, not a contract change.

**SDK impact**: surface as part of the trade-cost preflight (`PreflightResult.feeUsd`).

---

## §5. Net engineering budget

Revised from earlier estimates after the 60-cap finding:

| Component                                              | Original "fork Monaco" estimate | Revised after 60-cap finding                          |
| ------------------------------------------------------ | ------------------------------- | ----------------------------------------------------- |
| `MarketLiquidities` price index replacement (Option β) | not accounted for               | **~200-400 LOC + refactor cascade through 3-4 files** |
| Complete-set `mint` / `merge` instructions             | ~200 LOC                        | ~200 LOC                                              |
| Surplus mechanic in `match_orders`                     | ~150 LOC                        | ~150 LOC                                              |
| `escrow` flag on Order PDA + `create_order`            | ~200 LOC                        | ~200 LOC                                              |
| Adjudicator CPI integration                            | ~150 LOC                        | ~150 LOC                                              |
| Sub-total Rust additions                               | ~700 LOC                        | **~900-1,100 LOC**                                    |
| SDK adapter (Solana side)                              | ~400 LOC (thin)                 | ~400 LOC (thin)                                       |
| Total Solana-side LOC                                  | ~1,100                          | **~1,300-1,500**                                      |

For comparison:

- **Custom build** (Option 2 in survey): ~2,100 LOC + 6-12 months + fresh audit
- **Monaco fork (revised)**: ~1,300-1,500 LOC + 3-5 months + delta audit on top of Monaco's existing audit

Fork still wins, but the gap narrows. The "70-80% engine reuse" claim from the early framing was too optimistic; it's closer to **50-60% reuse** once you account for the price-index replacement cascading through matching engine call sites.

---

## §6. Investigation week protocol

Per [`orderbook-survey.md §10`](../research/orderbook-survey.md) and [`docs/decision-log.md` P1](../decision-log.md), a focused investigation week should validate fork viability before commitment. Specifically:

### Week 1 — Code reading

1. Clone `MonacoProtocol/protocol` at `develop` head.
2. Read `programs/monaco_protocol/src/state/` end-to-end (~10 files).
3. Read `programs/monaco_protocol/src/instructions/` (~30 files), focused on `create_order`, `cancel_order`, `match_orders`, `settle_market`.
4. Read `programs/monaco_protocol/src/lib.rs` to see the full instruction surface.
5. Track every call site that:
   - Uses `liquidities.find_best_price()` or iterates `liquidities_for/against`
   - Asserts `liquidities.len() < 100` or implicitly assumes small Vec sizes
   - Touches `MarketMatchingPool` PDA derivation

### Decision criteria

| Call sites assuming small liquidities Vec | Recommendation                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <5 sites                                  | **Fork wins.** Bitmap replacement is contained. ~3 months to ship.                                                                                                        |
| 5-20 sites                                | **Fork still wins, marginally.** Plan for 1 extra month of refactor.                                                                                                      |
| >20 sites                                 | **Custom build is cleaner.** The fork is fighting Monaco's assumptions in too many places to be worth it. Default to Option 2 (build from Monaco/Manifest/Drift lessons). |

### Secondary questions to answer in the week

1. Does Monaco's `Market` account have any other sportsbook-specific assumption that would surprise us in a prediction-market context? (e.g. multi-outcome support, in-play config, point spreads — all of which we don't need)
2. How does Monaco handle market dismissal / refund? Sooth has a creator-dismiss path during trial period; Monaco may need new instructions.
3. What's Monaco's event emission strategy? Does it map cleanly to Sooth's `OrderPlaced` / `OrderFilled` / `Minted` / `Merged` shapes?
4. License audit: confirm no GPL/LGPL transitive deps in Monaco's `Cargo.toml`.

---

## §7. Recommendation

**Fork Monaco, with Option β (1000-tick bitmap replacement) as the price-index strategy.** This is the highest-leverage path given Sooth's constraints, but only if the investigation week confirms <20 call sites need touching.

If the call-site count exceeds 20, **switch to custom build (Option 2)** — at that point Monaco's design assumptions are too pervasive to be worth the inheritance cost, and starting fresh with Monaco's _patterns_ (per-price PDA sharding, FIFO matching, lifecycle states) is cleaner than fighting Monaco's _implementation_.

**SDK contract is preserved in either case.** The integrator contract's 35 frozen symbols don't care which path is chosen. This decision is internal to `sooth-core-solana`.

---

## §8. Decision dependencies

This analysis blocks/depends on:

- **[P1 — orderbook backend choice](../decision-log.md)**: this doc is the primary input
- **[P2 — LMSR CU spike](../decision-log.md)**: orderbook decision is moot if AMM doesn't fit; LMSR spike should run in parallel with the Monaco investigation week
- **[P4 — escrow usage analytics](../decision-log.md)**: if escrow turns out to be unused, Phoenix becomes viable and this entire analysis is moot

---

_Last updated: 2026-05-05._
