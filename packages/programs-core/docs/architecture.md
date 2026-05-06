# Sooth on Solana — Architecture Mapping

> Reference doc for porting Sooth Protocol (v0.1.2 / v0.2.0 sooth-core) to Solana.
> Status: design exploration. No code committed. Updated 2026-05-05.

This document maps every EVM concept in `packages/contracts-core` onto a Solana-native equivalent (Anchor program + PDA layout) and flags the technical risks that need a prototype before committing.

---

## 0. TL;DR

- **Not a port — a rewrite.** Solidity → Rust/Anchor. ABIs → IDLs. Storage slots → PDAs. ERC20 → SPL Token (or Token-2022).
- **Programs**: 5 (vs 8 EVM contracts). Some EVM "contracts" collapse into Anchor instructions on a shared program.
- **Hardest unknowns**:
  1. LMSR `exp`/`ln` under Solana's compute-unit (CU) budget.
  2. CLOB choice: build a Solana-native `SoothBook` vs integrate Phoenix / OpenBook v2.
  3. zkTLS attestation — Primus has no first-class Solana support.
  4. **SDK boundary**: does the existing `@sooth/sdk` public surface absorb Solana's race/retry/account-enumeration semantics without app-code changes? See `../../sdk-solana/docs/implementation-guide.md`.
- **What's easier on Solana**: orderbook matching (cheap CU, fast finality), parallel market trades (Sealevel), token mint authority (Token-2022 extensions).
- **What's harder**: per-user state (account rent, account size), stateful CPI choreography, no events-as-source-of-truth (logs are best-effort).

---

## 1. Program Layout (5 programs)

| EVM Contract                               | Solana Program / Module                                     | Rationale                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `LaunchpadEngine.sol`                      | `sooth_launchpad` program                                   | Market factory. Owns market PDAs and creator deposits.                                                                                         |
| `AMMEngine.sol`                            | `sooth_amm` program                                         | LMSR math, position storage, lock-on-sell. Heavy CU consumer; isolating it lets us version it independently.                                   |
| `OrderEngine.sol` + `TruthMarket.sol`      | `sooth_market` program                                      | Market lifecycle + custody + mint/merge/redeem. EVM split was for upgradability; on Solana we get program upgrades natively, so collapse them. |
| `SoothBook.sol`                            | `sooth_book` program **OR** Phoenix integration             | See §6. Native CLOBs already exist on Solana — strongly consider not rebuilding.                                                               |
| `FeeRouter.sol`                            | Module inside `sooth_launchpad`                             | FeeRouter has no upgrade story or external callers; it's a pure splitter. CPIs add CU overhead, so inline it.                                  |
| `AdjudicatorRegistry.sol` + `IAdjudicator` | `sooth_adjudicator` program (interface) + per-type programs | Each adjudicator type is its own program (mock, manual, zkTLS-when-available). The registry becomes a small lookup PDA in `sooth_launchpad`.   |
| `LaunchpadLPToken.sol`                     | SPL Mint owned by `sooth_launchpad` PDA                     | LP shares = SPL token. Free transferability for LP tokens.                                                                                     |
| `BaseToken` (MockUSDC)                     | USDC SPL mint (`EPjFW...`) on mainnet, devnet faucet USDC   | No need for our own mock; use real USDC.                                                                                                       |

---

## 2. Account / State Mapping

EVM uses contract storage slots keyed by `mapping(address => ...)`. Solana stores state in accounts owned by a program, addressed by PDAs. Every per-user, per-market record is a separate account that someone must pay rent on.

### 2.1 Global / Singleton State

| EVM (storage on `LaunchpadEngine`)            | Solana                                                         | PDA seeds                    |
| --------------------------------------------- | -------------------------------------------------------------- | ---------------------------- |
| `owner`, `defaultTrialPeriod`, fee bps config | `Config` account (singleton)                                   | `[b"config"]`                |
| `markets` (array of created markets)          | Off-chain index (RPC `getProgramAccounts`) + optional registry | n/a — don't iterate on-chain |
| `adjudicatorRegistry` mapping                 | `AdjudicatorEntry` accounts, one per registered type           | `[b"adj", type_id]`          |

### 2.2 Per-Market State

EVM puts everything on the `TruthMarket` clone + slots in `AMMEngine` / `OrderEngine` keyed by market address. On Solana, split by access pattern (avoid huge accounts that everyone writes to):

| Account              | Owner program        | Seeds                      | Holds                                                                                                             |
| -------------------- | -------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `Market`             | `sooth_market`       | `[b"market", market_id]`   | question hash, deadline, startTime, adjudicator pubkey, lifecycle state (Live/Resolved/Attested/Settled), outcome |
| `AmmState`           | `sooth_amm`          | `[b"amm", market_id]`      | `qYes`, `qNo`, `b`, `seedQYes`, `seedQNo`, fee accumulators, `isGraduated`, `trialEndTime`                        |
| `MarketVault` (USDC) | SPL Token (PDA auth) | `[b"vault", market_id]`    | All collateral for this market (single ATA owned by market PDA)                                                   |
| `YesMint` / `NoMint` | SPL Token            | `[b"mint", market_id, b"y" | b"n"]`                                                                                                            | YES / NO outcome token mints; mint authority = market PDA |
| `LpMint`             | SPL Token            | `[b"lp", market_id]`       | Launchpad LP token mint                                                                                           |
| `BookState`          | `sooth_book`         | `[b"book", market_id]`     | Tick bitmap, sequencer cursor, fee state. Order data lives in tick PDAs (see §6).                                 |

`market_id` = first 16 bytes of `keccak256(question || creator || nonce)` — keeps PDAs short and deterministic.

### 2.3 Per-User-Per-Market State

| EVM                                               | Solana                                          | Seeds                               |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| `Position { yesShares, noShares }` mapping        | `Position` account                              | `[b"pos", market_id, user_pubkey]`  |
| AMM lock queue (`lockedAt`, `unlockAt`, balances) | `LockEntry` accounts (one per sell)             | `[b"lock", market_id, user, nonce]` |
| Open CLOB orders (`UserOrders[]`)                 | `UserBook` account (compact list, swap-and-pop) | `[b"userbook", market_id, user]`    |

**Rent implication**: every (user, market) pair the user touches costs ~0.002 SOL rent for `Position`. Either the user pays (UX friction) or the protocol subsidizes via a treasury PDA. Token-2022 has account-compression options worth investigating for `LockEntry` and `UserBook`.

### 2.4 What we lose: cheap iteration

- EVM: `getMarkets()` → returns array. On Solana there is no equivalent — clients use `getProgramAccounts` filtered by discriminator + market_id, or rely on the indexer (Helius, Triton, our own).
- Implication: indexer becomes load-bearing for the markets-list page. Plan for this.

---

## 3. Type Mapping

| EVM type                | Solana (Anchor)                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `address`               | `Pubkey` (32 bytes)                                                                                        |
| `uint256`               | `u128` (sufficient for our caps) or `[u64; 4]` only where needed                                           |
| `int256` (signed delta) | `i128`                                                                                                     |
| `uint64` deadline       | `i64` Unix seconds (Solana `Clock::unix_timestamp` is `i64`)                                               |
| `bytes32` hash          | `[u8; 32]`                                                                                                 |
| `keccak256`             | `solana_program::keccak::hash` (available, but `hashv` of `sha256` is cheaper if we re-derive market keys) |
| `mapping(K => V)`       | PDA-per-key; no native maps                                                                                |
| `event X(...)`          | `emit!` macro (best-effort, NOT durable — clients must subscribe live or via indexer)                      |
| Custom errors           | `#[error_code]` enum                                                                                       |

### 3.1 WAD math → fixed-point on Solana

EVM uses 1e18 WAD throughout. On Solana, the cheapest stable choice is to keep WAD math (`u128` holds WAD comfortably for all values < 3.4e20) so we don't re-derive formulas. But:

- `LMSRMath` on EVM uses `PRBMath` (`exp`/`ln` in fixed-point). No drop-in Rust equivalent that's CU-cheap.
- Candidates: `fixed` crate, `spl-math`, hand-rolled Taylor + range-reduction tables.
- **Risk**: a single `tradePositions` may need 2 `exp` + 2 `ln` calls. Naïve impls run 100k+ CU. The default tx CU limit is 200k; max is 1.4M. **Must prototype.**

USDC↔WAD conversion (`_wadToUsdc` / `_usdcToWad`) is identical on Solana — same 1e12 scalar (USDC is 6 decimals on Solana mainnet too).

---

## 4. Call-Chain Translation

### 4.1 Market Creation

**EVM**:

```
LaunchpadEngine.createMarket(question, startTime, deadline, adjudicator, bBase, p, adjConfig)
  → deploy TruthMarket clone
  → AMMEngine.initializeMarket(...)
  → IAdjudicator(adjudicator).configureMarket(market, config)
  → BaseToken.transferFrom(creator, this, deposit)
```

**Solana** — implemented as **four** sequential instructions (lifecycle in
parens after each step):

```
ix1: sooth_market::initialize_market         (Initializing — Market PDA only)
  args: { market_id, question_hash, start_time, deadline, adjudicator }
  body:
    - init Market PDA at [b"market", market_id]; record creator + lifecycle = Initializing.

ix2: sooth_market::initialize_outcome_mints  (Initializing)
  body:
    - init yes_mint and no_mint SPL Mints (mint authority = vault_authority PDA).

ix3: sooth_market::initialize_market_vaults  (Initializing → Open)
  accounts: [market, vault_authority, lock_authority, usdc_mint, vault, lock_vault, …]
  body:
    - init `vault` ATA (owner = vault_authority, mint = USDC).
    - init `lock_vault` ATA (owner = lock_authority, mint = USDC).
    - flip lifecycle Initializing → Open.
    - usdc_mint is pinned to USDC_MINT_DEVNET (H1 in security review).

ix4: sooth_amm::initialize_amm_state         (Open — trade-ready)
  args: { initial_b, trial_end_at }
  body:
    - init AmmState PDA at [b"amm", market_id]; q_yes/q_no = 0; b = initial_b.
    - require initial_b > 0 and initial_b ≤ i128::MAX (M1 in security review).
```

Notes:

- The split into four instructions is **not** a design preference but a hard
  requirement of Anchor 0.30.1's `try_accounts` codegen on BPF: with every
  `Account<'info, T>` boxed, four SPL inits in one ix overflow the SBF
  4 KB stack frame (~6 KB observed with mints + ATAs together; ~5.4 KB with
  mints alone; ~4 KB with ATAs alone). Discovered during the SDK adapter
  smoke-test work — see `programs-core/README.md` "Build commands". When
  Anchor or SBF stack ceiling changes, these can collapse back down.
- A market in `Initializing` lifecycle is partially set up but **not**
  tradeable: `trade_positions` requires `market.is_open()` and the
  AmmState PDA, neither of which is true until ix3+ix4 complete.
- All four instructions are typically batched into one transaction by the
  SDK's `buildCreateMarket` — but split-tx submission is also valid as
  long as ix4 lands before any `trade_positions` call.

### 4.2 AMM Trade (buyYes)

**EVM**:

```
AMMEngine.tradePositions(market, 1, +Δ, maxCost)
  → LMSR cost = C(q+Δ) - C(q)
  → FeeRouter.split(cost)
  → BaseToken.transferFrom(user, AMM, cost+fee)
  → position.yesShares += Δ
  → if pre-graduation: mint LP tokens 1:1
```

**Solana**:

```
ix: sooth_amm::trade_positions
  accounts: [market, amm_state, position PDA (init_if_needed), user_usdc_ata, market_vault, lp_mint, user_lp_ata (init_if_needed), fee_destinations, user, token]
  args: { outcome: u8, delta_shares: i128, max_cost_wad: u128 }
  body:
    - require market.is_open()
    - require market.start_time ≤ now < market.deadline   (C1 in security review)
    - require delta_shares > 0                            (H4: sell hard-error)
    - cost_wad = LMSR.cost(amm_state, outcome, delta) // ⚠ CU hotspot
    - fee_wad = fee_router::split(cost_wad, amm_state.is_graduated)
    - require cost_wad + fee_wad ≤ max_cost_wad
    - cost_usdc = wad_to_usdc_ceil(cost_wad + fee_wad)
    - CPI token::transfer(user_ata → vault, cost_usdc)
    - position.yes_shares += delta
    - amm_state.q_yes += delta
    - if !is_graduated: CPI mint_to(lp_mint → user_lp_ata, lp_amount)
    - emit!(PositionTraded { ... })
```

**Prerequisite**: `initialize_amm_state` (§4.1 ix4) must have run for this
market before any `trade_positions` call. Until that ix runs, the AmmState
PDA does not exist and the trade fails at account-load time
(`AccountNotInitialized`). The market must additionally be in `Open`
lifecycle (ix3 of §4.1 sets this).

**Compute budget**: target ≤ 200k CU per trade. If LMSR alone eats 150k+, we'll need `ComputeBudgetInstruction::set_compute_unit_limit(400_000)` on every trade — workable but raises priority fee cost.

### 4.3 Sell with Lock-on-Sell

EVM stores locks inline on the position. On Solana, a per-sell `LockEntry` account is cleaner:

```
ix: sooth_amm::trade_positions (delta < 0)
  → proceeds_wad = LMSR.proceeds(...)
  → CPI token::transfer(vault → lock_vault PDA, proceeds_usdc)
  → init LockEntry PDA { user, market, amount, unlock_at = now + 24h }

ix: sooth_amm::claim_unlocked
  accounts: [lock_entry, user_usdc_ata, lock_vault]
  → require now ≥ unlock_at
  → CPI token::transfer(lock_vault → user_ata)
  → close lock_entry (rent refunded to user)
```

Tradeoff: more accounts, but rent is recoverable on `claim`. Alternative: keep a fixed-size ring buffer in `Position` — fewer accounts but bounded queue depth.

### 4.4 Settlement (Multi-phase Adjudicator)

EVM lifecycle: `configureMarket → resolve → attest → settle` with `dispute` veto branch.

Solana — same lifecycle, each step is a CPI from `sooth_market` ↔ adjudicator program:

```
ix: adjudicator::resolve(market, outcome, data_hash, t_star)
  → guarded by adjudicator's resolver pubkey (set in config)
  → CPI sooth_market::set_state(Resolved)

ix: adjudicator::attest(market, proof)
  → verify proof (zkTLS — see §7)
  → CPI sooth_market::set_state(Attested)

ix: anyone::settle(market)
  → require Market.state == Attested
  → require now ≥ attested_at + veto_window
  → CPI sooth_market::set_state(Settled)

ix: guardian::dispute(market)
  → only during veto_window
  → CPI sooth_market::set_state(Live)  // resets
```

Cross-program invocation depth on Solana is capped at 4. Our chain (user → market → adjudicator → market) is depth 3 — fine.

### 4.5 Redemption

```
ix: sooth_market::redeem
  accounts: [market, position, vault, user_usdc_ata, yes_mint OR no_mint]
  body:
    - require market.state == Settled
    - winning_shares = if outcome == YES { position.yes_shares } else { position.no_shares }
    - payout_usdc = wad_to_usdc_floor(winning_shares)
    - CPI token::transfer(vault → user_ata, payout_usdc)
    - zero out the redeemed side of position
```

LP redemption (`redeemLP`) follows the same pattern against `LpMint` supply share.

---

## 5. AMM Engine — CU Budget Deep Dive

This is the riskiest piece. Numbers below are estimates; actual prototype required.

| Op                             | Estimated CU | Notes                                                |
| ------------------------------ | ------------ | ---------------------------------------------------- |
| `exp(x)` Taylor + range red.   | 30k–80k      | Depends on precision (WAD = 18 decimals → ~10 terms) |
| `ln(x)` similar                | 30k–80k      |                                                      |
| One full `cost(q+Δ) - cost(q)` | 80k–200k     | 2× exp + 1× ln + adds                                |
| Anchor account loads (5–8)     | 5k–10k       |                                                      |
| 2× SPL `token::transfer` CPI   | 10k–14k      | (token program is ~5–7k each)                        |
| Fee router math (no exp/ln)    | <5k          |                                                      |
| **Trade total (worst case)**   | **~250k**    | Above default 200k — set CU limit explicitly         |

Mitigations if we blow budget:

1. **Approximation tables**: pre-computed `exp`/`ln` lookup with linear interp. ~5x faster, ~1e-6 precision (acceptable since our cost rounds to USDC anyway).
2. **Crank pattern**: split cost calc into two TXs (compute in tx1, settle in tx2). Hurts UX.
3. **Drop to pure constant-product (xy=k)** for AMM, keep LMSR only conceptually. Major design change.

**Action item**: Week-1 prototype = `LMSRMath` Rust port + Anvil-equivalent benchmark on `solana-test-validator`.

---

## 6. CLOB — Build vs Integrate

We have three options for `SoothBook` on Solana:

### Option A — Port SoothBook to Anchor (`sooth_book` program)

- Tick bitmap → on-chain `BookState.bitmap: [u64; 16]` (1024 ticks fits)
- Per-tick PDA `[b"tick", market_id, tick]` holding orders deque
- 4 atomics (`buyYes`, `buyNo`, `mint`, `merge`) → 4 instructions
- **Pro**: full control, identical UX, integrates with our adjudicator/lifecycle
- **Con**: orderbook engineering is non-trivial; lots of edge cases (matching, partial fills, gas/CU per match), already solved by Phoenix/OpenBook

### Option B — Integrate Phoenix

- Phoenix is a non-custodial CLOB on Solana, used by Ellipsis Labs
- Each (market, outcome) becomes a Phoenix market YES/USDC and NO/USDC
- We'd act as the "matchmaker" via CPIs
- **Pro**: battle-tested, ultra-fast matching (~1k CU per match)
- **Con**: external dependency, our YES/NO mints must conform to Phoenix's listing requirements, fee structure not ours, can't enforce 4-atomic invariant cross-market

### Option C — Integrate OpenBook v2

- Similar to Phoenix, more permissive listing
- Larger ecosystem (Jupiter routes through it)
- **Pro**: composability with broader Solana DeFi
- **Con**: same as Phoenix re: invariants

**Recommendation**: ship v1 with **Option A (port SoothBook)** for design coherence, but design `BookState` so that future markets can be flagged "external book" pointing at a Phoenix market id. Hybrid path.

Option 1 (port SoothBook with client-driven matching) is the only path that preserves the SDK's `escrow=true` atomicity. See `../../sdk-solana/docs/implementation-guide.md §6` for the SDK-level reasoning.

---

## 7. Adjudicator on Solana

EVM uses `IAdjudicator` interface + `ZkTLSAdjudicator` backed by Primus's on-chain verifier (`PrimusZKTLS` proxy at `0xc3E3...` on Base Sepolia).

### Status of zkTLS on Solana

- **Primus**: no Solana program as of 2026-05. EVM-only.
- **Reclaim Protocol**: has a Solana SDK (`@reclaimprotocol/solana-sdk`) — could substitute.
- **Manual / mock**: `ManualAdjudicator` ports trivially as `sooth_manual_adjudicator` program (resolver pubkey gated `resolve` instruction).

### Phased plan

1. **v1 Solana**: ship with `ManualAdjudicator` only (parity with how we shipped EVM Manual first).
2. **v2 Solana**: integrate Reclaim or wait for Primus Solana support. Adjudicator interface (instruction signatures) is the same; only the verifier program changes.

`AdjudicatorRegistry` becomes a small PDA per registered adjudicator program-id, stored in `sooth_launchpad`.

---

## 8. Fee Router

EVM: 4-way split `bBase 50% / LP 30% / adjudicator 10% / protocol 10%`.

Solana implementation:

- Inline as a function inside `sooth_amm::trade_positions` (no CPI overhead)
- Destinations are 4 ATAs passed by client:
  - `amm_state.b_base` accumulator (incremented in-place on `AmmState`)
  - `lp_yield_vault` ATA
  - `adjudicator_fee_vault` ATA (read from `Market.adjudicator_fee_dest`)
  - `protocol_treasury_vault` ATA
- LP minting on pre-graduation trades is part of the same instruction — no separate CPI needed since we own `LpMint`'s authority.

---

## 9. Trial Period & Dismiss

EVM stores `trialEndTimes[market]` per market, set at `createMarket`:

```
trialDuration = min(0.3 × (deadline - now), defaultTrialPeriod)
```

Solana: identical formula, stored on `AmmState.trial_end_at: i64`. `dismiss_market` instruction guards:

1. `Clock::unix_timestamp >= amm_state.trial_end_at`
2. `!amm_state.is_graduated`
3. `!amm_state.is_dismissed`
4. `signer == market.creator`

`claim_refund` walks `Position` and refunds the locked cost, then closes the position account.

---

## 10. Frontend / SDK Mapping

| EVM stack                              | Solana stack                                                |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| `viem` / `wagmi`                       | `@solana/web3.js` + `@coral-xyz/anchor`                     |
| MetaMask / Privy                       | Wallet Adapter (Phantom, Solflare, Backpack) + Privy Solana |
| ABIs                                   | Anchor IDLs (`target/idl/*.json`)                           |
| `useReadContract`                      | `program.account.X.fetch(pda)` + React Query                |
| `useWriteContract`                     | `program.methods.X(...).accounts({...}).rpc()`              |
| Indexer (Ponder, Postgres)             | Helius webhooks → Postgres, or Triton, or our own Geyser    |
| `registry/nodes.json` (chain manifest) | Same idea: `{ cluster: "devnet"                             | "mainnet-beta", program_ids: {...} }` |

The `@sooth/sdk` package would gain a `solana/` subpath:

```
packages/sdk/
  src/
    evm/         # current code, untouched
    solana/      # new
      programs/  # generated from Anchor IDLs
      hooks/     # React hooks mirroring EVM API surface
      math/      # WAD math (shared with evm via core/)
    core/        # shared formulas (LMSR closed-form, fee splits)
```

Demo app (`apps/demo`) wraps a chain selector that swaps the active SDK adapter — same UI, two backends. Telegram app (`apps/telegram`) gets Phantom Mobile deeplink support alongside MetaMask.

---

## 11. Repo Layout (proposed)

```
sooth-alpha/
├── packages/
│   ├── contracts-core/         # EVM (existing)
│   └── programs-core/          # NEW: Solana programs
│       ├── Anchor.toml
│       ├── Cargo.toml          # workspace
│       ├── programs/
│       │   ├── sooth_launchpad/
│       │   ├── sooth_amm/
│       │   ├── sooth_market/
│       │   ├── sooth_book/
│       │   └── sooth_manual_adjudicator/
│       ├── tests/              # mocha + Anchor (TS)
│       └── target/idl/         # IDLs for SDK
└── solana/
    ├── architecture.md           # this doc
    ├── prototypes/              # CU benchmarks, LMSR math experiments
    └── deployments.json         # cluster → program IDs (mirrors registry/nodes.json)
```

---

## 12. Open Questions

1. **Compute budget for LMSR**: prototype required before any further design. Single most important unknown.
2. **Account rent model**: who pays for `Position` PDAs? Subsidize from treasury, or charge users (~$0.30 SOL at $150/SOL)?
3. **CLOB**: Option A (port) vs Option B/C (Phoenix/OpenBook) — depends on whether we want Jupiter routing.
4. **zkTLS**: ship v1 with ManualAdjudicator and revisit when Primus adds Solana, or commit to Reclaim now?
5. **Indexer**: Helius webhook → existing Ponder Postgres, or run Geyser ourselves?
6. **Multi-chain UX**: does the demo app surface "Solana node" as a peer to "Base Sepolia node" in the existing node-picker, or is Solana a separate app?
7. **LP token transferability**: SPL by default. Do we want it that way (better composability) or do we want to gate transfers like ERC20 with hooks? Token-2022 transfer hooks could enforce this.
8. **Token-2022 vs classic SPL**: Token-2022 supports useful extensions (transfer hooks, confidential transfers, metadata pointer) but has CPI overhead and ecosystem gaps (some wallets/DEXes still flaky).

---

## 13. Recommended Next Steps

1. **Spike (1 week)**: `programs-core/programs/sooth_amm` skeleton + `LMSRMath` Rust port. Benchmark `trade_positions` on `solana-test-validator`. Decision gate: ≤300k CU per trade or we redesign.
2. **Spike (3 days)**: stand up Phoenix devnet market for a YES/USDC pair. Measure end-to-end UX cost vs option A.
3. **Spec (1 week)**: write `solana/v1-spec.md` with frozen account layouts, instruction signatures, and security invariants — analogous to our EVM contracts spec.
4. **Decision**: based on (1) and (2), commit to either "full port" or "hybrid (Phoenix-backed CLOB)".

---

_Last updated: 2026-05-05. Source-of-truth EVM contracts: `packages/contracts-core/src/` (sooth-core v0.1.2 / v0.2.0)._
