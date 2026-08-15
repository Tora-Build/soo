# Pulse — a Solana-native frontend, designed from the program outward

`apps/pulse` is the surface built directly on `@sooth/sdk-solana`. The demo,
Eastboard and Arena are EVM-shaped UIs speaking through the demo's 3,810-line
chain-shim to a program that never had the concepts they render: approvals that
no-op, addresses that are base58 wearing an `0x` costume, a "sell side" the book
does not store, escrowed outcome tokens the program does not have. Pulse has no
shim, and that entire bug class does not exist in it.

## 1. What the program gives us, and what each fact buys

| Program fact | Where it lives | Design consequence |
|---|---|---|
| One price axis: sell YES ≡ buy NO | the book stores a single YES ladder in ticks 1..999 | No "sell" vocabulary. Back YES / Back NO, and nothing else. |
| No approvals, no outcome tokens, no escrow | positions are internal accounting; SPL flows are direct | Every action is exactly one signature. There is no approve step to fake. |
| Bonding (EAST) → graduation → book (USDC), program-enforced | `market.book_enabled`, required by `book_place` | The venue is **routed**, never chosen. Graduation progress is a first-class visual. |
| Question text on-chain, hash-verified | `create_market` + `MarketCreated` | Self-describing cards, no indexer. |
| Client-side quotes | LMSR math in the SDK | Price preview per keystroke, no RPC. |
| Full price history from events | §3 | The chart needs no indexer at this scale. |
| Contextual end-of-life | settle → redeem / claim / reclaim / sweep / close | A position row has ONE correct action at any time; it is computed, not offered as a menu. |

## 2. Architecture

- Vite + React + TS + Tailwind, its own dark, dense, numeric visual system.
- Direct dependencies: `@sooth/sdk-solana`, `@solana/wallet-adapter-react`,
  `@tanstack/react-query`, `@solana/spl-token`. No chain-shim, no wagmi
  vocabulary anywhere.
- `src/config.ts` is the whole configuration: RPC URL, program id, the two
  venue mints and their display symbols (`EAST` / `USDC`, role-stable and
  ticker-overridable), seeded market refs, test-mode keypair. There is
  deliberately no `deployments.json` and no chain registry.
- `src/hooks/useAdapter.tsx` is the entire integration layer: construct one
  `SolanaChainAdapter`, and wrap the connected wallet as the `SignerRef` every
  `build*` method accepts. Wallet connection is wallet-adapter (Phantom,
  Solflare) with a `VITE_TEST_MODE` env keypair, the same hook the e2e suites
  drive, so Playwright exercises Pulse the way it does the other surfaces.

The data layer is four hooks:

| hook | what it does |
|---|---|
| `useMarkets` | discovery and live state. Refs come from env plus a per-browser localStorage list of markets created here; questions come from the verified `MarketCreated` event and are cached, so the signature walk happens once per market per browser. Computes the YES price from the AMM cursor client-side, plus graduation progress and lifecycle. |
| `usePriceSeries` | the trade tape via `adapter.readMarketTrades`, cached per market and fetched incrementally with `until` = the newest signature already seen. |
| `useTrade` | one-tap Back YES / Back NO, venue-routed by `market.isGraduated`, plus a client-side LMSR cost preview. |
| `useAdapter` | adapter, connection, connected wallet as a `sol:` ref and a signer. |

## 3. The chart's data

Prices are probabilities, so the chart is a probability time-series on the one
YES axis, assembled from the market's own events rather than from an indexer.

`readMarketTrades(ref, { limit, until })` walks the market PDA's signatures —
every emitting instruction touches that PDA — and prices each event onto the
YES axis: AMM execution prices from `PositionTraded` / `PositionSold`
(complemented for NO trades), and book fills from the batched `BookFilled`
event, whose `price_tick` **is** the YES price and needs no flip. AMM events
arrive as `Program data:` logs (`emit!`); book fills arrive as inner
instructions (`emit_cpi!`); the SDK decodes both shapes.

The walk is incremental: the assembled series is cached per market and only
signatures newer than the last one seen are requested, so a few hundred trades
cost a few hundred reads once. That is fine at demo scale; a busy production
market wants Geyser, the same boundary `docs/develop-vs-main.md` draws for the
indexer.

`PriceChart` is hand-rolled SVG — zero chart dependencies.

## 4. The screens

**Feed (`/`)** — one row per market: the question (linking to the market page),
a LIVE badge or `NN%→book` graduation progress, a countdown, and the bet bar.
Open markets first, settled below.

**Market (`/m/:pda`)** — question and "NN% chance" as the round header with a
lock countdown; the same bet bar the feed uses; the price chart; the graduation
bar; the order book panel; and a recent-plays ticker off the same event series.

**Portfolio (`/me`)** — position rows with one computed action each; a settled
winner's row offers Claim, which builds `redeem_amm_position`.

**Launch (`/launch`)** — question, deadline, and three size presets stated as
what they cost the creator: max loss 69 / 693 / 6,930 EAST, which is `b·ln(2)`
at b = 100 / 1,000 / 10,000. One signature. The created market is remembered in
localStorage so it appears in the feed.

**Faucet (`/faucet`)** — one card per venue token, minted client-side by the
mint authority key carried in env. The AMM card is the one needed first, since
every market trades there until it graduates.

### The bet bar

One control, used identically on the feed and the market page. The left region
is YES, the right is NO, and the divider sits at the market price — so the bar
is simultaneously the crowd split, the price display and the bet control.
Clicking a side arms it; a strip unfolds with size presets and one confirm.

Routing is the program's, not the user's. Pre-graduation both sides go to the
AMM (`trade_positions`, outcome 0 or 1 — the program prices NO natively).
Post-graduation both go to the book as an aggressive limit at the touch: buying
YES lifts the best ask, buying NO sells YES into the best bid, expressed as
`side` plus `tick` on the one axis.

### The order book panel

Collapsed by default and opened on request: live depth, the user's own resting
orders with cancel, and a compact limit form for graduated markets. Simple
front, depth for whoever asks for it.

## 5. What deliberately does not exist

Approve buttons (nothing to approve), venue pickers (the program routes), a NO
order book (one axis), mint/merge (the program has no outcome tokens), an
indexer dependency (events and accounts suffice at this scale), and the
chain-shim.
