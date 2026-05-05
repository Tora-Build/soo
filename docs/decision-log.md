# Decision Log — Sooth Solana Spec Suite

> Append-only record of decisions resolved during spec design, plus open questions blocking implementation.
> Convention: each entry is dated; supersedes older entries on the same topic; never delete.

---

## Resolved

### D1. SDK compatibility means _third-party integrator_ surface, not just monorepo apps (2026-05-05)

**Decision**: SDK compatibility is defined as: code written against `@sooth/sdk` runs unchanged on EVM and Solana deployments. The audience is external developers (frontends, bots, aggregators), not just our own apps.

**Why**: Through the design discussion the requirement sharpened from "our apps continue working" to "external developers ship a Solana frontend with the same effort as an EVM one." This is stricter and is what determines ecosystem viability.

**Implication**: The canonical contract is [`sdk-solana/docs/integrator-contract.md`](../packages/sdk-solana/docs/integrator-contract.md). The implementation guide ([`implementation-guide.md`](../packages/sdk-solana/docs/implementation-guide.md)) defers to it.

### D2. Escrow atomicity is a hard SDK invariant (2026-05-05)

**Decision**: `placeOrder({ escrow: true })` MUST produce an atomic outcome on every supported chain. This is non-negotiable.

**Why**: SoothBook's `escrow=true` flag (debit opposite-side shares → match → credit on cancel/dust) is atomic on EVM today. Non-atomic escrow on Solana would silently break consumer code that built features on the atomicity guarantee. Per the integrator contract, hidden semantic differences are disqualifying.

**Implication**: Phoenix and OpenBook v2 integrations are **disqualified** as Solana orderbook backends — neither can deliver atomic escrow without multi-transaction sequences. Only options that preserve atomicity remain viable: custom-built `sooth_book` program, or a Monaco Protocol fork with escrow added as a first-class field.

### D3. Sooth Solana ships as a single monorepo, separate from `sooth-alpha` (2026-05-05; superseded earlier per-product extraction discussion)

**Decision**: All Solana code and specs live in a separate repo `Tora-Build/sooth-solana`, organized as a monorepo with two workspace packages: `packages/programs-core/` (Anchor programs in Rust) and `packages/sdk-solana/` (TypeScript SDK adapter, published as `@sooth/sdk-solana`). Cross-cutting materials (decision log, glossary, research) live in `docs/` at the repo root. **No Solana code or specs in `sooth-alpha`.**

**Why**:

- Symmetric to `sooth-alpha`'s monorepo (multiple related packages under `packages/`); same mental model, no extra topology to learn.
- Cross-cutting changes between the program and the adapter stay atomic (one PR, one CI pipeline).
- `sooth-alpha` contributors stay EVM-focused; `sooth-solana` contributors can be Solana-focused. No implicit cross-stack tax.
- Audit, license, and ecosystem-operator scoping become trivial.

**Link to `sooth-alpha`**: only via the published npm package `@sooth/sdk-solana`, dynamically imported by the umbrella `@sooth/sdk` (in `sooth-alpha/packages/sdk`) when the active node is Solana. No git submodules, no shared workspace, no source coupling.

**Implication**:

- The `solana/` directory in `sooth-alpha` is the **init structure** for the new repo; once `Tora-Build/sooth-solana` is created and populated, this directory is deleted from `sooth-alpha` and replaced with a one-line pointer file.
- The integrator contract (`packages/sdk-solana/docs/integrator-contract.md`) §4.1 is updated: integrators install `@sooth/sdk` (always) and `@sooth/sdk-solana` (when targeting Solana, as an optional peer dep). Dynamic import keeps the loading transparent.
- This supersedes earlier framing that suggested keeping both products in `sooth-alpha/packages/`.

### D4. LMSR fits within Solana's CU budget; proceed with exact-math `sooth_amm` (2026-05-05; resolves P2)

**Decision**: `sooth_amm::trade_positions` will be implemented in production with the Taylor-series exact `exp`/`ln` math at WAD precision (no LUT, no crank, no constant-product fallback).

**Why**: Spike prototype `_spikes/lmsr-cu/` (bare `solana-program` 1.18, log-sum-exp shifted Taylor series, hand-rolled u256 wad ops) ran on `solana-program-test` (BanksClient) across 8 representative cases. Peak 55,467 CU on the imbalanced-10× case; 42–49k CU on the typical band; 32,768 CU on the 100× tail (log-sum-exp pushes the smaller exp arg below the saturation clamp, returning 0 without running Taylor). 5–9× headroom against the 300k typical / 500k tail targets from `programs-core/docs/architecture.md §5`.

**Implication**:

- Production `trade_positions` envelope projected at ≈75–80k CU including 2× SPL token CPI, account validation, and fee-router CPI — under the 200k default per-instruction CU limit, so callers do **not** need to attach `ComputeBudgetInstruction::set_compute_unit_limit` on every trade. Document this in the SDK adapter's submit path.
- Variant B (precomputed exp/ln lookup tables) is not needed and is dropped from the architecture spec's mitigation list. It can return as a future escape hatch if the production envelope drifts above 150k CU after fee-router and adjudicator CPI are wired in.
- The crank-pattern mitigation (split cost calc into two TXs) and the LMSR-replacement mitigation (constant-product AMM) are both moot. `programs-core/docs/architecture.md §5` should be edited to reflect this when the architecture doc gets its next pass.
- This unblocks `sooth_amm` as the first production program in the implementation sequence (per `HANDOVER.md` "Sequencing for actual implementation").

**Spike artifact**: `_spikes/lmsr-cu/` (Cargo workspace-private; bench reproducible via `cargo build-sbf && cargo test-sbf -- --nocapture`). Cargo.lock pinned because three transitive deps had to be downgraded to escape edition2024 dependencies that platform-tools v1.51's cargo 1.84.0 rejects — note for whoever ports the math into `sooth_amm`.

### D5. Atomic escrow is structurally load-bearing in production; D2 stands (2026-05-05; resolves P4)

**Decision**: `escrow=true` is not a user-toggled feature — it is the only way the production telegram app expresses limit sells on SoothBook. The Solana orderbook MUST preserve atomic escrow. This re-confirms D2.

**Why**: Reading the EVM SDK source (no Postgres query needed). Two pieces of code make the answer structural rather than statistical:

- `sooth-alpha/packages/sdk/src/core/contracts/soothCore.ts:934–965` — `buildSoothBookSellRequest` returns a tuple typed as `readonly [...,  true, bigint]`. The 4th argument (the SoothBook `escrow` flag) is a literal `true` in the **return type**, not a parameter. There is no runtime path where this helper produces an order with `escrow: false`.
- `sooth-alpha/apps/telegram/core/hooks/useOrderbookPlace.ts:181–197` — the telegram app's only orderbook entry point. Limit BUY → `buildSoothBookBuyRequest({ ..., escrow: false })`. Limit SELL → `buildSoothBookSellRequest(...)` (which is forced-true per above).

The SoothBook crossing rule (commented at `soothCore.ts:943–951`) explains why: "sell YES at tick T" is modeled as an escrow buy on the NO side at tick `1000 - T`. The escrow flag is what tells the contract to debit the user's opposite-side shares as collateral instead of pulling USDC. Without atomic escrow, the sell flow does not exist.

**Implication**:

- The "what % of trades use escrow" question reduces to "what % of SoothBook orders are sells" — structurally ~50% by symmetry, with the actual ratio bounded by user behavior, not by feature adoption.
- Phoenix and OpenBook v2 remain disqualified per D2. A non-atomic escrow path would silently break every limit sell in the telegram app, not just an opt-in feature.
- Combined with the P1 investigation result, the orderbook direction is effectively decided modulo founder approval: **fork Monaco** with escrow added as a first-class field, per the insertion point already scoped in `docs/research/monaco-investigation-week-01.md` (~200 LOC in `process_order_request` + `MarketPosition` accounting). The atomicity caveat noted in the spike-2 report — verify the Monaco queue step doesn't break atomicity — is now load-bearing and must be resolved before any sell flow ships on Solana.
- For the indexer, the schema column already exists (`packages/indexer/ponder.schema.ts:202` — `escrow: boolean NOT NULL` on the `order` table). When the Solana adapter writes order events, it must populate the same column to preserve query parity with EVM.

---

## Pending — block implementation

### P1. Is the orderbook backend custom-built or a Monaco fork?

**Decision needed**: choose between (a) custom Anchor program built from scratch with Sooth's exact tick model, or (b) fork Monaco Protocol (Apache-2.0) and add the missing primitives (complete-set mint/merge, surplus mechanic, escrow flag, adjudicator integration, 1000-tick price indexing).

**Trade-offs**:

- Custom build: ~6 months engineering, fresh audit, exact fit to Sooth semantics, full design freedom
- Monaco fork: ~3-4 months engineering (with the bitmap-replacement work captured in [`./monaco-fork-analysis.md`](./monaco-fork-analysis.md)), reuses tested matching engine and lifecycle states, but inherits sportsbook-shaped assumptions that need replacing in 3-4 places (especially `MarketLiquidities` 60-cap → 1000-tick bitmap)

**Gates**: investigation week reading `programs/monaco_protocol/src` end-to-end. Specifically: how many call sites assume `liquidities.len() < 100`? <5 → fork wins; >20 → custom build is cleaner.

**Investigation result (2026-05-05)**: see [`./research/monaco-investigation-week-01.md`](./research/monaco-investigation-week-01.md) for the full report against Monaco v0.15.5 (`96d4d79`).

- **Hard-rewrite sites: 2** — `LIQUIDITIES_VEC_LENGTH = 30` const at `state/market_liquidities.rs:22` and the `is_full()` comparison at `:412–415`. Account-space `SIZE` const cascades automatically. Plus 3 SOFT sites for CU re-validation.
- **Total touched sites: 5–7** — well below the 20-site fork-cliff threshold.
- **Refines the prior 60-cap framing in [`./monaco-fork-analysis.md`](./monaco-fork-analysis.md)**: the 30 is a per-side liquidity-density cap, not a price-ladder cap. Monaco's default price ladder is 317 prices (`state/price_ladder.rs:4`). More importantly, `MATCH_CAPACITY = 10` at `instructions/matching/on_order_creation.rs:13` caps per-order matching to 10 fills regardless of liquidity vec depth — so lifting the vec from 30 to 1000 does **not** cascade into matching-engine CU blow-up. The price-index lift is orthogonal to matching cost.
- **Lifecycle**: Monaco's `Initializing → Open → Locked → ReadyForSettlement → Settled` maps cleanly to Sooth's; only the authority-gate model needs swapping for adjudicator CPI (~150 LOC).
- **Outcome model**: Sooth's binary outcome is a strict subset of Monaco's n-way; disabling cross-matching removes ~300–500 LOC of dead code (net simplification).
- **Escrow flag**: natural insertion point in `process_order_request` + `MarketPosition` accounting (~200 LOC). Caveat: verify the queue step in `process_order_request` does not break atomicity — must be re-checked before D2 is honored end-to-end.
- **Engineering estimate**: 3–4 months, ~1,000–1,300 net Rust LOC (lower than the prior 1,300–1,500 estimate).
- **Recommendation: fork.** Confidence medium-high. Confidence raises to high after a CU bench on `solana-test-validator` with a populated 1000-entry `MarketLiquidities` confirming the outcome-filter scan in `match_for_order`/`match_against_order` (`on_order_creation.rs:37–44`, `:171–185`) stays under 400k CU per typical trade. Decidable in week 1 of fork work.

**Status**: open pending founder approval of the fork direction. Engineering has a clear recommendation (fork) but the months commitment and audit-scope choice belong to the founder.

### P2. Does LMSR fit within Solana's CU budget? — **RESOLVED, see D4**

Resolved 2026-05-05. Spike `_spikes/lmsr-cu/` shows peak 55k CU vs 300k typical / 500k tail targets — 5–9× headroom. Variant A (Taylor exact) sufficient; LUT and crank mitigations dropped. See D4 above for the binding decision and implications.

### P3. Indexer namespace strategy: widen `chainId` or namespace Solana to integers?

**Decision needed**: choose between (a) widen `SoothNode.chainId` from `number` to `number | string` and `chainId` Postgres column from `integer` to `text`, or (b) allocate Solana namespace integers (e.g. 900 = mainnet-beta, 901 = devnet — convention used by some bridges).

**Trade-offs**:

- (a) Cleaner type model; one-shot Postgres migration; downstream queries comparing `chainId == 84532` need updating
- (b) No type widening; cosmetically wrong (Solana doesn't have a numeric chain ID); zero-migration

**Recommendation in implementation guide**: (a). One PR; the union is more honest about the underlying reality.

**Status**: open. Either path works; needs explicit choice before the registry-api worker is updated.

### P4. Is `escrow=true` actually used in production? — **RESOLVED, see D5**

Resolved 2026-05-05 from EVM SDK source reading (no Postgres query needed). `buildSoothBookSellRequest` (`sooth-alpha/packages/sdk/src/core/contracts/soothCore.ts:937,963`) hardcodes `escrow: true` as a literal in its return type — every limit sell in the telegram app routes through the escrow path by construction. D2 stands; Phoenix/OpenBook remain disqualified. See D5 above for the binding decision.

### P5. What's the acceptance threshold for race-induced retries on Solana?

**Decision needed**: target retry rate for `placeOrder` on Solana when client-driven matching is used.

**Suggested target**: <5% retry rate at p50 trade volume.

**Mitigations if higher**: Jito bundles for atomic read+write; tighter compute-unit limit per ix to land in earlier slots; book-state caching to reduce read-write window.

**Status**: open. Cannot be validated until devnet deployment exists.

### P6. Wallet UX: does Privy support Solana well enough for Telegram in 2026-05?

**Decision needed**: evaluate Privy's Solana support for the `apps/telegram` integration. If insufficient, fall back to Solana Wallet Adapter (Phantom/Solflare/Backpack).

**Status**: open. Spike: 1 day to evaluate Privy Solana SDK against current `apps/telegram` Privy integration.

### P7. Pricing model on Solana: who pays priority fees?

**Decision needed**: should users pay all transaction fees (parity with EVM), or should the protocol subsidize via priority-fee budget?

**Trade-offs**:

- User pays: simpler accounting; consistent with EVM model
- Protocol subsidizes: better UX (no SOL on user's wallet needed for fees); requires treasury operation

**Status**: open. Affects `submit()` semantics in the adapter.

### P8. Does `cli/` get a Solana port?

**Decision needed**: should the multi-actor CLI test harness (`packages/sdk/src/cli/`) be ported to Solana, or stay EVM-only?

**Recommendation in implementation guide**: stay EVM-only for v1. Build a thin parity test in `tests/` that exercises the Solana adapter through the same SDK API.

**Status**: open but low-priority. Can be deferred until after Solana is shipping.

---

## Closed without a decision

### CN1. Whether to write `solana/soothbook-automatch-evaluation.md` as a separate doc

The auto-match SDK incompatibility was thoroughly analyzed in conversation; the conclusions live in [`programs-core/docs/architecture.md §6`](../packages/programs-core/docs/architecture.md), [`research/orderbook-survey.md`](./research/orderbook-survey.md), and [`./monaco-fork-analysis.md`](./monaco-fork-analysis.md). A standalone doc would duplicate.

---

_Last updated: 2026-05-05 (D4 resolved P2; D5 resolved P4; P1 has investigation results — recommendation: fork Monaco, awaiting founder approval)._
