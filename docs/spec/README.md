# Sooth Solana Specs

Implementation references for `sooth_core`, the single Anchor program that is
the Sooth Protocol on Solana. Each spec describes one subsystem of that program:
its accounts, its instruction surface, and the rules the code enforces.

Program id: `EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw`
(`packages/programs-core/programs/sooth-core/src/lib.rs`).

## One program, five subsystems

Lifecycle, the LMSR AMM, the order book, LP/fees, and adjudication are Rust
modules inside `sooth_core` that call each other as plain functions. There is no
cross-program CPI between subsystems, no parent-instruction introspection gate,
no shared types crate, and one IDL for the whole protocol. The spec filenames
below are historical; they name modules, not programs.

| Spec                                             | Subsystem                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| [`sooth_market.md`](./sooth_market.md)           | Market account, lifecycle state machine, vaults, settlement, redeem, end-of-life |
| [`sooth_amm.md`](./sooth_amm.md)                 | LMSR AMM: bonding-phase trading, sell cooldown, graduation                    |
| [`sooth_book.md`](./sooth_book.md)               | On-chain order book: one account per market, single price axis, matching      |
| [`sooth_launchpad.md`](./sooth_launchpad.md)     | Protocol config, market creation, LP subsidy, fee pools and distribution      |
| [`sooth_adjudicator.md`](./sooth_adjudicator.md) | Resolution: register, lock, attest, veto/dispute, permissionless settle       |
| [`sqf.md`](./sqf.md)                             | Sooth Question Format: on-chain question text and its parser                  |

## The shape of a market

1. **Create** — `create_market` opens the market and its AMM state; `seed_lp`
   funds the LMSR subsidy of `b·ln(2)`.
2. **Bond** — trading runs on the LMSR AMM, priced in the deployment's instance
   token. The order book is closed.
3. **Graduate** — when accrued AMM fees reach `b·ln(2)`, the book opens.
4. **Trade** — the order book, priced in USDC, becomes the mature venue.
5. **Resolve** — `request_lock` → `lock_for_resolution` → `attest_outcome` →
   veto window → permissionless `settle`, with `dispute` able to override
   inside the window.
6. **Redeem and close** — `redeem_amm_position`, `redeem_book_seat`,
   `redeem_lp`, `reclaim_subsidy`, then `sweep_residual` and `close_market`.

## Caller contract: the heap frame

`sooth_core` installs a 256 KB bump allocator, so **every** transaction must
prepend `ComputeBudgetInstruction::request_heap_frame(256 * 1024)`. The runtime
only maps the larger heap when asked, and the allocator hands out addresses from
the top of that region — without the frame the first allocation lands outside
mapped memory and the program aborts with "Access violation in heap section".
This cannot be detected at runtime and reported nicely. `SolanaChainAdapter`
prepends it on every path; hand-rolled callers must do the same.

## Conventions

Each spec follows the same shape:

- **Accounts** — PDA seeds, fields, sizes, who pays rent.
- **Instruction surface** — every public instruction touching the subsystem,
  its arguments, and its authorization.
- **Mechanics** — the rules and math the handlers enforce.
- **Constraints** — the properties that are load-bearing, and what breaks if
  they are relaxed.

Canon law links point at [`sooth-canon`](https://github.com/Tora-Build/sooth-canon),
the cross-host reference these implementations follow.

## Keeping specs true

- A change to a shipped subsystem that alters its contract gets a
  [`docs/decision-log.md`](../decision-log.md) entry in the same PR.
- The spec is the second file you edit, after the code. Statements here should
  be checkable against a named module or constant.
