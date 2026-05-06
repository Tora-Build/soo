# @sooth/demo — Solana-only TDD harness

A minimal React demo that exercises `@sooth/sdk-solana`'s public surface end-to-end. Forked in concept from `sooth-alpha/apps/demo`, but rebuilt lean: the upstream's chain-agnostic abstractions (Reown AppKit, wagmi, viem, registry-based dispatch) didn't survive the strip pass cleanly, so the Solana fork is built from scratch around the adapter.

## What works

| Route          | Status                                                    |
| -------------- | --------------------------------------------------------- |
| `/`            | Real — minimal market list (single configured market)     |
| `/m/:marketId` | Real — buy YES/NO shares end-to-end                       |
| `/portfolio`   | Stub — `readPortfolio` is `NotImplemented` in the adapter |
| `/orderbook`   | Stub — `buildOrderbook*` are `NotImplemented`             |
| `/launchpad`   | Stub — `buildCreateMarket` is `NotImplemented`            |
| anything else  | redirects to `/`                                          |

The buy flow:

1. Connect a Solana wallet (Phantom or Solflare) via the wallet-adapter UI.
2. Land on `/m/<marketPda>`. The page shows pre-trade state: `qYes`, `qNo`, your position.
3. Pick YES or NO, type a share count, set slippage. Click **Get quote**.
4. Click **Submit trade**. The wallet-adapter signs; the adapter submits + confirms.
5. The position display refetches and reflects the new shares.

## What is intentionally NOT here

- No EVM wallet/chain detection (no Reown AppKit, wagmi, viem, RainbowKit).
- No registry-based chain dispatch.
- No deployment-sync scripts (`scripts/sync-deployments.js`). Hardcoded localnet config in `src/lib/config.ts`.
- No i18n.
- No telegram embed.
- No `@sooth/healthcheck`.

## Quick start (one-command localnet)

The dapp needs three things to actually trade: a running validator, both Sooth programs deployed onto it, and a market initialized on top. `pnpm dev:localnet` does all three.

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

Stop the dev server with Ctrl-C — the script kills the validator it started. (If you previously had a different validator running on `:8899`, the script refuses to start; stop the other one first.)

### Connecting a wallet against localnet

The seeded user keypair is written to `apps/demo/.localnet/user-keypair.json`. To trade, import that keypair into your browser wallet:

- **Phantom**: Settings → Add / Connect Wallet → Import Private Key. Paste the contents of `user-keypair.json` (it's a JSON array of bytes; Phantom also accepts base58, in which case use `solana-keygen pubkey --skip-seed-phrase-validation` to convert).
- **Solflare**: similar — Add Wallet → Import → Private Key.

Set the wallet's network to **Custom RPC** = `http://127.0.0.1:8899` so it talks to your local validator instead of mainnet-beta.

## Manual run (validator already up)

If you already manage your own validator, skip the orchestrator:

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

## Smoke test

`tests/happy-path.test.tsx` is the load-bearing deliverable. It boots solana-bankrun (in-process; no external validator), deploys both programs, drives the four init instructions, mounts `<App>` with a `DemoProvider` override, and walks the buy form via `@testing-library/react`.

```sh
pnpm -F @sooth/demo test
```

The bankrun fixture (`tests/fixtures/bootDemo.ts`) is duplicated from `packages/sdk-solana/tests/fixtures/` because the SDK's `package.json` doesn't expose its test helpers. The `seed-localnet.mjs` script mirrors the same logic but against a real `Connection` — see the script's module comment for the diff.

## Why won't my wallet connect?

The dev demo has four common failure modes for "I clicked connect and nothing happened":

1. **No wallet extension installed.** The header replaces the Connect button with "No Solana wallet detected — Install Phantom" if neither Phantom nor Solflare is detected. Install one of them and reload.
2. **Local validator not running.** The header shows a red "Localnet · down" badge if `connection.getVersion()` fails. Run `pnpm --filter @sooth/demo dev:localnet` (or restart your manual validator).
3. **Wallet on the wrong network.** Phantom defaults to mainnet-beta. The connection appears to succeed but every `readSnapshot` call fails. Set the wallet's RPC to `http://127.0.0.1:8899`.
4. **autoConnect race.** The demo intentionally has `autoConnect={false}` (in `main.tsx`) — silent reconnects on page load are the most common cause of "the button is dead." If you'd like autoConnect back, flip it to `true` and accept that any silent failure won't surface in the UI.

## Configuration

Set via Vite env vars. `pnpm dev:localnet` writes a fresh `.env.local` on every run; manual setups can drop one in next to `vite.config.ts`.

| Env                           | Default                                        | Purpose                                           |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `VITE_SOLANA_RPC_URL`         | `http://127.0.0.1:8899`                        | RPC endpoint                                      |
| `VITE_USDC_MINT`              | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Collateral mint (canonical devnet USDC)           |
| `VITE_SOOTH_AMM_ID`           | `SoothAMM11111111111111111111111111111111111`  | sooth_amm program ID                              |
| `VITE_SOOTH_MARKET_ID`        | `SoothMkt11111111111111111111111111111111111`  | sooth_market program ID                           |
| `VITE_DEMO_MARKET_REF`        | (none)                                         | `sol:<base58>` of the demo market PDA             |
| `VITE_DEMO_AIRDROP_RECIPIENT` | (none)                                         | User pubkey the seed script funded with 1000 USDC |

## Troubleshooting

- **`port 8899 already in use`** — another validator (or `solana-test-validator` from a previous run) is still listening. `lsof -nP -iTCP:8899 -sTCP:LISTEN` to identify it, then kill it.
- **`port 5175 already in use`** — vite is already running. Kill it, or run `VITE_PORT=5176 pnpm dev:localnet`.
- **`missing target/deploy/sooth_amm.so`** — run `cd packages/programs-core && cargo build-sbf` from repo root.
- **`USDC mint not present at 4zMM…`** — the validator started without `--account` preloading the mint. Re-run `pnpm dev:localnet` to rebuild the dump and restart.
- **Wallet UI glows red after disconnect** — known wallet-adapter-react-ui quirk; reload the page.
