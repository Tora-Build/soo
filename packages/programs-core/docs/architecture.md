# Sooth on Solana — Architecture Mapping

> Reference doc for porting Sooth Protocol (v0.1.2 / v0.2.0 sooth-core) to Solana.
> Status: implementation in progress — three Anchor programs scaffolded
> (`sooth_amm`, `sooth_market`, `sooth_launchpad`). Updated 2026-05-07.

This document maps every EVM concept in `packages/contracts-core` onto a Solana-native equivalent (Anchor program + PDA layout) and flags the technical risks that need a prototype before committing.

The "implementation status" annotations in §4-§8 below refer to the actual
state of `packages/programs-core/programs/*` as of the date above. See
`packages/programs-core/README.md` "Programs" table for the per-program
summary; that table and this doc are kept in lock-step.

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

### 4.2 AMM Trade (buy only)

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
  accounts: [market, amm_state, position PDA (init_if_needed),
             vault_authority, user_usdc_ata, market_vault, usdc_mint,
             user, system, token, rent]
  args: { outcome: u8, delta_shares: i128, max_cost_wad: u128 }
  body:
    - require market.is_open()
    - require market.start_time ≤ now < market.deadline   (C1 fix; commit 68b663b)
    - require delta_shares > 0                            (buys only — sells route
                                                           through sell_positions;
                                                           returns SellNotImplemented
                                                           on negative delta)
    - cost_wad = LMSR.cost_delta(amm_state, outcome, delta) // ✓ wired (D4)
    - fee_wad = 0                                          // STUB (see §8)
    - require cost_wad + fee_wad ≤ max_cost_wad           // looser than EVM by fee_wad
    - cost_usdc = wad_to_usdc_ceil(cost_wad)              // ✓ real
    - CPI token::transfer(user_ata → market_vault, cost_usdc) // user-signed
    - amm_state.q_yes/q_no += delta                       // ✓ real
    - position.yes_shares/no_shares += delta              // ✓ real
    - if !is_graduated: STUB — LP mint deferred to sooth_launchpad::seed_lp
    - emit!(PositionTraded { ... })                       // ✓ real
```

**Status**: end-to-end real for the buy path (see
`programs/sooth_amm/src/instructions/trade_positions.rs`). Fee-router CPI
and pre-graduation LP mint are `todo!()` — the slippage check
`cost_wad + fee_wad ≤ max_cost_wad` therefore degenerates to
`cost_wad ≤ max_cost_wad`, which is **looser than the EVM check by exactly
the fee_wad delta**. Tracked gap until the fee router lands in
`sooth_launchpad::distribute_fees` (currently a `todo!()` stub).

**Sells**: `trade_positions` is buy-only by design. `delta_shares > 0` is
required — negative deltas return `SellNotImplemented` to make the SDK's
dispatch error explicit. Sells go through `sooth_amm::sell_positions` (a
sibling ix), which mirrors this account list plus the lock-side accounts.
The split exists because Anchor 0.30.1 evaluates `init` constraints
before the handler runs, so a unified ix would force buyers to pay rent
on a useless `LockEntry` PDA. See §4.3 for the sell flow.

**USDC mint pinning** (H1 fix; commit 68b663b): `usdc_mint` is pinned to
`USDC_MINT_DEVNET` (a `pub const Pubkey` in `sooth_amm::lib.rs`) via an
`address` constraint. The `user_usdc_ata` and `market_vault` ATAs are
then `token::mint = usdc_mint` constrained, so the canonical-USDC chain
is unforgeable from the IDL surface alone.

**Prerequisite**: `initialize_amm_state` (§4.1 ix4) must have run for this
market before any `trade_positions` call. Until that ix runs, the AmmState
PDA does not exist and the trade fails at account-load time
(`AccountNotInitialized`). The market must additionally be in `Open`
lifecycle (ix3 of §4.1 sets this).

**Compute budget** (measured): production `trade_positions` consumes
**~68k–71k CU** per buy on `litesvm` (smoke-test logs in
`packages/sdk-solana/tests/`). This matches the spike's projection
(~75–80k envelope) within rounding and sits well under the 200k default
per-instruction limit — no `ComputeBudgetInstruction::set_compute_unit_limit`
is required on the production trade path. See §5 for the full breakdown.

### 4.3 Sell with Lock-on-Sell

EVM stores locks inline on the position. On Solana, a per-sell `LockEntry`
account is cleaner. The original sketch in this section unified the sell
into `trade_positions`; the implementation splits it into **two**
instructions on `sooth_amm` plus **two** PDA-signing helper ixs on
`sooth_market` (commits abfcf15 + b53715b — the Wave 1A → 1B refactor).

**Why the split:** the `vault_authority` and `lock_authority` PDAs are
both derived under `sooth_market::ID` (set up by
`initialize_market_vaults`), so only `sooth_market` can `invoke_signed`
against them. The original Wave 1A `sell_positions` tried to sign for
`vault_authority` from inside `sooth_amm` and was rejected by the runtime
("Cross-program invocation with unauthorized signer or writable account").
Wave 1B moves the actual transfer into `sooth_market` helpers that
`sooth_amm` CPIs into.

```
ix: sooth_amm::sell_positions
  args: { outcome: u8, delta_shares: i128 (must be < 0), min_proceeds_wad: u128 }
  body:
    - require market.is_open() and start_time ≤ now < deadline
    - require delta_shares < 0
    - cost_wad = LMSR.cost_delta(...)                     // ≤ 0 for sells
    - proceeds_wad = |cost_wad|
    - if min_proceeds_wad > 0: require proceeds_wad ≥ min_proceeds_wad
    - proceeds_usdc = wad_to_usdc_floor(proceeds_wad)     // floor for solvency
    - amm_state.q_yes/q_no += delta                       // ✓
    - position.yes_shares/no_shares += delta              // ✓
    - if proceeds_usdc > 0:
        CPI sooth_market::transfer_to_lock(market_vault → lock_vault, proceeds_usdc)
                                                          // PDA-signed inside sooth_market
    - init LockEntry PDA at [b"lock_entry", position.key(), nonce_le_u64]
        where nonce = position.lock_nonce (pre-increment)
    - position.lock_nonce += 1                            // monotonic counter
    - emit!(PositionSold { ... })

ix: sooth_amm::claim_unlocked
  accounts: [market, position, lock_entry, lock_authority, lock_vault,
             user_usdc_ata, usdc_mint, user (signer), token, sooth_market_program]
  body:
    - require now ≥ lock_entry.unlock_at                 // 24h after sell
    - if amount > 0:
        CPI sooth_market::transfer_from_lock_vault(lock_vault → user_ata, amount)
                                                          // PDA-signed inside sooth_market
    - emit!(LockClaimed { ... })
    - close lock_entry (close = user; rent refund to user)
```

**LockEntry PDA seed scheme** (`programs/sooth_amm/src/state/lock_entry.rs`):
`[b"lock_entry", position.key(), nonce_le_u64]`. The `nonce` is the
per-`Position` monotonic counter `Position::lock_nonce` at sell time;
`sell_positions` increments it post-init so the next sell uses fresh seeds.
The previously-considered `[b"lock", market_id, user, nonce]` was rejected
because `b"lock"` is already used for the `lock_authority` PDA — same
prefix would muddy the seed namespace and make audit grep fragile.
`[b"lock_entry", market_id, user, nonce]` was rejected because it requires
the user to track an out-of-band per-(user, market) counter; reusing the
existing per-(user, market) `Position` PDA's address is shorter and binds
the lock lifecycle to the position lifecycle for free.

**Lock duration**: `LOCK_DURATION_SECS = 86_400` (24h) is hard-coded in
`sooth_amm::lib.rs`. Mirrors every production deploy config in
`packages/contracts-core/config/*.json` on the EVM side. The Solidity AMM
bounds `_lockDuration` to `[30 minutes, 36 hours]`; the Solana port hard-
codes the production value because the AMM doesn't expose a per-deploy
admin key (changing the constant requires a program upgrade anyway). Lift
to `AmmState` if a future deploy needs a different value.

**Auth model on the helpers** (`transfer_to_lock` /
`transfer_from_lock_vault`): three layered gates:

1. **User signature** flows down from the outer `sell_positions` /
   `claim_unlocked` via CPI (`user: Signer` on the helper).
2. **Position/LockEntry shape validation** — the helpers can't type these
   accounts as `Account<'info, Position>` without a circular Cargo dep
   (`sooth_market` → `sooth_amm`), so they parse `owner`, `user`, and
   `market` from raw bytes via offsets shared in the `sooth-account-offsets`
   workspace crate. A compile-time assertion in `sooth_amm` ties those
   offsets back to the live struct's `SPACE` so layout drift trips the
   build (see `packages/programs-core/crates/sooth-account-offsets/`).
3. **Parent-ix introspection** — the `Instructions` sysvar is walked to
   confirm one of the preceding top-level ixs is a `sooth_amm` dispatch
   with the expected discriminator (`sell_positions` or `claim_unlocked`).
   Closes the solvency hole where a direct call to the helper could move
   USDC `vault → lock_vault` without minting a matching `LockEntry` (or
   drain `lock_vault` without closing one). See
   `programs/sooth_market/src/instruction_introspection.rs` for the
   mechanism.

Tradeoff: more accounts (sell now needs the `sooth_market` program +
`Instructions` sysvar in the account list), but rent is recoverable on
`claim`. The alternative — keeping a fixed-size ring buffer in `Position`
— would avoid the per-sell PDA but bounds queue depth and changes the
on-wire `Position` shape, which would re-trigger the offset-sync work
above for any reader of `Position`.

> **Sidebar — Anchor `declare_id!` ergonomics.** Anchor's `declare_id!` macro emits BOTH `pub static ID: Pubkey` AND `pub const ID_CONST: Pubkey`. The `static` cannot be used in const context (e.g., the compile-time `pubkey_eq` asserts that `sooth-protocol-types` uses to hold `sooth_amm` / `sooth_market` IDs in lock-step), but `ID_CONST` can. This is undocumented in Anchor's user docs; it's only visible in `anchor-attribute-account-0.30.1/src/id.rs`'s codegen. Cross-program PDA-signing helpers like the ones above need program IDs at compile time to derive PDAs in `const fn`-style helpers, so the `sooth-protocol-types` crate's pubkey-equality asserts use `crate::ID_CONST` rather than `crate::ID` for that reason. Discovered during the cross-program signing refactor when the natural-looking `assert!(pubkey_eq(crate::ID, …))` failed with "non-const fn in const context".

### 4.4 Settlement (Multi-phase Adjudicator)

EVM lifecycle: `configureMarket → resolve → attest → settle` with
`dispute` veto branch.

Solana — same lifecycle, but the v1 implementation collapses RESOLVING +
ATTESTED into a single `Locked` state on the `Market` PDA (see
`programs/sooth_market/src/state/lifecycle.rs`). The veto window is
folded into `sooth_adjudicator`'s responsibility (program not yet
implemented; the dispute path can be re-introduced as a separate ix later
without bloating the v1 state machine).

```
ix: sooth_market::lock_for_resolution
  accounts: [market, adjudicator (signer)]
  body:
    - require lifecycle == Open
    - LOOSE auth check: signer.key == market.adjudicator    // STUB
    - lifecycle = Locked
    - emit!(MarketLocked { ... })

ix: sooth_market::settle(winning_outcome: u8)
  body:
    - require lifecycle == Locked
    - require winning_outcome ∈ {NO, YES, INVALID}
    - LOOSE auth check: signer.key == market.adjudicator    // STUB
    - lifecycle = Settled, market.winning_outcome = winning_outcome
    - emit!(MarketSettled { ... })
```

**Status**: state mutation real; the adjudicator-CPI auth check is left
as `todo!()` until `sooth_adjudicator` lands. The current implementation
gates on signer-key equality with `market.adjudicator` plus a defense-in-
depth panic if `market.adjudicator == Pubkey::default()`. The production
gate will be either an `Instructions` sysvar introspection check (the
parent ix's `program_id` must equal `market.adjudicator`) or a program-
derived signer with seeds `[b"adj_signer", market_id]` — the choice is
deferred to the `sooth_adjudicator` design.

**Adjudicator allowlist** (commit abfcf15 — Codex C2 mitigation):
`AdjudicatorAllowlist` is a singleton PDA on `sooth_market` (seeds
`[b"adjudicator_allowlist"]`) that gates which pubkeys can be passed as
the `adjudicator` field on `initialize_market`. Capacity 16 entries
(rationale in `state/adjudicator_allowlist.rs`); `add_adjudicator` /
`remove_adjudicator` are gated on `allowlist.authority` (the protocol
multisig). This shrinks the attack surface from "anyone with a keypair"
to "the curated set" pending the full `sooth_adjudicator` program. The
lifecycle ixs (`lock_for_resolution`, `settle`) themselves are unchanged
by the allowlist — it only constrains the **set** of valid adjudicators
at market-creation.

**EVM `invalidate()` fallback**: `TruthMarket.sol:177-189` exposes a
permissionless `invalidate()` callable by anyone after
`deadline + invalidationBuffer` to force the market to SETTLED with
`outcome = INVALID`. The Solana port has not implemented this fallback
(noted as future work in `state/lifecycle.rs`). Cross-link to the
matching gap in §12.

Cross-program invocation depth on Solana is capped at 4. Our chain
(user → market → adjudicator → market) is depth 3 — fine.

### 4.5 Redemption

**Status: STUB.** `sooth_market::redeem` is declared with the full
account list and IDL signature so the SDK can pin its shape early, but
the body is `todo!()`. The Accounts struct is finalized — see
`programs/sooth_market/src/instructions/redeem.rs`.

Spec (mirrors EVM `OrderEngine.settlePosition` / `TruthMarket.getRedemptionValue`):

```
ix: sooth_market::redeem
  accounts: [market, vault_authority, yes_mint, no_mint, vault,
             user_usdc_ata, user_yes_ata, user_no_ata, user (signer), token]
  body:
    - require market.lifecycle == Settled
    - read market.winning_outcome
    - per TruthMarket.getRedemptionValue (TruthMarket.sol:220-231):
        if winning == YES: payout_per_share = WAD if side == YES else 0
        if winning == NO:  payout_per_share = WAD if side == NO  else 0
        if winning == INVALID: payout_per_share = WAD/2 for both sides   // 50:50 split
    - payout_usdc = wad_to_usdc_floor(payout_per_share × shares)
    - burn the redeemed side's outcome tokens from user
    - CPI token::transfer(vault → user_ata, payout_usdc),
      signed by vault_authority PDA
    - emit redemption event
```

Wired-out reasons documented in `redeem.rs`'s module comment: the
redemption flow is gated on `sooth_adjudicator` (so that
`Settled + winning_outcome` are trustworthy) and on `sooth_book`'s
position-credit representation (so that escrow-locked positions
participate identically to AMM-acquired shares). The H1 USDC-mint
constraint will be added at unstub time (see the inline note in
`redeem.rs:58-64`).

LP redemption (`redeemLP`) will follow the same pattern against the
`LpMint` supply share once `sooth_launchpad::seed_lp` lands.

---

## 5. AMM Engine — CU Budget Deep Dive

**Resolved by D4 (`docs/decision-log.md`) via the LMSR CU spike at
`_spikes/lmsr-cu/`.** The Taylor-exact variant (variant A) is fast
enough that the LUT approximation (variant B) was dropped, and no crank
pattern is needed. Numbers below are measured, not estimated.

### Spike (`_spikes/lmsr-cu`) — LMSR math in isolation

`compute_units_consumed` from BanksClient transaction meta, bare
`solana-program` (no Anchor), `cargo test-sbf`:

| case                           | LMSR-only CU |
| ------------------------------ | ------------ |
| cold-start (q=0, buy 1% of b)  | 42,898       |
| small (Δ = 1% of b)            | 44,468       |
| medium (Δ = 10% of b)          | 46,823       |
| large (Δ = 50% of b)           | 48,847       |
| **imbalanced (10× q_no, +1%)** | **55,467**   |
| tail (100× q_no, +1%)          | 32,768       |
| sell (Δ = -10% of b)           | 46,771       |
| two-sided (+5% YES, -5% NO)    | 46,752       |

Peak math cost: **~55k CU** in the imbalanced 10× case; the 100× tail is
cheaper because the smaller side's `exp` argument falls below
`EXP_MAX_INPUT_WAD` and short-circuits to 0.

### Production `sooth_amm::trade_positions` — measured on litesvm

Real ix with Anchor account validation, LMSR `cost_delta`, `spl-token`
transfer CPI, and state mutation. Captured from
`packages/sdk-solana/tests/smoke.test.ts`'s buy ~1% of b transaction:

| ix                         | measured CU |
| -------------------------- | ----------- |
| `initialize_amm_state`     | ~10,013     |
| `trade_positions` (buy 1%) | **~68,300** |
| `sell_positions`           | ~98,500     |
| `claim_unlocked`           | ~24,236     |

Buy envelope ~68k CU is well inside the spike's projection (~75–80k)
and **leaves ~130k CU of headroom under the 200k default per-instruction
limit**. No `ComputeBudgetInstruction::set_compute_unit_limit` is needed
on the production trade path.

### Mitigation tree (kept as documented escape hatches)

Variant A (Taylor exact) is sufficient. The mitigation tree below is
preserved as documentation in case a future Anchor port or new CPI hop
narrows the headroom:

1. **Approximation tables (variant B)** — pre-computed `exp`/`ln` LUTs
   with linear interp. Sketch in `_spikes/lmsr-cu/src/math.rs`.
   Expected ~5x reduction at ~1e-6 relative error (well below USDC
   dust). **Not built; documented escape hatch only.**
2. **Crank pattern** — split cost calc into two TXs. Hurts UX (two
   signatures), uncaps CU per ix. **Not needed.**
3. **Drop LMSR for constant-product (xy=k)** — major economic redesign.
   Last resort. **Not relevant given current measurements.**

---

## 6. CLOB — Build vs Integrate

**Status (P1 investigation complete)**: Monaco fork investigation
finished — see `docs/research/monaco-investigation-week-01.md`.
Recommendation is to **fork Monaco**: ~5 hard-rewrite + 4 soft-rewrite
sites confined to a single state file plus two call sites. Founder
approval still pending; the original three options below are kept as
historical context.

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

### Option D — Fork Monaco (recommended; pending founder approval)

- Monaco Protocol is an Apache-2.0 sports-betting CLOB at
  `github.com/MonacoProtocol/protocol` (v0.15.5 investigated).
- Hard cap is `MarketLiquidities::LIQUIDITIES_VEC_LENGTH = 30` (per side,
  60 total) — would need to be lifted to ~1000 for Sooth's prediction-
  market tick grid. Lift is genuinely orthogonal to the matching loop
  because matching is bounded by a separate `MATCH_CAPACITY = 10`
  constant.
- Per-order CU cost remains bounded after the lift; a CU benchmark on a
  populated 1000-cap account is the remaining open item before commit.
- See `docs/research/monaco-investigation-week-01.md` and
  `docs/monaco-fork-analysis.md` for the source-reading detail.

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

**Status (architecture vs implementation reconciliation)**: the fee
router lives in `sooth_launchpad`, **not inlined inside
`sooth_amm::trade_positions`** as the original sketch implied. See the
program ownership table in `packages/programs-core/README.md` ("Programs"
table). Rationale: `sooth_launchpad` already owns `ProtocolConfig` (the
bps splits + treasury pubkey) and the LP-mint authority — colocating the
distributor with the source-of-truth config keeps the CPI surface
narrower than threading `ProtocolConfig` through every `trade_positions`
call. CPI overhead is negligible at ~5–7k CU per hop.

`sooth_launchpad::distribute_fees` is currently a **`todo!()` stub**
with the Accounts struct committed for IDL stability. Until it lands:

- `sooth_amm::trade_positions` treats `fee_wad = 0` (see §4.2).
- The slippage check `cost_wad + fee_wad ≤ max_cost_wad` therefore
  degenerates to `cost_wad ≤ max_cost_wad`, which is **looser than the
  EVM check by exactly the fee_wad delta**. The SDK's `max_cost_wad`
  already reserves headroom; the gap is on-chain enforcement, not
  client-side intent.
- The 4-way bps split is drained from the fee accumulator on `AmmState`
  by the future `distribute_fees` ix; per-trade emission is unchanged.

Once wired, destinations:

- `amm_state.b_base` accumulator (incremented in-place on `AmmState`)
- `lp_yield_vault` ATA
- `adjudicator_fee_vault` ATA (read from `Market.adjudicator_fee_dest`)
- `protocol_treasury_vault` ATA

LP minting on pre-graduation trades is hoisted to its own
`sooth_launchpad::seed_lp` ix (also `todo!()`), not inlined into
`trade_positions`, because the `LpMint` PDA needs `init` codegen that
would push `trade_positions::try_accounts` past the SBF 4 KB stack ceiling
(same constraint that fragmented `sooth_market::initialize_market`).

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

**Implemented**: the SDK lives in its own package at
`packages/sdk-solana/` (`@sooth/sdk-solana`) rather than as a subpath
inside the EVM `@sooth/sdk`. Rationale: the dependency surface (Anchor,
`@solana/web3.js`, `@solana/spl-token`) is too large to colocate with the
EVM SDK without forcing every consumer to pull the union. The two SDKs
share formulas through copy-then-adapt, not through a shared workspace
crate — the LMSR closed form is small and the WAD scalars are identical.

Demo app (`apps/demo`) is forked Solana-only from the EVM `apps/demo`
with a `chain-shim` bridge that lets the same UI render against the
`SolanaChainAdapter`. See `packages/sdk-solana/README.md` for the SDK
surface and `apps/demo/src/integrations/chain-shim/` for the bridge.

---

## 11. Repo Layout (actual — sooth-solana repo)

This document lives in `sooth-solana` (the Solana monorepo), peer to
`sooth-alpha` (the EVM monorepo) rather than nested inside it. Layout
as of 2026-05:

```
sooth-solana/
├── Cargo.toml                  # workspace root (4 programs + 2 shared crates)
├── packages/
│   ├── programs-core/          # Anchor programs + their docs
│   │   ├── Anchor.toml
│   │   ├── programs/
│   │   │   ├── sooth_amm/         # LMSR + buy + sell + claim_unlocked ✓ implemented
│   │   │   ├── sooth_market/      # Market lifecycle + custody + redeem + adjudicator-allowlist ✓ implemented
│   │   │   ├── sooth_launchpad/   # Factory + fee router + seed_lp + mint_lp_for_buy ✓ implemented
│   │   │   └── sooth_adjudicator/ # register + request_lock + attest_outcome + dispute (Manual variant) ✓ implemented
│   │   ├── crates/
│   │   │   ├── sooth-account-offsets/   # shared Position/LockEntry byte offsets
│   │   │   └── sooth-protocol-types/    # cross-program IDs + USDC mint + ix discriminators
│   │   ├── docs/
│   │   │   ├── architecture.md          # this doc
│   │   │   └── research/                # CLOB / Monaco investigation
│   │   └── README.md           # programs status table
│   └── sdk-solana/             # @sooth/sdk-solana (TS) — chain adapter
├── apps/
│   └── demo/                   # forked Solana-only demo (chain-shim bridge)
├── docs/
│   ├── status.md               # program / SDK / demo / devnet state
│   ├── build.md                # local build + Phantom UX + wallet-adapter rules
│   ├── roadmap.md              # active items + pending decisions
│   ├── decision-log.md         # P-numbers / D-numbers
│   ├── glossary.md             # WAD, OUTCOME, tick, CU, PDA, ATA
│   ├── monaco-fork-analysis.md
│   └── research/
│       ├── porting-evaluation.md
│       ├── orderbook-survey.md
│       └── monaco-investigation-week-01.md
├── _spikes/
│   └── lmsr-cu/                # D4 prototype (excluded from workspace)
└── HANDOVER.md                 # contributor index
```

Programs not yet implemented: `sooth_book` only (gated on the Monaco fork
decision per §6 / P1). `sooth_adjudicator` Manual variant ships today; the
ZkTLS variant remains a placeholder per §7. Workspace `[members]` reserves
the `crates/` sibling for future shared no-Anchor crates (e.g.
`sooth-book-matcher`); `sooth-account-offsets` and `sooth-protocol-types`
are the current inhabitants.

---

## 12. Open Questions

1. ~~**Compute budget for LMSR**~~ — **resolved by D4**. Production
   `trade_positions` measures ~68k CU (see §5).
2. **Account rent model**: who pays for `Position` PDAs? Subsidize from treasury, or charge users (~$0.30 SOL at $150/SOL)?
3. ~~**CLOB**: Option A (port) vs Option B/C (Phoenix/OpenBook)~~ —
   superseded by Monaco fork investigation (§6, P1). Founder approval
   pending.
4. **zkTLS**: ship v1 with ManualAdjudicator and revisit when Primus adds Solana, or commit to Reclaim now?
5. **Indexer**: Helius webhook → existing Ponder Postgres, or run Geyser ourselves?
6. **Multi-chain UX**: not applicable to this repo — `apps/demo` is a
   forked Solana-only build; the EVM `apps/demo` lives in `sooth-alpha`.
7. **LP token transferability**: SPL by default. Do we want it that way (better composability) or do we want to gate transfers like ERC20 with hooks? Token-2022 transfer hooks could enforce this.
8. **Token-2022 vs classic SPL**: Token-2022 supports useful extensions (transfer hooks, confidential transfers, metadata pointer) but has CPI overhead and ecosystem gaps (some wallets/DEXes still flaky).
9. **Adjudicator-CPI auth check**: §4.4 — `lock_for_resolution` /
   `settle` use loose signer-key equality with `market.adjudicator`.
   Production gate (sysvar introspection vs program-derived signer) is
   deferred to the `sooth_adjudicator` design.
10. **`invalidate()` fallback** (§4.4): permissionless force-INVALID
    after `deadline + invalidationBuffer` is on the EVM `TruthMarket`
    but not yet ported.

---

## 13. Status Snapshot

This section used to enumerate "next steps" — those have either landed
(LMSR spike, SDK adapter, Monaco investigation) or moved into the
canonical roadmap surfaces (`docs/decision-log.md` + commit history +
`packages/programs-core/README.md` "Programs" status table). Refer to
those instead of duplicating here.

Resolved decision points referenced by other sections:

- **D4** (`docs/decision-log.md`): LMSR Taylor-exact variant proceeds to
  production; LUT and crank patterns dropped. Backs §5.
- **D5**: AMM-on-Solana atomic escrow is structural — see SDK
  implementation guide §6. Backs §6 Option A's escrow argument.
- **P1** (Monaco fork): investigation complete (recommend fork);
  founder approval pending. Backs §6.
- **P2 → D4**: subsumed by D4.
- **P4 → D5**: subsumed by D5.

---

_Last updated: 2026-05-07. Source-of-truth EVM contracts: `packages/contracts-core/src/` (sooth-core v0.1.2 / v0.2.0)._
