# @sooth/demo

> The frontend. Arena at `/play` and the Eastboard shell at `/eastboard/*`,
> both driven by `@sooth/sdk-solana` through a chain-shim.

This is a **faithful** fork of the EVM demo, not a clean reimplementation.
Upstream's React tree — pages, components, hooks, stores, validation, toast UX,
i18n, error boundaries — is preserved as-is; only the chain integration layer is
swapped, under `src/lib/chain-shim/`. Running upstream's real UX flows against
the Solana SDK is the point: a lean rebuild would only validate what we already
know works.

## Routes

Two surfaces over one chain-shim. Arena is the product; Eastboard is an older
internal trading UI, kept reachable but not linked from the game.

### Arena

| Route | What it is |
| ----- | ---------- |
| `/play` | The gameplay surface over the same markets — deck plus sidecar |
| `/explore` | Market list |
| `/forge` | Market creation and `seed_lp` |
| `/locker` | Positions, pending unlocks, redemptions, LP, operator panel |
| `/power` | Mint devnet/localnet venue tokens |
| `/vault` | LP holdings |

### Shared pages (arcade shell)

| Route | What it is |
| ----- | ---------- |
| `/amm`, `/amm/:marketAddress` | LMSR bonding venue: quote, buy, sell, sell-cooldown claims |
| `/orderbook`, `/orderbook/:marketAddress` | The CLOB: ladder, place, cancel, withdraw, open orders |
| `/operator` | Adjudicator console: request lock, attest, dispute, settle |
| `/learn` | Static explainer content |
| `/lp-forecast` | Creator LP cashflow model |
| `/geek` | Command terminal over the adapter; unwired commands say so |
| `/__check` | Health check |

### Eastboard

`/eastboard/options` (the option chain), `/eastboard/positions`, and the shared
pages again under `/eastboard/{markets,amm,orderbook,create,launchpad,portfolio,faucet,liquidity}`.

`/` redirects to `/play`. The pre-arena paths `/options`, `/markets`,
`/faucet`, `/portfolio`, `/liquidity`, `/create` and `/launchpad` redirect into
the arena.

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
| `appkit-shim.ts` | `useAppKit`, `useAppKitAccount`, `WagmiAdapter`, `createAppKit` |
| `sooth-sdk-shim.ts` | `WAD`, `MAX_UINT256`, `OutputLine`, `CommandResult`, empty ABI stubs |
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
| `VITE_AMM_MINT` | `ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX` | **AMM** venue token. Same mint as the book on this deployment; a build that splits the venues points it elsewhere |
| `VITE_AMM_TOKEN_LABEL` / `VITE_AMM_TOKEN_SYMBOL` | `Mock EAST` / `USDC` | Display name for the AMM token — chosen per deployment, so it cannot be a constant |
| `VITE_BOOK_TOKEN_LABEL` / `VITE_BOOK_TOKEN_SYMBOL` | `Mock USDC` / `USDC` | Display name for the book token |
| `VITE_DEMO_MARKET_REF` | (none) | `sol:<base58>` of the seeded market |
| `VITE_DEMO_EXTRA_MARKET_REFS` | (none) | Comma-separated extra markets to list |
| `VITE_PORT` | `5175` | Vite port |
| `VITE_TEST_MODE`, `VITE_TEST_KEYPAIR_BYTES` | (none) | Drive the app with a local keypair adapter; e2e only |
| `VITE_TEST_MINT_AUTHORITY_BYTES` | set by `seed:init` | Signs faucet mints. **Localnet only** |
| `VITE_TEST_AUTHORITY_BYTES` | set by `seed:init` | Protocol authority for auto-registration. Localnet only |
| `VITE_ARENA_API_BASE` | (none) | Base URL of the deployed `infra/arena-api` Worker. Without it the arena's profile, leaderboard and social calls are skipped |
| `VITE_EASTBOARD_FIXTURES` | (none) | `true` renders the Eastboard option chain from fixtures instead of chain reads |
| `VITE_ICON_RESOLVER_URL` | (none) | Optional market-icon resolver endpoint |
| `VITE_REGISTRY_URL` | (none) | Optional market registry endpoint |

There is no on-chain market registry, so the market list is served from
`VITE_DEMO_MARKET_REF` plus `VITE_DEMO_EXTRA_MARKET_REFS`. A market created
outside that list is reachable by URL but will not appear in the feed.
`packages/sooth-data` indexes the same data and would fix this, but no instance
is deployed and the app does not read from one.

## Tests

```sh
pnpm -F @sooth/demo test        # vitest — 17 files
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
