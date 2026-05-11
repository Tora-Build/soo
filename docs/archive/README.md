# Archived Docs

Superseded plans and investigations preserved as historical record.
Active specs live under [`../spec/`](../spec/); active research and
design notes live under [`../research/`](../research/) and
[`../sooth_book/`](../sooth_book/).

## Inventory

| File                                                                   | Original location              | Superseded by                                         | Reason                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`sooth_book-fork-plan.md`](./sooth_book-fork-plan.md)                 | `docs/sooth_book/fork-plan.md` | [`../spec/sooth_book.md`](../spec/sooth_book.md)      | D13 — Monaco fork retired in favor of EVM-direct port. Cost envelope incompatible with the founder's <$50 hard cap.                                                    |
| [`monaco-fork-analysis.md`](./monaco-fork-analysis.md)                 | `docs/monaco-fork-analysis.md` | [`../spec/sooth_book.md`](../spec/sooth_book.md)      | D13 — Monaco-as-fork-base analysis superseded by the direct EVM port direction.                                                                                        |
| [`monaco-investigation-week-01.md`](./monaco-investigation-week-01.md) | `docs/research/`               | [`../spec/sooth_book.md`](../spec/sooth_book.md) §9.1 | D13 — investigation report on Monaco v0.15.5 source; relevant only under the retired fork direction.                                                                   |
| [`ladder-vs-density.md`](./ladder-vs-density.md)                       | `docs/research/`               | [`../spec/sooth_book.md`](../spec/sooth_book.md) §3.1 | D13 — `MarketLiquidities` capacity-lift analysis moot once `MarketLiquidities` is deleted in W1 of the new port (two-level bitmap + per-tick `BookSide` PDAs instead). |

## Decision-log entries that retired these

- **D7** (revised) — original Monaco fork P1 resolution; superseded.
- **D13** — EVM-direct port supersedes Monaco fork (2026-05-11).

## Do not implement against these

All four documents describe directions, capacity calculations, or
instruction surfaces tied to the Monaco fork. The active sooth_book
implementation plan is [`../spec/sooth_book.md`](../spec/sooth_book.md).
Internal cross-references inside the archived files were lightly rewired
on archive day so the worst dead links resolve, but the analyses
themselves are frozen.
