# Sooth Solana Specs

Canonical implementation references for the Solana host. Each spec is the
forward source-of-truth for one component: its instruction surface, account
layout, cross-program wiring, and known deviations from the canonical EVM
implementation.

Specs live here so contributors and reviewers don't have to guess which doc
under `docs/` reflects the current direction. Active research and design
notes live under `docs/research/` and `docs/sooth_book/`; superseded plans
and investigations are moved to `docs/archive/` (see
[`docs/archive/README.md`](../archive/README.md) for the index).
Pre-rev drafts are explicitly marked.

## Spec map

| Spec                                             | Program / artifact                                | Status                                               | EVM equivalent                                                                           |
| ------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`sooth_book.md`](./sooth_book.md)               | `sooth_book` (orderbook)                          | implementation-ready (W1–W9 ahead)                   | `SoothBook.sol` + `OrderEngine.sol`                                                      |
| [`sooth_amm.md`](./sooth_amm.md)                 | `sooth_amm` (LMSR AMM)                            | shipped (devnet); under maintenance                  | `AMMEngine.sol`                                                                          |
| [`sooth_market.md`](./sooth_market.md)           | `sooth_market` (lifecycle + custody)              | shipped (devnet); under maintenance                  | `TruthMarket.sol` + parts of `OrderEngine.sol`                                           |
| [`sooth_launchpad.md`](./sooth_launchpad.md)     | `sooth_launchpad` (factory + fees + LP)           | shipped (devnet); under maintenance                  | `LaunchpadEngine.sol` + `FeeRouter.sol` + `LaunchpadLPToken.sol`                         |
| [`sooth_adjudicator.md`](./sooth_adjudicator.md) | `sooth_adjudicator` (resolver / attest / dispute) | partial (manual placeholder shipped; zkTLS deferred) | `interfaces/IAdjudicator.sol` + `adjudicators/{AdjudicatorBase,AdjudicatorRegistry}.sol` |
| [`sqf.md`](./sqf.md)                             | Sooth Question Format (SDK + demo)                | shipped (TS); on-chain mapping deferred              | shared with EVM (canon `law/question-format.md`)                                         |

## Conventions

Every spec uses the same shape:

- **Status line** — `implementation-ready` (spec done, code TBD),
  `shipped` (code in production), `partial` (some sub-cases shipped), or
  `superseded` (kept for history; do not implement against it).
- **Canon mapping** — what canon law document this spec implements.
- **EVM source mirrored** — the `sooth-alpha` files this implementation
  ports from.
- **Account / state model** — PDA seeds, account sizes, ownership.
- **Instruction surface** — every public ix with its EVM equivalent.
- **Cross-program wiring** — CPI authorities and parent-ix introspection.
- **Deviations** — documented divergences from canon law. Filed as
  entries in `host-kb/solana/deviations.json` once that file exists.
- **Out of scope** — explicit deferrals.

## Status convention

Status lines and the spec map above are the authoritative readiness signal.
If a doc body and its status line disagree, the status line wins until the
doc body is fixed.

## Canonical references

Solana implements [canon](https://github.com/Tora-Build/sooth-canon) law.
The canon documents these specs map onto:

| Canon                          | Solana spec(s)                                       |
| ------------------------------ | ---------------------------------------------------- |
| `law/amm-lmsr.md`              | `sooth_amm.md`                                       |
| `law/orderbook.md`             | `sooth_book.md`                                      |
| `law/lifecycle.md`             | `sooth_market.md` + `sooth_launchpad.md`             |
| `law/settlement-redemption.md` | `sooth_market.md`                                    |
| `law/adjudicator.md`           | `sooth_adjudicator.md`                               |
| `law/question-format.md`       | `sqf.md`                                             |
| `law/numeric-domain.md`        | applied across all specs; WAD ↔ base-unit conversion |
| `law/fee-policy.md`            | `sooth_launchpad.md` fee router section              |
| `law/atomicity.md`             | applied across all specs                             |

When canon law changes, specs that reference it are reviewed in the same
PR. Spec content does not silently fork from canon.

## Update protocol

1. Spec changes that touch shipped programs require a decision-log entry
   (`docs/decision-log.md`).
2. Status changes (`partial → shipped`, etc.) are tied to verifiable
   evidence: a passing test suite, a deployed program id, or a green
   devnet smoke run.
3. Specs are kept in sync with `packages/programs-core/docs/architecture.md`.
   Architecture doc is the cross-program overview; these specs are the
   per-program detail. The two should not contradict.
