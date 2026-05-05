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

---

## Pending — block implementation

### P1. Is the orderbook backend custom-built or a Monaco fork?

**Decision needed**: choose between (a) custom Anchor program built from scratch with Sooth's exact tick model, or (b) fork Monaco Protocol (Apache-2.0) and add the missing primitives (complete-set mint/merge, surplus mechanic, escrow flag, adjudicator integration, 1000-tick price indexing).

**Trade-offs**:

- Custom build: ~6 months engineering, fresh audit, exact fit to Sooth semantics, full design freedom
- Monaco fork: ~3-4 months engineering (with the bitmap-replacement work captured in [`./monaco-fork-analysis.md`](./monaco-fork-analysis.md)), reuses tested matching engine and lifecycle states, but inherits sportsbook-shaped assumptions that need replacing in 3-4 places (especially `MarketLiquidities` 60-cap → 1000-tick bitmap)

**Gates**: investigation week reading `programs/monaco_protocol/src` end-to-end. Specifically: how many call sites assume `liquidities.len() < 100`? <5 → fork wins; >20 → custom build is cleaner.

**Status**: open. Requires founder-level decision after investigation week. See [`./monaco-fork-analysis.md §6`](./monaco-fork-analysis.md) for the recommended evaluation protocol.

### P2. Does LMSR fit within Solana's CU budget?

**Decision needed**: confirm `sooth_amm::trade_positions` runs within Solana's CU budget (target ≤300k CU per trade).

**Mitigations if it doesn't**:

1. Approximation tables for `exp`/`ln` (~5x faster, ~1e-6 precision)
2. Crank pattern (split cost calc into two TXs — hurts UX)
3. Drop LMSR for constant-product AMM (major design change)

**Gates**: 1-week Rust prototype + benchmark on `solana-test-validator`. Documented in [`programs-core/docs/architecture.md §5`](../packages/programs-core/docs/architecture.md) and [`§13`](../packages/programs-core/docs/architecture.md).

**Status**: open. This is the single most important technical unknown for the entire Solana port.

### P3. Indexer namespace strategy: widen `chainId` or namespace Solana to integers?

**Decision needed**: choose between (a) widen `SoothNode.chainId` from `number` to `number | string` and `chainId` Postgres column from `integer` to `text`, or (b) allocate Solana namespace integers (e.g. 900 = mainnet-beta, 901 = devnet — convention used by some bridges).

**Trade-offs**:

- (a) Cleaner type model; one-shot Postgres migration; downstream queries comparing `chainId == 84532` need updating
- (b) No type widening; cosmetically wrong (Solana doesn't have a numeric chain ID); zero-migration

**Recommendation in implementation guide**: (a). One PR; the union is more honest about the underlying reality.

**Status**: open. Either path works; needs explicit choice before the registry-api worker is updated.

### P4. Is `escrow=true` actually used in production?

**Decision needed**: pull telegram app analytics — what percentage of orderbook trades use `escrow: true`?

**Why this matters**: If escrow usage is <5%, removing the feature in v1 of Solana support becomes feasible, which would unlock Phoenix/OpenBook integration as alternatives. If it's >20%, escrow is load-bearing and the Solana orderbook MUST preserve it (locking us into custom build or Monaco fork).

**Status**: open. Analytics expected to live with the indexer or Privy.

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

_Last updated: 2026-05-05._
