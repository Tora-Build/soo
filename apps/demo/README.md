# @sooth/demo — Faithful Solana fork of `sooth-alpha/apps/demo`

This is a **faithful** fork of `sooth-alpha/apps/demo`, not a clean reimplementation. Upstream's React tree (pages, components, hooks, stores, validation, toast UX, i18n, error boundaries) is preserved as-is; only the chain integration layer is swapped via `src/lib/chain-shim/`.

The TDD value of this fork comes from **running upstream's actual UX flows against `@sooth/sdk-solana`**. A lean rebuild would only validate what we already know works — it wouldn't surface the gaps real-world consumer code triggers.

## How the chain-shim works

`src/lib/chain-shim/` is the ONE place EVM-flavored hook signatures map to Solana primitives. Re-syncing from upstream is "copy upstream src/ in, re-run import substitutions" — see [How to re-sync](#how-to-re-sync-from-upstream).

| Shim file               | Surface                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viem-shim.ts`          | `Address`/`Hash`/`Hex` types, `formatUnits`, `parseUnits`, `keccak256`, `encodePacked`, `parseAbi*`, `defineChain`, `http`, `fallback`                                                                         |
| `wagmi-shim.ts`         | `useAccount`, `useChainId`, `useDisconnect`, `useConnect`, `useReadContract*`, `useWriteContract`, `useWaitForTransactionReceipt`, `useWatchContractEvent`, `usePublicClient`, `useWalletClient`, `useBalance` |
| `appkit-shim.ts`        | `useAppKit`, `useAppKitAccount`, `WagmiAdapter`, `createAppKit`                                                                                                                                                |
| `wagmi-actions-shim.ts` | `waitForTransactionReceipt`, `getAccount`, `connect`, `reconnect`, `readContract`, `writeContract`                                                                                                             |
| `sooth-sdk-shim.ts`     | `WAD`, `MAX_UINT256`, `OutputLine`, `CommandResult`, EVM ABI placeholders                                                                                                                                      |

Hooks bound to wallet-adapter (`useAccount`, `useDisconnect`, `useAppKit`, `usePublicClient`) return real values backed by `@solana/wallet-adapter-react`. Hooks that read EVM contracts via ABI dispatch (`useReadContract`/`useReadContracts`/`useWatchContractEvent`/`useWriteContract`) return stable sentinel "no data / unsupported" values — the surrounding component renders, the empty state surfaces.

## What's wired vs what throws NotImplemented

| Route          | Status                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/markets`     | Renders. Empty market list (Solana-side market discovery isn't wired through the shim).                                                                                       |
| `/amm`         | Renders. AMM-state reads return empty; submitting a trade triggers `SolanaForkUnsupported` from the shim. AMM end-to-end requires wiring through `useDemo()` directly — TODO. |
| `/orderbook`   | Renders. `buildOrderbook*` is `NotImplemented` in `SolanaChainAdapter`.                                                                                                       |
| `/launchpad`   | Renders. `buildCreateMarket` is `NotImplemented`.                                                                                                                             |
| `/portfolio`   | Renders. `readPortfolio` is `NotImplemented`.                                                                                                                                 |
| `/operator`    | Renders. Adjudicator console is HyperEVM-precompile-locked; falls through to "no data" state.                                                                                 |
| `/liquidity`   | Renders. LP holders / forecasts depend on EVM event indexing.                                                                                                                 |
| `/lp-forecast` | Renders. Pure-function forecast helpers compile; live data points come from upstream EVM hooks → empty.                                                                       |
| `/learn`       | Renders fully (static content).                                                                                                                                               |
| `/faucet`      | Renders. Mint USDC is EVM-only; falls through to "feature unavailable" via the shim.                                                                                          |
| `/geek`        | Renders. The terminal accepts commands; every command returns "Not available in Solana fork" (see `src/lib/sdk/index.ts`).                                                    |
| `/__check`     | Replaced — EVM contract health-check is chain-locked.                                                                                                                         |

The faithful fork accepts that most pages render but show empty/error states. That's the **honest gap surface** the brief calls out.

## Quick start (one-command localnet)

The dapp needs a running validator with both Sooth programs deployed and a market initialized. `pnpm dev:localnet` does all three.

```sh
# Prereqs (one time):
#   - solana-cli installed (https://docs.anza.xyz/cli/install)
#   - Phantom or Solflare browser extension
#   - SDK + programs built:
#       pnpm -F @sooth/sdk-solana build
#       cd packages/programs-core && cargo build-sbf

# From repo root:
pnpm install
pnpm --filter @sooth/demo dev:localnet
```

What it does, in order:

1. Pre-bakes a USDC mint JSON dump at the canonical address (`4zMM…ncDU`).
2. Boots `solana-test-validator --reset` with both `sooth_amm.so` and `sooth_market.so` and the USDC mint preloaded via `--account`.
3. Waits for the validator to be healthy.
4. Airdrops 10 SOL to a pre-generated creator + user keypair.
5. Mints 1000 USDC to the user.
6. Runs all four Anchor init instructions to create a market and an AMM state.
7. Writes `apps/demo/.env.local` with the seeded `VITE_DEMO_MARKET_REF` etc.
8. Starts vite on `:5175` (or `VITE_PORT` if set).

Stop the dev server with Ctrl-C — the script kills the validator it started.

### Connecting a wallet against localnet

The seeded user keypair is written to `apps/demo/.localnet/user-keypair.json`. To trade, import that keypair into your browser wallet and set the wallet's network to **Custom RPC** = `http://127.0.0.1:8899`.

## Manual run (validator already up)

```sh
# Terminal 1 — your validator
solana-test-validator --reset \
  --bpf-program SoothAMM11111111111111111111111111111111111 target/deploy/sooth_amm.so \
  --bpf-program SoothMkt11111111111111111111111111111111111 target/deploy/sooth_market.so \
  --account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU apps/demo/.localnet/usdc-mint-account.json

# Terminal 2 — seed + dev
pnpm --filter @sooth/demo seed:prepare   # writes the mint dump (one-time)
pnpm --filter @sooth/demo seed:init       # creates a market, writes .env.local
pnpm --filter @sooth/demo dev             # vite
```

## How to re-sync from upstream

The shim is designed so that pulling new upstream code is mostly a copy + import-substitution exercise:

```sh
# 1. Mirror the upstream src/ wholesale (preserves new files):
rsync -a --delete ../../../sooth-alpha/apps/demo/src/ src/

# 2. Re-run the import substitutions across the new files:
find src -type f \( -name "*.ts" -o -name "*.tsx" \) | while read f; do
  perl -i -0pe '
    s|from "wagmi"|from "@/lib/chain-shim"|g;
    s|from "wagmi/chains"|from "@/lib/chain-shim"|g;
    s|from "wagmi/actions"|from "@/lib/chain-shim/wagmi-actions-shim"|g;
    s|from "viem"|from "@/lib/chain-shim"|g;
    s|from "viem/accounts"|from "@/lib/chain-shim"|g;
    s|from "@reown/appkit/react"|from "@/lib/chain-shim"|g;
    s|from "@reown/appkit/networks"|from "@/lib/chain-shim"|g;
    s|from "@reown/appkit-adapter-wagmi"|from "@/lib/chain-shim"|g;
    s|from "@sooth/sdk/core"|from "@/lib/chain-shim"|g;
    s|from "@sooth/sdk/core/abis"|from "@/lib/chain-shim"|g;
  ' "$f"
done

# 3. Restore the Solana-specific files from git (they live in src/ but
#    are not in upstream):
git restore -- src/main.tsx src/lib/polyfills.ts src/lib/config.ts \
                src/lib/DemoContext.tsx src/lib/chain-shim/ \
                src/lib/sdk/ src/pages/HealthCheckPage.tsx

# 4. Run typecheck; new wagmi/viem symbols upstream uses might need to
#    be added to the shim:
pnpm typecheck
```

If a re-sync is "wholesale rewrite," the shim layer is wrong — open an issue and adjust the shim, not the upstream copy.

## Tests

```sh
pnpm -F @sooth/demo test
```

The current test (`tests/render.test.tsx`) is a smoke test: mounts the Markets page under the production provider stack to verify that the React tree (chain-shim + upstream components) initializes without throwing. End-to-end buy-flow tests require wiring more upstream pages through `useDemo()` directly — see TODO list below.

For full SDK validation, see `pnpm -F @sooth/sdk-solana test` which exercises `SolanaChainAdapter` against `solana-bankrun`.

## TODOs

- Wire upstream's AMM page (`pages/AMM.tsx` / `components/features/market/AMMPageBody.tsx`) through `useDemo()` so the buy flow works against the SolanaChainAdapter, not just renders.
- Add a fixture-driven page test that exercises buy via the upstream form (full TDD-via-demo loop).
- When `buildOrderbook*` / `readPortfolio` land on `SolanaChainAdapter`, port the corresponding pages similarly.
- Consider `manualChunks` config to break up the 1.5MB single bundle.

## Configuration

| Env                           | Default                                        | Purpose                                           |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `VITE_SOLANA_RPC_URL`         | `http://127.0.0.1:8899`                        | RPC endpoint                                      |
| `VITE_USDC_MINT`              | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Collateral mint (canonical devnet USDC)           |
| `VITE_SOOTH_AMM_ID`           | `SoothAMM11111111111111111111111111111111111`  | sooth_amm program ID                              |
| `VITE_SOOTH_MARKET_ID`        | `SoothMkt11111111111111111111111111111111111`  | sooth_market program ID                           |
| `VITE_DEMO_MARKET_REF`        | (none)                                         | `sol:<base58>` of the demo market PDA             |
| `VITE_DEMO_AIRDROP_RECIPIENT` | (none)                                         | User pubkey the seed script funded with 1000 USDC |

## Troubleshooting

- **`port 8899 already in use`** — another validator is still listening. `lsof -nP -iTCP:8899 -sTCP:LISTEN` to identify, then kill.
- **`port 5175 already in use`** — vite is already running. `VITE_PORT=5176 pnpm dev:localnet`.
- **`missing target/deploy/sooth_amm.so`** — `cd packages/programs-core && cargo build-sbf` from repo root.
- **Wallet shows no balance** — check the wallet's network is set to `http://127.0.0.1:8899` (not mainnet-beta).
