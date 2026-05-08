# Building the demo locally

Two paths are supported. Both run the same Phase 1–4 flow (USDC mint dump → boot validator → init protocol → vite) and both produce the same `.env.local` shape, so they're interchangeable from the dapp's point of view.

```bash
# Prereqs: solana-cli, Phantom or Solflare browser extension
pnpm install

# Option A — solana-test-validator (canonical, slower startup ~10s)
pnpm --filter @sooth/demo dev:localnet

# Option B — Surfpool (sub-second startup, exposes setClock cheatcode)
#  Install once:  curl -sL https://run.surfpool.run/ | bash
pnpm --filter @sooth/demo dev:surfpool
```

The Surfpool path drops the 24h sell-lock UI smoke blocker via `surfnet_timeTravel` — `bash apps/demo/scripts/surfnet-cheats.sh time-travel --seconds 86400` fast-forwards past the lock window without restarting. `solana-test-validator` has no equivalent, so claim_unlocked / operator settle UI smoke is wall-clock gated there.

Either path then runs `seed-localnet.mjs init` which: deploys 2 of the 4 .so binaries (Surfpool auto-deploys all 4 via Anchor.toml), runs `initialize_protocol → initialize_fee_pool → initialize_adjudicator_allowlist → addAdjudicator → createMarket → registerAdjudicator`, writes `apps/demo/.localnet/user-keypair.json` (1000 USDC + 10 SOL pre-funded) + `.env.local`, and serves vite on http://localhost:5175.

## Phantom / Solflare setup

1. Settings → Developer Settings → Testnet Mode → Solana Localnet
2. Settings → Developer Settings → **Auto-Confirm on localhost: ON** — required for the e2e demo flow; without it every tx pops a manual approval. Phantom-extension only; doesn't exist on mobile.
3. Optionally: Settings → Add/Connect Wallet → Import Private Key → paste the byte array from `apps/demo/.localnet/user-keypair.json` (the pre-funded fixture). Or connect any Phantom account and use the Faucet page (now wired) to mint 100k mUSDC to the connected pubkey.

The wired pages (`/markets`, `/amm/:marketAddress`, `/portfolio`, `/faucet`, `/launchpad`) drive the real `SolanaChainAdapter`. `/orderbook/:marketAddress` renders a "gated on P1" card directly (heavy hooks only mount when `sooth_book` is deployed). `/operator` renders but the action buttons are gated on the connected wallet being on the adjudicator allowlist.

## Adjudicator allowlist gate

Any wallet that wants to call `createMarket` (Launchpad) or operator settle/attest paths must be on the on-chain `AdjudicatorAllowlist` PDA (singleton owned by `sooth_market`). `seed-localnet.mjs` registers the creator-keypair at boot. To register an arbitrary wallet (e.g. your Phantom pubkey), the chain-shim `addAdjudicator` dispatcher auto-registers the connected wallet on first connect using `VITE_TEST_AUTHORITY_BYTES` from `.env.local` (localnet only). Manual fallback if needed:

```js
await soothMarketProgram.methods
  .addAdjudicator(newPubkey)
  .accounts({ allowlist: allowlistPda, authority: creator.publicKey })
  .signers([creator])
  .rpc();
```

## Wallet-adapter wiring rules (do not regress)

Verified end-to-end against real Phantom; regressing any one of these silently breaks the modal click flow.

- `wallets={[]}` on `<WalletProvider>` for production. Wallet Standard auto-discovers Phantom / Solflare / Backpack / MetaMask / Magic Eden via `useStandardWalletAdapters`. Including legacy adapter classes here causes the modal click to dispatch to a stale instance and silently no-op.
- `autoConnect` on `<WalletProvider>` is required despite the name — in v0.15.x it gates the modal's select-then-connect path, not just reload-reconnect (anza-xyz/wallet-adapter#307).
- `<React.StrictMode>` MUST be inside `<ConnectionProvider>` + `<WalletProvider>`, not wrapping them. Wrapping causes double-mount cleanup to call `adapter.disconnect()` between mounts, leaving `connected=false` for the first sign attempt (solana-labs/wallet-adapter#686).
- Test mode (`VITE_TEST_MODE=true`) swaps `wallets={[]}` for `[new LocalKeypairAdapter()]` so e2e specs sign without Phantom popups. Production builds tree-shake the adapter; `vite.config.ts` refuses production bundles touching `VITE_TEST_*`.

## Localnet faucet env var

`seed-localnet.mjs` exports `VITE_TEST_MINT_AUTHORITY_BYTES` into `.env.local` — the localnet USDC mint authority's secret key, consumed by the chain-shim's `dispatchAmmWrite("mint")` to sign the SPL `MintTo` ix. Acceptable for localnet only; never run a build against devnet/mainnet with this var set.

## Test gotcha

`apps/demo` consumes `@sooth/sdk-solana` via its `dist/` bundle, not `src/`. After IDL changes or adapter edits, run `pnpm -F @sooth/sdk-solana build` before `pnpm -F @sooth/demo test` so the demo picks them up. Vitest hits `src/` directly — only the bundled consumer needs the rebuild.
