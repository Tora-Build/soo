# SoothBook Monaco Fork Plan

## Decision

P1 is resolved: Sooth will fork Monaco for `sooth_book` rather than build a custom orderbook from scratch. The engineering recommendation is now ratified, and the expected effort remains roughly 3-4 months before the real Solana orderbook can ship. This branch does not start that port; it only records the direction and reserves the Anchor program-id slot.

## Hard Sites

The substantive source reading lives in [`../research/monaco-investigation-week-01.md`](../research/monaco-investigation-week-01.md). The two effective hard sites are both in Monaco's `MarketLiquidities` capacity model: the `LIQUIDITIES_VEC_LENGTH = 30` constant that drives account sizing, and the `is_full()` comparison that treats 60 total side entries as saturated. The account-space user of `MarketLiquidities::SIZE` cascades from the constant, so the independent hard rewrite surface stays small.

## Migration Approach

The fork should begin with the smallest capacity lift that proves or disproves the path: raise the liquidity cap, benchmark a populated 1000-entry book, and only then decide whether a Sooth-specific tick bitmap is needed. After that, strip Monaco's n-way sportsbook and cross-matching branches down to binary YES/NO, then add Sooth primitives in order: complete-set mint/merge, surplus mechanics, `escrow=true` share-backed orders, and adjudicator-driven settlement. The queue step around `process_order_request` remains the main semantic caveat because Sooth must preserve atomic escrow semantics.

## Program-ID Reservation

`packages/programs-core/programs/sooth_book` is a placeholder Anchor program with one `placeholder` instruction that returns an explicit `NotImplemented` error. Its program ID is reserved by the local keypair at `target/deploy/sooth_book-keypair.json`, with `declare_id!`, `Anchor.toml`, the Cargo workspace, and the Surfpool deploy list all pointing at `5gAMjRCaZfb4NtHmBf2RZHFJVLAAZQ1PBP6dRNPUTxkH`. The keypair remains under `target/` and is not committed; if the slot needs to survive across machines before the real fork starts, Claude should decide how to escrow or regenerate that deploy key material.
