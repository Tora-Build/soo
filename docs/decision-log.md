# Decision Log — sooth-solana

> The decisions that describe the system as it stands, and the questions still
> open. Entries are dated and numbered; a decision that no longer describes any
> live code is removed rather than kept as history.

---

## Resolved

### D1. SDK compatibility means the third-party integrator surface

**Decision**: code written against the Sooth SDK runs against a Solana
deployment with the same effort as an EVM one. The audience is external
developers — frontends, bots, aggregators — not only our own apps.

**Implication**: the canonical contract is
[`sdk-solana/docs/integrator-contract.md`](../packages/sdk-solana/docs/integrator-contract.md);
the implementation guide defers to it.

### D3. Solana ships as its own repo

**Decision**: all Solana code lives in `Tora-Build/sooth-solana`, a monorepo
with `packages/programs-core/` (Anchor) and `packages/sdk-solana/` (TypeScript),
plus `docs/` for cross-cutting material. No Solana code in `sooth-alpha`.

**Why**: cross-cutting changes between program and adapter stay atomic; audit,
license, and contributor scoping stay simple.

### D4. LMSR runs in exact WAD math (2026-05-05)

**Decision**: LMSR `exp`/`ln` are computed exactly at WAD precision — no lookup
tables, no crank split, no constant-product fallback.

**Why**: measured peak ~55k CU against 300k typical / 500k tail targets, 5–9×
headroom. Lookup-table and crank mitigations were dropped.

### D9. Retry rate is an engineering metric, not a product decision (2026-05-08)

**Decision**: measure race-induced retry rate during devnet validation against a
target below 5%. If it exceeds that, mitigate with tighter compute budgets,
better book-state caching, or bundled read/write paths.

### D10. Solana Wallet Adapter for launch scope (2026-05-08)

**Decision**: stay on `@solana/wallet-adapter-react`. Privy can be reconsidered
if Telegram or mobile integration demands it.

### D11. Users pay Solana priority fees (2026-05-08)

**Decision**: the SDK sets a compute-unit price and the user signs it, matching
the EVM model where users pay transaction costs. `submit()` estimates recent
prioritization fees, caps them, and retains a duplicate-transaction salt.

### D12. No Solana CLI port (2026-05-08)

**Decision**: the multi-actor CLI harness stays EVM-only. The demo, cargo tests,
SDK tests, and the Playwright suite cover the Solana validation surface.

### D14. On-chain order book only

**Decision**: orders rest on-chain. Off-chain signed orders (the EVM "Path B"),
retroactive `T*` settlement, and `invalidate()` parity are out of scope.

**Why**: signed orders need Ed25519 typed-data verification, operator
authorization, and nonce tracking — significant scope for no gain against the
cost target, and the on-chain path already carries the sell flow.

### D18. `attest_outcome` is separate from `settle`, behind a veto window (2026-07-31)

**Decision**: `attest_outcome` records the outcome on `AdjudicatorEntry` and
leaves the market `Locked` for `ProtocolConfig.veto_period_secs`, during which
`dispute` may override it. A separate, **permissionless** `settle` finalizes
afterwards and takes no `winning_outcome` argument — it reads the attested
value. The window is a config field bounded `0 < x <= 30 days`.

**Why**: a `dispute` handler that requires both `is_attested()` and a
not-yet-`Settled` market is unreachable if attestation settles in the same
transaction. Splitting them makes the veto real. This matches EVM, where
`resolve` and a permissionless `settle` sit either side of `vetoEndsAt`.

**Implication**: resolution is two transactions with a wait between them.
Anything that attests and then redeems must call `settle` in between. Zero is
rejected rather than treated as "no window", because an omitted `i64` encodes as
`0`; deployments wanting no delay pass `1`. Seed values: localnet `2s`, devnet
`300s`, mainnet 24h.

### D19. `seed_lp` funds the LMSR subsidy; positions have redeem paths (2026-07-31)

**Decision**: `seed_lp` requires `seed_deposit_wad >= b·ln(2)` and transfers it
from the creator into the market's AMM vault. `redeem_amm_position` pays out AMM
`Position` shares after settlement.

**Why**: LMSR is a *subsidised* market maker — it deliberately collects less
from traders than it owes winners, bounded by `b·ln(2)`, and that difference is
the liquidity it provides. Without the deposit the vault cannot pay winners;
without a redeem path winning AMM positions are stranded at lock. Graduation is
already defined as fees reaching `b·ln(2)`, so the same number funds and repays
the subsidy.

**Implication**: market creation costs real money, scaled by the depth the
creator wants — `b·ln(2)`, so ~693 units at `b=1000` and ~34.7 at `b=50`.
Creation stays permissionless; it is not free. `reclaim_subsidy` returns the
unspent residual after settlement, repeatedly callable because obligations
shrink as traders redeem, and bounded both by the vault residual and by what the
creator actually posted.

### D20. The devnet base token is a project-controlled mock

**Decision**: devnet uses project-controlled mock mints for both venue tokens.
Mainnet uses real Circle USDC for the book venue.

**Why**: Circle's devnet faucet is captcha- and GitHub-auth gated with no
programmatic call, which makes automated demo and e2e funding impossible.

**Note**: `constants.rs` cites this as "decision D19"; the log numbers it D20.

**Implication**: mint authorities live untracked under `apps/demo/.localnet/`.
Losing one means the constant changes and the program is redeployed — the mints
are pinned by `address =` constraints throughout the program, so a mismatch is a
hard transaction failure rather than a UI inconsistency.

### D21. Two venues, two tokens (2026-08-10)

**Decision**: the AMM prices in the deployment's instance token (EAST on
devnet); the order book prices in USDC. Each market holds two vaults, two fee
pools, and two fee rates, and the book is gated closed until the market
graduates.

**Why**: the venues are different games. Bonding is an incubation phase whose
capital should be denominated in the instance's own token; the mature venue
belongs in a stable unit. Gating the book on graduation makes the arc
program-enforced rather than UI convention.

**Implication**: both mints are compile-time constants — the strongest form of
"set once at deployment". One program deployment per instance; two instances
with different AMM tokens are two program IDs. LP yield accrues per market in
separate `lp_yield_amm` and `lp_yield_book` vaults, and `distribute_fees_amm` /
`distribute_fees_book` are separate cranks.

### D22. One program, not six (2026-08)

**Decision**: the protocol is a single Anchor program, `sooth_core`. Lifecycle,
AMM, book, LP/fees, and adjudication are Rust modules calling each other
directly.

**Why**: the six-program split paid a CPI hop and a re-proved account constraint
on every cross-subsystem call, and needed parent-instruction introspection gates
to keep filler-only instructions private. Merging removed that entire class of
machinery along with roughly half the Rust.

**Implication**: no cross-program CPI gates, no `sooth-protocol-types` ID
registry, no per-program IDLs. Self-CPI (`emit_cpi!`) carries durable fill
records, so no separate logging program is needed.

### D23. The book is one account per market on a single price axis

**Decision**: the whole book lives in one dynamically grown, zero-copy account
per market holding both sides plus an internal maker-credit ledger, with NO
orders stored as YES orders at the complementary tick. Ticks are `1..=999`.

**Why**: the account-per-tick model made a fill cost three accounts and required
the client to predict the crossing sequence off-chain and pass maker bundles in.
One account moves matching on-chain, removes address lookup tables, and lifts a
transaction from a handful of fills to several hundred.

**Implication**: capacity is a block cap (4,096) shared between orders and one
seat per seated trader, not a per-tick order cap. Cancelling returns escrow to
the owner's seat credit, withdrawn with `book_withdraw`. Empty seats are
reclaimed. Because the program allocates matching state on the heap, every
transaction must request a 256 KB heap frame.

### D24. The question text goes on-chain with the market

**Decision**: `create_market` takes the question text, verifies it against the
sha256 hash it is submitted with, and emits it in `MarketCreated`. The `Market`
account keeps the hash; the text lives in the event, which is the only place it
exists on chain. The default `market_id` is the first 16 bytes of that hash.

**Why**: a market whose title is only recoverable from an indexer is not
self-describing. Storing it makes cards, portfolios, and page titles work with
zero indexer.

### D25. A market's life can end

**Decision**: after settlement and redemption, `sweep_residual` moves the
remaining dust to the treasury and `close_market` reclaims the rent, leaving an
`MKTCLOSD` tombstone in place of the market account.

**Why**: without a terminal state, every market ever created holds rent forever
and PDAs can be re-initialized into a live-looking account. The tombstone makes
"this market is over" a readable on-chain fact.

---

## Open

- **Guardian allowlist for the veto.** `dispute` is held by a single
  `dispute_authority`. Widening it to a guardian set is unresolved.
- **zkTLS adjudication.** Not implemented; Primus has no first-class Solana
  support. Resolution is the manual adjudicator only.
- **Indexing at production scale.** Frontends read accounts and decode events
  directly. That is adequate at demo scale; a busy market wants Geyser, and the
  boundary has not been drawn.
- **Three-outcome / MAYBE markets.** Not implemented; markets are binary plus
  INVALID.
