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

## Run locally

```sh
# from repo root
pnpm install

# Build the SDK first (the demo depends on its dist).
pnpm -F @sooth/sdk-solana build

# Build the demo (Vite + tsc).
pnpm -F @sooth/demo build

# Run the happy-path smoke (boots bankrun, mounts <App>, drives the buy flow).
pnpm -F @sooth/demo test

# Dev server.
pnpm -F @sooth/demo dev
```

## Smoke test

`tests/happy-path.test.tsx` is the load-bearing deliverable. It:

1. Boots solana-bankrun with `sooth_amm.so` + `sooth_market.so` from `target/deploy/`.
2. Drives the four real on-chain init instructions (initializeMarket → initializeOutcomeMints → initializeMarketVaults → initializeAmmState).
3. Mounts `<App>` with a `DemoProvider` override that injects the bankrun-backed adapter and a programmatic signer.
4. Walks the buy form (quote → submit) using `@testing-library/react`.
5. Asserts position-display + market header reflect the new state.

Bankrun fixtures (`tests/fixtures/bootDemo.ts`, `tests/fixtures/BankrunConnectionShim.ts`) are duplicated from `packages/sdk-solana/tests/fixtures/` because the SDK's `package.json` doesn't expose its test helpers. If those become a public dev surface (e.g. `@sooth/sdk-solana/test-utils`), these files should shrink to a re-export.

## Configuration

Override defaults via Vite env vars:

| Env                    | Default                                        | Purpose                                 |
| ---------------------- | ---------------------------------------------- | --------------------------------------- |
| `VITE_SOLANA_RPC_URL`  | `http://127.0.0.1:8899`                        | RPC endpoint                            |
| `VITE_USDC_MINT`       | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Collateral mint (canonical devnet USDC) |
| `VITE_SOOTH_AMM_ID`    | `SoothAMM11111111111111111111111111111111111`  | sooth_amm program ID                    |
| `VITE_SOOTH_MARKET_ID` | `SoothMkt11111111111111111111111111111111111`  | sooth_market program ID                 |
| `VITE_DEMO_MARKET_REF` | (none)                                         | `sol:<base58>` of the demo market PDA   |
