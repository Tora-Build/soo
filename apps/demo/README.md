# @sooth/demo

> The forked demo app. Classic pages, the Eastboard shell at `/options`, and
> Arena at `/play`, all driven by `@sooth/sdk-solana` through a chain-shim.

This is a **faithful** fork of the EVM demo, not a clean reimplementation.
Upstream's React tree — pages, components, hooks, stores, validation, toast UX,
i18n, error boundaries — is preserved as-is; only the chain integration layer is
swapped, under `src/lib/chain-shim/`. Running upstream's real UX flows against
the Solana SDK is the point: a lean rebuild would only validate what we already
know works.

`apps/pulse` is the other frontend — standalone, shim-free, built directly on
the SDK. This one exists to exercise the fork.

## Routes

| Route | What it is |
| ----- | ---------- |
| `/options` | **Eastboard** — the option-chain shell wrapping the main trading surfaces |
| `/positions` | Eastboard portfolio |
| `/play` | **Arena** — the gameplay surface over the same markets |
| `/markets` | Market list |
| `/amm`, `/amm/:marketAddress` | LMSR bonding venue: quote, buy, sell, sell-cooldown claims |
| `/orderbook`, `/orderbook/:marketAddress` | The CLOB: ladder, place, cancel, withdraw, open orders |
| `/portfolio` | Positions, pending unlocks, redemptions, LP, operator panel |
| `/launchpad`, `/create` | Market creation and `seed_lp` |
| `/liquidity`, `/lp-forecast` | LP holdings and yield forecasting |
| `/operator` | Adjudicator console: request lock, attest, dispute, settle |
| `/faucet` | Mint devnet/localnet venue tokens |
| `/learn` | Static explainer content |
| `/geek` | Command terminal over the adapter; unwired commands say so |
| `/__check` | Health check |

The book is gated closed until a market graduates — the program enforces it — so
`/orderbook` shows the gate rather than a tradeable ladder on a market that is
still bonding.

## How the chain-shim works

`src/lib/chain-shim/` is the one place EVM-flavoured hook signatures map onto
Solana primitives. Re-syncing from upstream is "copy upstream `src/` in, re-run
the import substitutions".

| Shim file | Surface |
| --------- | ------- |
| `viem-shim.ts` | `Address` / `Hash` / `Hex`, `formatUnits`, `parseUnits`, `keccak256`, `encodePacked`, `parseAbi*`, `defineChain`, `http`, `fallback` |
| `wagmi-shim.ts` | `useAccount`, `useChainId`, `useDisconnect`, `useConnect`, `useReadContract*`, `useWriteContract`, `useWaitForTransactionReceipt`, `useWatchContractEvent`, `usePublicClient`, `useWalletClient`, `useBalance` |
| `wagmi-actions-shim.ts` | `waitForTransactionReceipt`, `getAccount`, `connect`, `reconnect`, `readContract`, `writeContract` |
| `appkit-shim.ts` | `useAppKit`, `useAppKitAccount`, `WagmiAdapter`, `createAppKit` |
| `sooth-sdk-shim.ts` | `WAD`, `MAX_UINT256`, `OutputLine`, `CommandResult` |
| `amm-bridge.ts` | AMM reads and writes onto the adapter |
| `markets-bridge.ts` | Market list and metadata |
| `orderbook-reads.ts` | Book ladder, depth, and a trader's open orders |
| `portfolio-bridge.ts` | Positions, unlocks, redemptions |
| `rpc-errors.ts` | RPC failure normalization for the toast layer |

Hooks bound to the wallet (`useAccount`, `useDisconnect`, `useAppKit`,
`usePublicClient`) return real values from `@solana/wallet-adapter-react`. Hooks
that would dispatch against an EVM ABI return stable "no data" sentinels, so the
surrounding component still renders its empty state instead of crashing.

If a re-sync from upstream turns into a wholesale rewrite, the shim is wrong —
adjust the shim, not the copied tree.

## Running it

```sh
pnpm install
pnpm --filter @sooth/demo dev            # devnet (default)
pnpm --filter @sooth/demo dev:localnet   # solana-test-validator + seed + vite
pnpm --filter @sooth/demo dev:surfpool   # Surfpool: sub-second boot, time-travel
```

`dev:localnet` boots `solana-test-validator --reset` with `sooth_core.so`
deployed and both venue mints preloaded, airdrops SOL, mints tokens, bootstraps
the protocol singletons, seeds a market, writes `.env.local`, and serves vite on
`:5175`. Ctrl-C kills the validator it started.

`dev:surfpool` swaps in Surfpool for the same flow. Worth it for two things: it
starts in under a second, and `surfnet_timeTravel` bridges the 24-hour
sell-cooldown and post-deadline gates a stock validator cannot. Cheatcodes are
surfaced through `pnpm --filter @sooth/demo cheats`.

Prerequisites for either local path: `solana-cli`, a browser wallet, and a built
program plus SDK —

```sh
anchor build
pnpm -F @sooth/sdk-solana build
```

To trade against localnet, import the seeded keypair from
`apps/demo/.localnet/user-keypair.json` and point your wallet at
`http://127.0.0.1:8899`.

Full wallet setup and the Surfpool path are in
[`docs/build.md`](../../docs/build.md).

### Seeding

`scripts/seed-localnet.mjs` bootstraps any cluster via `SOLANA_RPC_URL` — it is
what `dev:localnet` calls, and it is idempotent, so re-running it after a
redeploy is safe. Alongside it: `seed-book.mjs` and `grow-book.mjs` populate a
book, `graduate-market.mjs` trades a market past its `b·ln(2)` threshold, and
`settle-e2e.mjs` walks attest → veto → settle.

## Configuration

| Env | Default | Purpose |
| --- | ------- | ------- |
| `VITE_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | RPC endpoint |
| `VITE_SOLANA_WS_URL` | public devnet WS | Subscription endpoint for confirms — kept separate because keyed providers often serve reads but not `signatureSubscribe` |
| `VITE_SOOTH_CORE_ID` | from the bundled IDL | `sooth_core` program ID |
| `VITE_USDC_MINT` | `ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX` | **Book** venue token |
| `VITE_AMM_MINT` | `CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu` | **AMM** venue token |
| `VITE_AMM_TOKEN_LABEL` / `VITE_AMM_TOKEN_SYMBOL` | `Mock EAST` / `EAST` | Display name for the AMM token — chosen per deployment, so it cannot be a constant |
| `VITE_BOOK_TOKEN_LABEL` / `VITE_BOOK_TOKEN_SYMBOL` | `Mock USDC` / `USDC` | Display name for the book token |
| `VITE_DEMO_MARKET_REF` | (none) | `sol:<base58>` of the seeded market |
| `VITE_DEMO_EXTRA_MARKET_REFS` | (none) | Comma-separated extra markets to list |
| `VITE_PORT` | `5175` | Vite port |
| `VITE_TEST_MODE`, `VITE_TEST_KEYPAIR_BYTES` | (none) | Drive the app with a local keypair adapter; e2e only |
| `VITE_TEST_MINT_AUTHORITY_BYTES` | set by `seed:init` | Signs faucet mints. **Localnet only** |
| `VITE_TEST_AUTHORITY_BYTES` | set by `seed:init` | Protocol authority for auto-registration. Localnet only |

There is no on-chain market registry, so the market list is served from
`VITE_DEMO_MARKET_REF` plus `VITE_DEMO_EXTRA_MARKET_REFS`. A market created
outside that list is reachable by URL but will not appear in the feed. An
indexer is the fix, when it matters.

## Tests

```sh
pnpm -F @sooth/demo test        # vitest — 16 files
pnpm -F @sooth/demo e2e         # Playwright, against a real validator
pnpm -F @sooth/demo typecheck
```

Vitest covers React-tree mount, bridged-data shapes, the book view and order
mapping, order collateral, market-ref forms, RPC error normalization, and the
AMM buy/sell flows.

The Playwright suite in `e2e/onchain/` drives the real dapp through vite with a
local keypair adapter and asserts on-chain state, not just the DOM: AMM buys and
sells, slippage rejection, wallet-disconnected handling, sell-cooldown claims,
the trading window, attest/settle, redemption, market creation, faucet mints,
trading a market to graduation, dismiss and refund, LP redemption, and
per-market book fees. Specs that need to cross the 24-hour cooldown or a
deadline self-skip on a stock validator and run for real under Surfpool via
`surfnet_timeTravel` — see `e2e/helpers/surfpool.ts`.

## Troubleshooting

- **`port 8899 already in use`** — another validator is listening.
  `lsof -nP -iTCP:8899 -sTCP:LISTEN`, then kill it.
- **`port 5175 already in use`** — `VITE_PORT=5176 pnpm dev:localnet`.
- **`missing target/deploy/sooth_core.so`** — run `anchor build` from the repo
  root.
- **Wallet shows no balance** — check the wallet's network is
  `http://127.0.0.1:8899`, not mainnet-beta.
- **A change to the SDK does nothing** — the demo imports `dist/`. Run
  `pnpm -F @sooth/sdk-solana build`.
- **Every write hangs at "confirming"** — the RPC provider serves reads but not
  `signatureSubscribe`. Set `VITE_SOLANA_WS_URL` to an endpoint that does.
