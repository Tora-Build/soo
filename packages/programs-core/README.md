# programs-core

> Anchor programs for Sooth Protocol on Solana — workspace member of the `sooth-solana` monorepo.
> Analogous to `packages/contracts-core` in the EVM monorepo (`sooth-alpha`).
> Status: `sooth_amm` scaffolded; remaining four programs are spec only. See "Status" below.

## What this is

`programs-core` is the Solana counterpart to Sooth's EVM core contracts. Where the EVM stack ships 8 Solidity contracts (`LaunchpadEngine`, `AMMEngine`, `SoothBook`, `OrderEngine`, `TruthMarket`, `FeeRouter`, `AdjudicatorRegistry`, `BaseToken`), the Solana stack will ship 5 Anchor programs:

| Program             | EVM Equivalent                                      | Purpose                                                                                              |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sooth_launchpad`   | `LaunchpadEngine`                                   | Market factory, creator deposits, LP tokens, trial period, fee distribution (inlined from FeeRouter) |
| `sooth_amm`         | `AMMEngine`                                         | LMSR math, position storage, lock-on-sell                                                            |
| `sooth_market`      | `OrderEngine` + `TruthMarket`                       | Market lifecycle + custody + mint/merge/redeem                                                       |
| `sooth_book`        | `SoothBook`                                         | On-chain orderbook (custom build OR Monaco fork — see `spec/architecture.md §6`)                     |
| `sooth_adjudicator` | `AdjudicatorRegistry` + adjudicator implementations | Resolver framework + per-type adjudicator programs (Manual, ZkTLS, etc.)                             |

See [`docs/architecture.md`](./docs/architecture.md) for the full mapping.

## Status

**Implementation in progress.** Three Anchor programs (`sooth_amm`, `sooth_market`, `sooth_launchpad`) scaffolded; the remaining two are still spec.

### Programs

| Program             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sooth_amm`         | **Scaffolded.** LMSR math wired in (D4 ported from `_spikes/lmsr-cu/`); state mutation real; buy + sell + `claim_unlocked` end-to-end (CPIs, PDA-signed transfers, LockEntry init/close); fee router / LP mint stubbed with `todo!()`. See `programs/sooth_amm/src/instructions/trade_positions.rs` for the TODO list.                                                                                                                                                                                                |
| `sooth_market`      | **Scaffolded.** Market PDA + lifecycle state machine real; `initialize_market` / `mint_complete_set` / `merge_complete_set` real (USDC ↔ outcome-mint CPIs wired); `transfer_to_lock` / `transfer_from_lock_vault` (Wave 1B helpers — PDA-signed `vault ↔ lock_vault` transfers CPI'd into from `sooth_amm`); `lock_for_resolution` / `settle` now gated on parent-ix introspection requiring `sooth_adjudicator` as the calling top-level ix (Wave 5 — closes Codex C2 deferred half); `redeem` is a `todo!()` stub. |
| `sooth_launchpad`   | **Scaffolded — stubs only.** `ProtocolConfig` PDA + `initialize_protocol` real (singleton fee bps + treasury + 4-way split bps); `create_market` (composes 4 CPIs from `sooth_market` + `sooth_amm` per architecture §4.1), `distribute_fees` (fee router §8), and `seed_lp` (pre-graduation LP mint) all `todo!()` with full Accounts structs committed for IDL stability.                                                                                                                                           |
| `sooth_book`        | Spec only. Gated on P1 (Monaco fork vs custom build).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sooth_adjudicator` | **Scaffolded.** Per-market `Adjudicator` PDA + `register_adjudicator` real; Manual variant `attest_outcome` real (CPIs into `sooth_market::settle`); `request_lock` real (CPIs into `sooth_market::lock_for_resolution`); `dispute` is a stub returning `DisputeNotImplemented`. ZkTLS variant placeholder rejects with `UnsupportedKind`.                                                                                                                                                                            |

### Toolchain

- **Anchor 0.30.1** (latest 0.30.x). The `init-if-needed` feature is enabled for the `Position` PDA pattern in `trade_positions`.
- **Solana CLI 3.0.13 / platform-tools v1.51** (matches the spike). `cargo build-sbf` ships cargo 1.84.0, which rejects `edition2024`-tainted transitive deps. The same pins as the spike apply — already encoded in the workspace `Cargo.lock`:
  ```bash
  cargo update -p constant_time_eq --precise 0.4.2  # (auto-pinned via blake3 1.5.5)
  cargo update -p blake3 --precise 1.5.5
  cargo update -p proc-macro-crate@3.5.0 --precise 3.2.0
  cargo update -p indexmap@2.14.0 --precise 2.6.0
  cargo update -p hashbrown@0.17.0 --precise 0.15.2
  cargo update -p unicode-segmentation --precise 1.12.0
  ```
  If a future `cargo update` reintroduces edition2024 errors, replay the equivalent set.

### Build commands

```bash
cargo check --workspace                                                                  # green
cargo test -p sooth_amm                                                                  # 33 tests (17 inline + 9 lmsr_unit + 7 lock_flow)
cargo test -p sooth_market                                                               # 43 tests (1 inline + 5 lifecycle + 16 adjudicator_allowlist + 12 transfer_helpers + 9 adjudicator_introspection)
cargo test -p sooth_launchpad                                                            # 5 tests (1 inline + 4 protocol_config)
cargo test -p sooth_adjudicator                                                          # 15 tests (1 inline + 14 adjudicator_flow)
cargo build-sbf --manifest-path packages/programs-core/programs/sooth_amm/Cargo.toml          # → target/deploy/sooth_amm.so
cargo build-sbf --manifest-path packages/programs-core/programs/sooth_market/Cargo.toml       # → target/deploy/sooth_market.so
cargo build-sbf --manifest-path packages/programs-core/programs/sooth_launchpad/Cargo.toml    # → target/deploy/sooth_launchpad.so
cargo build-sbf --manifest-path packages/programs-core/programs/sooth_adjudicator/Cargo.toml  # → target/deploy/sooth_adjudicator.so
```

`anchor idl build --program-name sooth_amm` is currently broken on the
0.30.1 toolchain (proc-macro2 1.0.66+ removed `Span::source_file`); the
IDL JSON at `packages/sdk-solana/src/anchor/sooth_amm.json` is hand-
maintained until we either bump to Anchor 0.32.x or downgrade
proc-macro2 in the lockfile. Discriminators for new ixs/accounts/events
are `sha256("global:<name>")[:8]`, `sha256("account:<TypeName>")[:8]`,
and `sha256("event:<EventName>")[:8]` respectively.

**`cargo build-sbf` must be invoked per-program, not at workspace level.** `sooth_amm` declares `sooth_market` as a path dep with `features = ["cpi"]`, which causes a workspace-level build to unify `cpi`+`no-entrypoint` features and emit a 896-byte stub `sooth_market.so` with no entrypoint (unloadable). Building each program from its own manifest path produces the correct loadable `.so`.

`anchor build` is deferred until the proc-macro2 mismatch is fixed; the
real keypairs and program IDs were rotated in for the devnet rollout
(2026-05-07). The `Anchor.toml` `[programs.devnet]` and `[programs.localnet]`
blocks now both list the production IDs:

| Program             | Devnet program ID                              | Status                                  |
| ------------------- | ---------------------------------------------- | --------------------------------------- |
| `sooth_amm`         | `67zS8M81LATLxEgegm5jyYgwFYNTfbF3FnYqxjbZKp7k` | Keypair generated, deploy pending funds |
| `sooth_market`      | `ByhA86BqTTrsZBDjSURWjRncojE6p7sxUqcWmHxfdd2n` | Deployed                                |
| `sooth_launchpad`   | `HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3` | Deployed                                |
| `sooth_adjudicator` | `4fifRPBFebS12impdMvQGKZ9WZ96GgUunrw6iEx3KKV8` | Deployed                                |

Keypairs live at `target/deploy/<program>-keypair.json` (gitignored). The
deploy payer keypair is at `apps/demo/.deploy-payer.json` (gitignored).
See [`../../docs/status.md` § Devnet deployment status](../../docs/status.md#devnet-deployment-status-2026-05-07) for the singleton bootstrap PDA addresses.

`sooth_market` originally co-init'd the Market PDA, both outcome mints, and both USDC vaults in a single `initialize_market` instruction. Anchor 0.30.1's `try_accounts` codegen frame for that combined accounts struct exceeded the SBF 4 KB stack limit by ~2.8 KB even with every payload-bearing field `Box<>`'d, and at runtime the overflow corrupted the deserialized `args` struct (e.g. `args.deadline > args.start_time` evaluating false on plainly-ordered literals). The flow is now split across three instructions — `initialize_market` (Market PDA only), `initialize_outcome_mints` (yes_mint + no_mint), and `initialize_market_vaults` (USDC vault + lock vault, flips lifecycle to `Open`) — each of which compiles under the 4 KB ceiling with no warnings. SDKs must call all three (in order) to land a tradeable market.

### Lock-on-sell flow

Architecture §4.3 describes a unified `trade_positions` ix that branches
on `delta_shares` sign. Anchor 0.30.1's account-loading pass evaluates
`init`/`init_if_needed` constraints unconditionally — a unified ix would
either force buyers to pay rent on a useless `LockEntry` escrow account
or share a per-trade nonce that conflates buys and sells. The Solana
port splits the two ixs:

- `trade_positions` — buy-only (keeps the `SellNotImplemented` guard for
  any caller that passes `delta_shares < 0`).
- `sell_positions` — sell with lock-on-sell. Mirrors the buy account
  list plus `lock_authority`, `lock_vault`, and a fresh `lock_entry` PDA.
  CPIs into `sooth_market::transfer_to_lock` for the PDA-signed
  `vault → lock_vault` transfer (Wave 1B fix).
- `claim_unlocked` — drain a `LockEntry` after the lock elapses; closes
  the account and refunds rent to the user. CPIs into
  `sooth_market::transfer_from_lock_vault` for the PDA-signed
  `lock_vault → user_usdc_ata` transfer (Wave 1B fix).

**Cross-program PDA signing.** The `vault_authority` and `lock_authority`
PDAs are both owned by `sooth_market` (seeds `[b"vault", market_id]` /
`[b"lock", market_id]` derived under `sooth_market::ID`), so only that
program can `invoke_signed` against them. The original Wave 1A
`sell_positions` / `claim_unlocked` ixs tried to sign for those PDAs
from `sooth_amm`, which Solana rejects with "Cross-program invocation
with unauthorized signer or writable account" — seeds derive a
_different_ PDA under each program's ID. The Wave 1B fix moves the
SPL-Token transfers behind two thin helper ixs on `sooth_market`
(`transfer_to_lock` + `transfer_from_lock_vault`) that the AMM CPIs
into; the helpers verify the caller's `Position` / `LockEntry`
(`owner == sooth_amm::ID`, plus `user`/`market` field checks at fixed
byte offsets) and trust the user's outer signature as the auth gate. A
future commit can add an `Instructions` sysvar introspection check to
also enforce the parent program is `sooth_amm` — see the TODO in
`programs/sooth_market/src/instructions/transfer_to_lock.rs`.

**`LockEntry` seed scheme**: `[b"lock_entry", position.key(), nonce]`,
where `nonce = position.lock_nonce` at sell time. The `Position` PDA
gains a new `lock_nonce: u64` field that is incremented after every
sell, guaranteeing each `LockEntry` PDA is fresh by construction. We
considered `[b"lock", market_id, user, nonce]` (the layout in
`architecture.md §2`) but rejected it because the `b"lock"` prefix
already names the `lock_authority` PDA on `sooth_market`; reusing it
would muddy the seed namespace even though PDAs with different seed
counts can't collide mathematically. See
`programs/sooth_amm/src/state/lock_entry.rs` for the full rationale.

**`LOCK_DURATION_SECS`**: 24 hours (86 400 s), declared as a top-level
constant in `programs/sooth_amm/src/lib.rs`. Mirrors EVM precedent —
every production deploy config in
`sooth-alpha/packages/contracts-core/config/*.json` sets
`lockDurationSeconds = 86400`. The Solidity AMM bounds the value to
`[30 minutes, 36 hours]`; the Solana port hard-codes 24h because the
program doesn't yet expose a per-deploy admin key. Lift to `AmmState`
state if a future deploy needs configurability.

**WAD → USDC rounding**: buys round **up** (`wad_to_usdc_ceil`); sells
and other outflows round **down** (`wad_to_usdc_floor`). The asymmetry
guarantees the vault's base-token balance is a strict lower bound on
its WAD-denominated liability — i.e. rounding always favours the
protocol, so round-trip trades cannot drain the vault by 1 base unit
per cycle. See `programs/sooth_amm/src/math/wad.rs` for both helpers.

## Layout

```
packages/programs-core/
├── README.md                  # this file
├── Anchor.toml                # workspace = ["programs/sooth_amm"], placeholder program ID
├── docs/
│   └── architecture.md        # complete program design (5 programs, account model, call chains, CU budgets)
└── programs/
    ├── sooth_amm/             # SCAFFOLDED — LMSR math + buy/sell + claim
    │   ├── Cargo.toml
    │   ├── src/
    │   │   ├── lib.rs         # LOCK_DURATION_SECS, USDC_MINT_DEVNET, ix wiring
    │   │   ├── error.rs
    │   │   ├── events.rs      # PositionTraded, PositionSold, LockClaimed
    │   │   ├── math/          # wad.rs (ceil + floor) + lmsr.rs
    │   │   ├── state/         # market, amm_state, position, lock_entry
    │   │   └── instructions/  # initialize_amm_state, trade_positions (buy),
    │   │                      # sell_positions, claim_unlocked
    │   └── tests/
    │       ├── lmsr_unit.rs   # host-side math tests
    │       └── lock_flow.rs   # lock-on-sell math + invariants
    ├── sooth_market/          # SCAFFOLDED — lifecycle + custody + mint/merge/redeem
    │   ├── Cargo.toml
    │   ├── src/
    │   │   ├── lib.rs
    │   │   ├── error.rs
    │   │   ├── events.rs
    │   │   ├── state/         # market, lifecycle (state machine)
    │   │   └── instructions/  # initialize_market, mint_complete_set,
    │   │                      # merge_complete_set, lock_for_resolution,
    │   │                      # settle, redeem (stub)
    │   └── tests/
    │       └── lifecycle.rs   # host-side state-machine transition tests
    └── sooth_launchpad/       # SCAFFOLDED — stubs only (initialize_protocol real)
        ├── Cargo.toml         # + path deps on sooth_amm, sooth_market w/ cpi feature
        ├── src/
        │   ├── lib.rs         # declare_id! + ix routing
        │   ├── error.rs       # SoothLaunchpadError
        │   ├── events.rs      # MarketCreated, FeesCollected, ProtocolInitialized
        │   ├── state/         # protocol_config (singleton), lp_position
        │   └── instructions/  # initialize_protocol (REAL),
        │                      # create_market / distribute_fees / seed_lp (todo!)
        └── tests/
            └── protocol_config.rs # host-side layout + invariant tests

# Future workspace members (uncomment in root Cargo.toml as they land):
#   programs/sooth_book
#   programs/sooth_adjudicator
#   crates/sooth-book-matcher
```

## Companions

- [`../sdk-solana/`](../sdk-solana/) — TypeScript SDK that consumes the IDLs from this product's `target/idl/`
- [`../../docs/research/`](../../docs/research/) — external research (orderbook survey, Monaco analysis) that informed the design
- [`../../docs/decision-log.md`](../../docs/decision-log.md) — running record of resolved decisions

## Reading order

1. [`docs/architecture.md §0`](./docs/architecture.md) — TL;DR and hardest unknowns
2. [`docs/architecture.md §1-4`](./docs/architecture.md) — program layout, account model, type mapping, call-chain translation
3. [`docs/architecture.md §5`](./docs/architecture.md) — AMM CU budget deep-dive (the load-bearing technical question)
4. [`docs/architecture.md §6`](./docs/architecture.md) — orderbook decision (build vs Monaco vs Phoenix), cross-references the orderbook research
5. [`docs/architecture.md §7-12`](./docs/architecture.md) — adjudicator, fees, trial period, frontend mapping, repo layout, open questions
6. [`docs/architecture.md §13`](./docs/architecture.md) — recommended next steps (the spike)
