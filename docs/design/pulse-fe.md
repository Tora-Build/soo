# Pulse — a Solana-native frontend, designed from the program outward

As of 2026-08-15. Research phase for the fourth frontend; the build follows
this document.

## 1. Why fresh, in one paragraph

Every existing surface (classic demo, Eastboard, Arena) is an EVM-shaped UI
speaking through the 3,810-line chain-shim to a program that never had the
concepts being rendered: approvals that no-op, addresses that are base58
wearing an `0x` costume, a "sell side" the book does not store, escrowed
outcome tokens that were deleted from the program months ago. The shim has
produced a disproportionate share of this codebase's bugs. Pulse talks to
`@sooth/sdk-solana` directly and the entire class disappears.

## 2. What the program gives us (verified against source, not assumed)

| Program fact | Where verified | Design consequence |
|---|---|---|
| One price axis: sell YES ≡ buy NO | book stores YES-side only; the NO double-complement was a fixed bug | UI has no "sell" vocabulary. Back YES / Back NO; exits are "Cash out". |
| No approvals, no outcome tokens, no escrow | complete sets deleted; SPL flows are direct | Every action is exactly one signature. No approve step exists to fake. |
| Bonding (EAST) → graduation → book (USDC), program-enforced | `book_enabled` gate in `book_place` | The pump.fun arc IS our arc. Graduation progress is the hero visual. Venue is ROUTED, never chosen. |
| Question text on-chain, hash-verified | `create_market` + `MarketCreated` | Self-describing cards, zero indexer. |
| Client-side quotes | LMSR math in SDK | Price preview per keystroke, no RPC. |
| Full price history from events | see §3 | The Polymarket chart needs no indexer at demo scale. |
| Contextual end-of-life | settle → redeem/claim/reclaim/sweep/close | Portfolio rows have ONE correct action at any time; compute it, don't menu it. |

## 3. The chart — Polymarket's look, our data

**Reference behavior** (Polymarket): the market page leads with "NN% chance",
then a probability time-series on a 0–100% axis, timeframe pills
(1H/6H/1D/1W/ALL), hover crosshair with date + %, YES line with NO available
as the complement. Prices ARE probabilities; the chart is the product.

**Our data source, event-audited:**

- Pre-graduation (AMM):
  - `PositionTraded { outcome, delta_shares, cost_wad, ts }` — execution
    price = `|cost/delta|`; NO trades complement to the YES axis.
  - `PositionSold { outcome, shares_sold, amount_usdc, ts }` — exec price =
    `amount/shares`, complemented likewise.
- Post-graduation (book):
  - `OrdersFilled.fills[] : FillRecord { yes_tick, amount, ts }` — the event
    was DESIGNED for this: ticks recorded as (yes, no) "so a consumer never
    has to know which side the taker was on to price the trade".
- Discovery: `getSignaturesForAddress(marketPda)` — every emitting
  instruction touches the market PDA. Incremental via `until = last seen
  signature`, cached in memory + localStorage. AMM events arrive as
  `Program data:` logs (`emit!`); book fills as inner instructions
  (`emit_cpi!`) — the SDK already decodes both shapes.
- Cost envelope: one `getTransaction` per signature, so a few hundred trades
  = a few hundred cached reads, incremental thereafter. Fine for demo scale;
  a busy production market wants Geyser — same boundary the indexer note in
  develop-vs-main already draws.

**SDK addition:** `readMarketTrades(market, {limit})` → ordered
`{ ts, yesPriceWad, sizeWad, venue: "amm" | "book" }[]`, mirroring
`readBookHistory`'s technique. Chart renders hand-rolled SVG (house pattern,
zero deps): stepped line, area gradient, crosshair, pills.

## 4. The screens

**Feed (`/`)** — pump.fun's discovery model:
- KOTH slot: the market closest to graduation, big, with its progress bar.
- Card grid below: question, big price ("62¢ YES"), 24h spark, graduation
  bar (or LIVE badge), one-tap Back YES / Back NO with an amount chip.
- Sort: closest-to-graduation / newest / most recent activity.

**Market (`/m/:pda`)** — Polymarket's information model:
- Header: question + "62% chance" as the dominant element.
- The chart (§3).
- Trade box (right / below on mobile): Back YES @ 62¢ / Back NO @ 38¢,
  amount presets (10 / 50 / 100 EAST or USDC post-grad), payout-if-right
  line, one signature.
- Below: recent plays ticker (from the same event series), and an
  "advanced" disclosure that reveals the live book (post-graduation only).
- Graduation bar with fees-accrued vs threshold while bonding.

**Portfolio (`/me`)** — rows of `{question, side, size, value, ACTION}` where
ACTION is computed: Cash out (open) → Claim (settled winner) → Reclaim
(creator) → nothing (spent). Plus pending unlocks with countdowns.

**Launch (`/launch`)** — question, deadline, three size presets with the b
cost stated as "your max loss: 69 / 693 / 6,930 EAST". One signature.

## 5. Architecture

- `apps/pulse`: Vite + React + TS + Tailwind. Dark, dense, numeric — its own
  visual system, not the demo's.
- Direct deps: `@sooth/sdk-solana`, `@solana/wallet-adapter-react`,
  `@tanstack/react-query`. NO chain-shim, no wagmi vocabulary anywhere.
- Hooks (the entire data layer, ~6 files):
  `useMarkets` (env refs + localStorage-created + on-chain questions),
  `useMarketLive` (snapshot poll), `usePriceSeries` (§3, incremental),
  `useTrade` (venue-routed one-tap), `usePortfolio`, `useLaunch`.
- Wallet: wallet-adapter modal; the same test-wallet hook (`VITE_TEST_MODE`)
  the e2e suite already relies on, so Playwright drives it the same way.

## 6. What deliberately does not exist

- Approve buttons (nothing to approve), venue pickers (the program routes),
  a NO orderbook (one axis), mint/merge (deleted upstream of us), indexer
  requirements (events + accounts suffice at this scale), the chain-shim.

## 7. Build order

1. Scaffold + providers + `useMarkets`/`useMarketLive` + feed cards.
2. `readMarketTrades` in the SDK (tested), chart, market page, one-tap trade.
3. Portfolio with contextual actions; launch flow.
4. Ticker, KOTH, graduation theatrics; Playwright pass against devnet.
