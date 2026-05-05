# Solana Orderbook Implementations — Survey

> Status: research notes from background subagent investigation, 2026-05-05.
> Methodology: primary sources where available (GitHub repos, official docs, technical posts). Where only secondary sources existed, that's noted.

This survey informed the orderbook decision in [`programs-core/docs/architecture.md §6`](../../packages/programs-core/docs/architecture.md). It catalogues 10 production Solana orderbook implementations across spot, perps, sports, and prediction-market verticals to determine which patterns are battle-tested and which would map to Sooth's needs.

---

## Per-protocol summary

### 1. Phoenix (Ellipsis Labs)

- **Status (2026-05)**: Phoenix Legacy spot in maintenance mode (~$1.9M TVL, 7d volume down 28%). Team pivoted to Phoenix Perpetuals (private beta).
- **Pattern**: Fully on-chain CLOB, **crankless** (matching synchronous in place-order ix).
- **Account model**: Single market account with custom slab-allocated B-tree-like structure. Markets capped at 100-level bid/ask depth.
- **Distinctive choice**: Crankless — settlement happens atomically in the same instruction as the trade.
- **Open source**: Yes, public. Last release v0.1.1 Feb 2023; only ~31 commits. **Effectively frozen.**
- **Lessons for Sooth**: Crankless atomic-settlement pattern maps cleanly to Sooth's `escrow=true` requirement. The frozen-fork risk is real — if you fork Phoenix v1, you're forking abandonware.

### 2. OpenBook v2

- **Status (2026-05)**: Live, de-facto Serum v3 successor. Last release v0.2.10 (June 2024), 1264 commits — actively maintained.
- **Pattern**: Hybrid — on-chain CLOB with **event heap** decoupling matching from settlement.
- **Account model**: Separate accounts for `bids`, `asks`, `event heap`. Carries forward Serum's split-account model with rent optimizations.
- **Distinctive choice**: Zero-fee, unmonetized public-good protocol; frontends layer their own fees.
- **Open source**: Mixed — most MIT, program code GPL-gated via `enable-gpl` feature flag. **Forking the program means GPL.**
- **Lessons for Sooth**: Event heap is wrong fit for Sooth's atomic escrow — you want settlement and matching in the same TX, not deferred. GPL contamination is a serious concern.

### 3. Drift Protocol

- **Status (2026-05)**: Largest perps DEX on Solana pre-exploit (~$550M TVL, $150B cumulative volume). **Hit by $285M North Korean exploit Apr 1 2026**, in recovery with $150M Tether-led bailout.
- **Pattern**: Hybrid 4-way liquidity routing — JIT auction (5s Dutch), DLOB resting limit orders matched off-chain, vAMM as backstop, external CLOBs for spot.
- **Account model**: Orders live **off-chain** in a keeper-network DLOB. On-chain stores user accounts, market accounts, vault accounts. Keepers submit fills on-chain.
- **Distinctive choice**: **JIT auction** — 5-second Dutch auction at order placement, compensating for Solana's lack of mempool. Most directly applicable single idea for Sooth's surplus mechanic.
- **Open source**: Yes, public.
- **Lessons for Sooth**: JIT auction model is conceptually applicable to surplus capture (`yesTick + noTick > 1000` — "found money"). Off-chain keeper DLOB trades censorship resistance for performance — prediction markets historically resist that trade.

### 4. Hxro Network (Dexterity + Parimutuel)

- **Status (2026-05)**: Live but low activity ($168 24h token volume).
- **Pattern**: Two protocols. Dexterity = CLOB + portfolio margin. Parimutuel = pool-based, pro-rata payoff for dual-outcome markets.
- **Account model**: Dexterity uses on-chain matching. Parimutuel uses pooled accounts per discrete time window — no orderbook.
- **Distinctive choice**: Parimutuel-as-primitive — discrete time windows + dual outcome + oracle-driven settlement as a Solana program any frontend can build on.
- **Open source**: Public GitHub at github.com/Hxro-Network — license per-repo varies.
- **Lessons for Sooth**: Parimutuel model is **NOT** what Sooth wants (Sooth is LMSR + CLOB hybrid with continuous trading). But the "primitive protocol + frontends build on it" pattern matches Sooth (multiple frontends — demo, market, telegram).

### 5. Zeta Markets

- **Status (2026-05)**: **Discontinued.** Replaced by **Bullet** — purpose-built L2 for trading with claimed 3-5ms latency / 10k TPS.
- **Pattern (historical)**: Fully on-chain CLOB for options/perps with universal margin engine.
- **Lessons for Sooth**: The pivot Zeta → Bullet (Solana mainnet → custom L2) tells us even a well-funded options CLOB found Solana mainnet's account-model + CU constraints prohibitive at scale. Doesn't apply to Sooth's prediction-market scale.

### 6. Mango Markets v4

- **Status (2026-05)**: **Shut down January 2025** — SEC settlement, governance dispute, $9M January 2025 hack. v4 wound down completely.
- **Pattern (historical)**: Used OpenBook v2 as CLOB backend; Mango was the cross-margin perp/spot layer on top.
- **Lessons for Sooth**: Mango proved the "use a separate CLOB program via CPI" pattern works at scale ($28B cumulative volume). For Sooth, this argues for **CPI integration** — IF you can find a CLOB whose semantics match (which is the open question, blocked by escrow atomicity per [`../decision-log.md` D2](../decision-log.md)).

### 7. Jupiter Limit Orders / DCA / Polymarket

- **Status (2026-05)**: Live, very high volume. **Polymarket-on-Solana via Jupiter** launched Feb 1 2026 — 473 live Solana prediction markets as of April 2026, with $35M Jupiter investment.
- **Pattern**: Off-chain matching + on-chain escrow + keeper network. Funds in per-order escrow PDA; keepers monitor prices via Jupiter Price API + Birdeye and atomically execute when triggered.
- **Account model**: Trivial — one escrow account per order. No orderbook data structure.
- **Distinctive choice**: Sidesteps the orderbook problem entirely. Acceptable because Jupiter has the deepest aggregator routing on Solana.
- **Lessons for Sooth**: **For prediction markets specifically, Polymarket-via-Jupiter is now your direct competitor on Solana.** Architecturally it's CTF-on-Ethereum bridged via Jupiter UI — they're not running a Solana-native orderbook. **A Solana-native CLOB with prediction-market semantics is an unfilled niche.**

### 8. Monaco Protocol (BetDEX)

- **Status (2026-05)**: Live, actively maintained. Last release v0.15.5 Dec 2024, 244 commits on develop. Apache-2.0 licensed. ~$8M total matched volume historically (modest).
- **Pattern**: Fully on-chain orderbook + matching, FIFO best-price execution, partial matching, "smart risk management" (unmatched risk recycled into new orders).
- **Account model — most directly relevant for Sooth**:
  - `Market` account: metadata, lifecycle (Initializing → Open → Locked → ReadyForSettlement → Settled), `market_outcomes_count`, `market_winning_outcome_index`, in-play config
  - `Order` account: per-order PDA holding `purchaser`, `market_outcome_index`, `for_outcome` (FOR/AGAINST boolean), `stake`, `expected_price`, `payout`, `order_status`, `creation_timestamp`
  - `MarketMatchingPool` account per `(market, outcome, price, for/against)`: contains a **`Cirque` (circular queue) of order PDAs**. Default capacity 50.
- **Distinctive choice**: **One `MarketMatchingPool` per (outcome × price × side)** — shards the orderbook into many small per-price-level accounts, solving Solana's account-list constraint.
- **Open source**: Apache-2.0 — **most permissive license of any project surveyed.**
- **Lessons for Sooth**: **The single closest existing implementation to what Sooth needs.** Binary outcome with FOR/AGAINST encoding maps almost 1:1 to YES/NO. Per-price-level matching pool accounts solve the account-list problem. FIFO best-price matches Sooth's intended semantics. Lifecycle states map directly. **What Monaco does NOT have natively**: complete-set mint/merge atomicity (escrow=true), the surplus mechanic, custom adjudicator integration, **and 1000-tick price indexing (caps at 30 per side; see [`../monaco-fork-analysis.md`](../monaco-fork-analysis.md))**.

### 9. Polymarket on Solana

- **Status (2026-05)**: As above (item 7) — exists as Polymarket UX delivered via Jupiter integration; not a Solana-native orderbook.

### 10. Manifest (CKS Systems)

- **Status (2026-05)**: Live, actively maintained. 585 commits, latest release April 2026. GPL-3.0.
- **Pattern**: Fully on-chain CLOB. Third-generation design specifically intended to fix Phoenix/OpenBook limitations.
- **Account model — genuinely novel design**: **HyperTree.** All orderbook data fits into uniform 80-byte graph nodes interleaved within a single market account's dynamic byte array. Bids, asks, claimed seats, free list all share the same node space. Solves "you must declare all space upfront on Solana."
- **Distinctive choices**: HyperTree; **Global Orders** — single capital pool can back multiple simultaneous bids/offers across markets (rehypothecation without oracle dependency); ~1000× cheaper market creation (~0.004 SOL rent vs Serum/Phoenix); core+wrapper architecture for formal verification.
- **Open source**: GPL-3.0 — **same caveat as OpenBook (GPL contamination on fork).**
- **Lessons for Sooth**: HyperTree is the most architecturally interesting answer to Solana's account-model constraints. **Global Orders** is conceptually adjacent to Sooth's "complete set escrow." Cheap market creation matches Sooth's permissionless market-creation requirement. **GPL license is a hard blocker for forking.**

---

## Synthesis

### Dominant patterns (what "everyone" does)

1. **Off-chain matching + on-chain settlement is winning by adoption.** Drift (largest perps), Jupiter (largest aggregator), Polymarket-on-Solana (largest prediction-market UX) all use it. Solana's account-list constraint genuinely makes pure on-chain matching painful at scale.
2. **Per-price-level account sharding is the standard solution when you do go on-chain.** Monaco's `MarketMatchingPool` per `(outcome × price × side)` is the cleanest example. Phoenix's bounded-depth slab and OpenBook's separate bid/ask/event-heap accounts are variations on the same theme.
3. **GPL is the de-facto license for orderbook programs** (OpenBook, Manifest). Phoenix v1 (frozen) and Monaco are the permissive exceptions.
4. **Cranked / event-queue settlement is being abandoned.** Phoenix went crankless 2022, Manifest is crankless, Monaco does atomic settlement. Only OpenBook v2 still has cranks, and that's a Serum legacy concession.

### Novel patterns (2025-2026)

1. **Manifest's HyperTree** — uniform node-size interleaved data structures sharing one account.
2. **Manifest's Global Orders** — capital rehypothecation across markets without oracle dependency.
3. **Drift's JIT auction** — Dutch auction inside a 5-second window to compensate for Solana's lack of mempool.
4. **Polymarket-via-Jupiter** — bridging an existing prediction-market CTF (on Ethereum) into a Solana UX without porting the engine.

### Top 3 ranked options for Sooth

Given Sooth's specific requirements (atomic complete-set escrow on `escrow=true`, surplus mechanic when `yesTick + noTick > 1000`, custom adjudicator integration, prediction-market lifecycle, **1000-tick price grid**):

#### #1 — Fork Monaco Protocol

Apache-2.0 license (no GPL contamination), already a binary-outcome FOR/AGAINST orderbook with FIFO best-price matching, per-`(outcome × price × side)` sharded matching pools that solve the account-list problem, lifecycle states that map directly to Sooth.

**What you'd add**: complete-set mint/merge instructions, surplus mechanic (likely a new instruction detecting `yesTick + noTick >= 1000` and atomically minting a complete set against the surplus), adjudicator-based settlement to replace Monaco's oracle-driven settlement, **and a 1000-tick price index to replace Monaco's 60-cap `MarketLiquidities` Vec (see [`../monaco-fork-analysis.md`](../monaco-fork-analysis.md))**.

This is the highest-leverage choice for matching engine reuse, but the price-index replacement is more invasive than initially estimated.

#### #2 — Build from scratch using lessons from Monaco + Manifest + Drift

Take Monaco's per-price-level matching pool sharding, Manifest's market-creation cost discipline (~0.004 SOL/market), Drift's JIT auction as the surplus-capture mechanism. Apache-2.0/MIT freedom and a design tailored to Sooth's exact mechanics, but at the cost of 6-12 months of engineering and a fresh audit.

**Choose this if**: Monaco's account model proves too rigid for Sooth's surplus mechanic (validate during investigation week), OR if you want a clean license story for ecosystem operators.

#### #3 — CPI integrate against Manifest or OpenBook v2 + build Sooth-specific escrow program on top (Mango pattern)

You write the prediction-market lifecycle, complete-set escrow, and adjudicator integration as a separate Sooth program, and CPI into a battle-tested CLOB for matching.

**The blocker**: the surplus mechanic is fundamentally tied to YES/NO outcome semantics, and a generic CLOB doesn't know about that. Plus escrow atomicity (D2 in decision log) **disqualifies Phoenix and OpenBook** for Sooth. **Effectively non-viable** unless we drop both escrow atomicity and the surplus mechanic — neither of which is on the table.

---

## Sources

- [GitHub — Ellipsis-Labs/phoenix-v1](https://github.com/Ellipsis-Labs/phoenix-v1)
- [Ellipsis Labs — Phoenix Perpetuals announcement](https://www.ellipsislabs.xyz/blog-posts/introducing-phoenix-perpetuals)
- [Phoenix on Solana Compass](https://solanacompass.com/projects/phoenix)
- [GitHub — openbook-dex/openbook-v2](https://github.com/openbook-dex/openbook-v2)
- [OpenBook v2 deep wiki](https://deepwiki.com/openbook-dex/openbook-v2)
- [Drift docs — orderbook & matching](https://docs.drift.trade/developers/market-makers/orderbook-and-matching)
- [Drift hybrid liquidity post](https://www.drift.trade/updates/hybrid-liquidity-mechanism)
- [Drift docs — decentralized orderbook](https://docs.drift.trade/about-v2/decentralized-orderbook)
- [Inside Drift — architecture deep dive](https://extremelysunnyyk.medium.com/inside-drift-architecting-a-high-performance-orderbook-on-solana-612a98b8ac17)
- [Drift recovery coverage 2026](https://cryptoadventure.com/drift-protocol-review-2026-solana-perps-margin-design-and-real-liquidity-conditions/)
- [Hxro Network docs — betting](https://docs.hxro.network/hxro-network/market-protocols/betting)
- [Hxro Network on Quicknode](https://www.quicknode.com/builders-guide/tools/hxro-network-by-hxro-labs)
- [Hxro GitHub](https://github.com/Hxro-Network)
- [Zeta X litepaper](https://docs.zeta.markets/zeta-x/zeta-x-litepaper/introduction)
- [Mango v4 monorepo](https://github.com/blockworks-foundation/mango-v4)
- [Mango Markets shutdown — The Block](https://www.theblock.co/post/334172/mango-markets-to-wind-down-in-wake-of-sec-settlement-dao-battle)
- [Jupiter brings Polymarket to Solana — DefiRate](https://defirate.com/news/jupiter-brings-polymarket-to-solana-expanding-prediction-markets/)
- [Polymarket exchange upgrade — CoinDesk April 2026](https://www.coindesk.com/markets/2026/04/06/polymarket-reveals-a-full-exchange-upgrade-to-take-control-of-its-own-trading-and-truth)
- [GitHub — MonacoProtocol/protocol](https://github.com/MonacoProtocol/protocol)
- [GitHub — MonacoProtocol/sdk](https://github.com/MonacoProtocol/sdk)
- [Deep dive into Monaco Protocol — Tanishq blog](https://tutorials.hashnode.dev/deep-dive-into-monaco-protocol)
- [BetDEX learn — Monaco Protocol](https://learn.betdex.com/betdex-exchange/whats-betdex-built-on/monaco-protocol)
- [GitHub — CKS-Systems/manifest](https://github.com/CKS-Systems/manifest)
- [Mango founder + CKS Manifest collaboration — The Block](https://www.theblock.co/post/316190/mango-markets-founder-collaborates-on-cks-systemss-solana-based-unlimited-orderbook-manifest)
- [The Orderbook Manifesto PDF](https://www.manifest.trade/assets/The_Orderbook_Manifesto.pdf)
