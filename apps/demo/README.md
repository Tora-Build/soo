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

| Route          | Status                                                                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/markets`     | Wired. List + bridged metadata via `dispatchMarketsRead`.                                                                                                                                                                                                                                                                                          |
| `/amm`         | Wired. Real `sooth_amm::trade_positions` (buy) and `sell_positions` end-to-end via the chain-shim → SDK → on-chain ix. Quote, position, lock-on-sell, claim_unlocked all functional.                                                                                                                                                               |
| `/orderbook`   | Renders the "gated on P1" card directly — `sooth_book` is undeployed (heavy hooks only mount when the program is present, no inner-hook crash).                                                                                                                                                                                                    |
| `/launchpad`   | Wired. Real `sooth_launchpad::create_market` (4-leg CPI init flow) via the shim.                                                                                                                                                                                                                                                                   |
| `/portfolio`   | Wired. AMM positions + complete-set CTAs (mint / merge / **redeem**) + pending-unlocks panel with claim button + operator panel (REQUEST LOCK + ATTEST YES/NO/INVALID, self-gated on Adjudicator.authority). `readPortfolio` itself still `NotImplemented`; the page builds its view from `readSnapshots` + `readPosition` + `readPendingUnlocks`. |
| `/operator`    | Renders. Operator actions surface on `/portfolio`; the legacy `/operator` page still calls upstream EVM `finalizeResolution`/`resolve` paths and shows "no data" until those routes are migrated.                                                                                                                                                  |
| `/liquidity`   | Renders. LP holders / forecasts still depend on EVM event indexing.                                                                                                                                                                                                                                                                                |
| `/lp-forecast` | Renders. Pure-function forecast helpers compile; live data points come from upstream EVM hooks → empty.                                                                                                                                                                                                                                            |
| `/learn`       | Renders fully (static content).                                                                                                                                                                                                                                                                                                                    |
| `/faucet`      | Wired. Real SPL `MintTo` against the localnet USDC mint via `dispatchAmmWrite("mint")` (signs with `VITE_TEST_MINT_AUTHORITY_BYTES` from `.env.local` — localnet only).                                                                                                                                                                            |
| `/geek`        | Renders. The terminal accepts commands; every command returns "Not available in Solana fork" (see `src/lib/sdk/index.ts`).                                                                                                                                                                                                                         |
| `/__check`     | Replaced — EVM contract health-check is chain-locked.                                                                                                                                                                                                                                                                                              |

Indexer status pill in the footer renders "pending (P3)" — the Solana indexer is gated on docs/decision-log.md P3 (namespace strategy).

## Quick start

`pnpm dev` (no flag) targets devnet by default — the four Sooth programs
are deployed at the IDs pinned in `src/lib/config.ts` (sourced from the
SDK's IDL JSON), and the protocol singletons (`ProtocolConfig`,
`fee_pool_vault`, `AdjudicatorAllowlist`) are bootstrapped already. To
re-bootstrap (e.g. after a fresh program redeploy) or to seed a fresh
demo market, run:

```sh
node apps/demo/scripts/seed-devnet.mjs --keypair apps/demo/.deploy-payer.json [--with-market]
```

`--with-market` requires the signing wallet to hold devnet USDC at the
canonical mint (`4zMM…ncDU`). Without it the script still bootstraps the
singletons (idempotent, safe to re-run).

For offline iteration, `pnpm dev:localnet` boots a fresh
`solana-test-validator`, deploys the programs, mints USDC, and seeds a
market — see [Localnet (offline)](#localnet-offline).

## Localnet (offline)

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
2. Boots `solana-test-validator --reset` with the four production .so binaries (`sooth_amm`, `sooth_market`, `sooth_launchpad`, `sooth_adjudicator`) and the USDC mint preloaded via `--account`. Or: `pnpm dev:surfpool` for sub-second startup + the `surfnet_timeTravel` cheatcode (Surfpool auto-deploys all four programs from `Anchor.toml`).
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
# Terminal 1 — your validator (deploy all four production programs at their declare_id! pubkeys)
solana-test-validator --reset \
  --bpf-program 67zS8M81LATLxEgegm5jyYgwFYNTfbF3FnYqxjbZKp7k target/deploy/sooth_amm.so \
  --bpf-program ByhA86BqTTrsZBDjSURWjRncojE6p7sxUqcWmHxfdd2n target/deploy/sooth_market.so \
  --bpf-program HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3 target/deploy/sooth_launchpad.so \
  --bpf-program 4fifRPBFebS12impdMvQGKZ9WZ96GgUunrw6iEx3KKV8 target/deploy/sooth_adjudicator.so \
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

Vitest covers React-tree mount + bridged-data shape (6 specs across `render` / `markets-display` / `portfolio-display` / `amm-buy-flow` / `amm-sell-flow`). Several of the on-chain integration specs need a running localnet validator — they pass against `dev:localnet` but skip / fail in isolation.

For full SDK validation, see `pnpm -F @sooth/sdk-solana test` (44 specs across 11 files, runs against `litesvm` in ~5s).

The Playwright on-chain e2e suite at `e2e/onchain/` (`pnpm -F @sooth/demo test:e2e`) drives the dapp via vite + `LocalKeypairAdapter` against a real validator. 12 specs total; specs 08 (claim_unlocked) and 09 (trading-window) self-skip on stock test-validator and run real round-trips when booted via Surfpool (they use `surfnet_timeTravel` to bridge the 24h sell-lock and post-deadline gates — see `e2e/helpers/surfpool.ts`).

## TODOs

- Migrate `/operator` page upstream to call the chain-shim `requestLock` / `attestOutcome` dispatchers (currently the operator panel on `/portfolio` covers this; the legacy page itself still wires to EVM `finalizeResolution` / `resolve`).
- When `buildOrderbook*` lands (gated on P1), wire the `/orderbook` page through it.
- When the Solana indexer lands (gated on P3), replace the "pending (P3)" footer pill with real sync state.
- Consider `manualChunks` config to break up the single-bundle output.

## Configuration

| Env                              | Default                                        | Purpose                                                                                                           |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `VITE_SOLANA_RPC_URL`            | `https://api.devnet.solana.com`                | RPC endpoint                                                                                                      |
| `VITE_USDC_MINT`                 | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Collateral mint (canonical devnet USDC)                                                                           |
| `VITE_SOOTH_AMM_ID`              | `67zS8M81LATLxEgegm5jyYgwFYNTfbF3FnYqxjbZKp7k` | sooth_amm program ID (devnet)                                                                                     |
| `VITE_SOOTH_MARKET_ID`           | `ByhA86BqTTrsZBDjSURWjRncojE6p7sxUqcWmHxfdd2n` | sooth_market program ID (devnet)                                                                                  |
| `VITE_SOOTH_LAUNCHPAD_ID`        | `HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3` | sooth_launchpad program ID (devnet)                                                                               |
| `VITE_SOOTH_ADJUDICATOR_ID`      | `4fifRPBFebS12impdMvQGKZ9WZ96GgUunrw6iEx3KKV8` | sooth_adjudicator program ID (devnet)                                                                             |
| `VITE_DEMO_MARKET_REF`           | (none)                                         | `sol:<base58>` of the demo market PDA                                                                             |
| `VITE_DEMO_AIRDROP_RECIPIENT`    | (none)                                         | User pubkey the seed script funded with 1000 USDC                                                                 |
| `VITE_TEST_MINT_AUTHORITY_BYTES` | (none, set by `seed:init`)                     | Localnet USDC mint authority secret key, signs Faucet `MintTo`. Localnet only — never set against devnet/mainnet. |
| `VITE_TEST_AUTHORITY_BYTES`      | (none, set by `seed:init`)                     | Adjudicator allowlist authority, used by the auto-register-on-connect hook. Localnet only.                        |

`pnpm dev:localnet` writes a `.env.local` that overrides `VITE_SOLANA_RPC_URL`
to `http://127.0.0.1:8899` (and ditto for the program IDs if the local
keypairs differ); the bare `pnpm dev` flow uses the devnet defaults
above without touching `.env.local`.

## Troubleshooting

- **`port 8899 already in use`** — another validator is still listening. `lsof -nP -iTCP:8899 -sTCP:LISTEN` to identify, then kill.
- **`port 5175 already in use`** — vite is already running. `VITE_PORT=5176 pnpm dev:localnet`.
- **`missing target/deploy/sooth_amm.so`** — `cd packages/programs-core && cargo build-sbf` from repo root.
- **Wallet shows no balance** — check the wallet's network is set to `http://127.0.0.1:8899` (not mainnet-beta).
