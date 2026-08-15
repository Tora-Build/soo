# Building and running locally

Two local paths are supported. Both run the same flow — dump the mock mints,
boot a validator with `sooth_core` deployed, initialize the protocol, seed a
market, write `.env.local`, serve vite — and produce the same environment, so
they are interchangeable from the dapp's point of view.

```bash
# Prereqs: solana-cli, Anchor 0.30.1, Phantom or Solflare browser extension
pnpm install
anchor build                              # writes target/deploy/sooth_core.so

# Option A — solana-test-validator (canonical, ~10s startup)
pnpm --filter @sooth/demo dev:localnet

# Option B — Surfpool (sub-second startup, exposes the setClock cheatcode)
#  Install once:  curl -sL https://run.surfpool.run/ | bash
pnpm --filter @sooth/demo dev:surfpool
```

The Surfpool path can skip the sell cooldown:
`bash apps/demo/scripts/surfnet-cheats.sh time-travel --seconds 86400`
fast-forwards past the lock window without restarting. `solana-test-validator`
has no equivalent, so `claim_unlocked` and settlement smoke tests are
wall-clock gated there.

Either path then runs `seed-localnet.mjs init`, which airdrops SOL, mints both
venue tokens, runs `initialize_protocol → create_market → register_adjudicator →
seed_lp`, writes `apps/demo/.localnet/user-keypair.json` (pre-funded) and
`.env.local`, and serves vite on http://localhost:5175.

`seed-localnet.mjs` seeds any cluster: point `SOLANA_RPC_URL` at devnet to run
the same bootstrap there. `pnpm dev` without a flag targets devnet.

## Compute budget

Every transaction to `sooth_core` must prepend
`ComputeBudgetInstruction::request_heap_frame(256 * 1024)`. The program uses a
custom 256 KB bump allocator; without the frame the first allocation lands
outside mapped memory and the program aborts with "Access violation in heap
section". `SolanaChainAdapter` does this on all paths — hand-rolled callers
must too.

## Two venue tokens

The AMM prices in the deployment's instance token (a devnet mock standing in
for EAST); the book prices in USDC (a project-controlled devnet mock). Both are
compile-time constants pinned by `address =` account constraints, so a mismatch
is a hard transaction failure rather than a UI inconsistency. The faucet page
dispenses both.

Mint authorities live untracked under `apps/demo/.localnet/`. Losing one means
the constant in
`packages/programs-core/programs/sooth-core/src/constants.rs` has to change and
the program has to be redeployed.

## Phantom / Solflare setup

1. Settings → Developer Settings → Testnet Mode → Solana Localnet.
2. Settings → Developer Settings → **Auto-Confirm on localhost: ON** — without
   it every transaction pops a manual approval. Phantom extension only.
3. Optionally import the pre-funded fixture: Settings → Add/Connect Wallet →
   Import Private Key → paste the byte array from
   `apps/demo/.localnet/user-keypair.json`. Otherwise connect any account and
   use the Faucet page to mint both tokens to it.

## Adjudicator registration

Resolution authority is a per-market `AdjudicatorEntry` registered by
`register_adjudicator`. `seed-localnet.mjs` registers the seeded market's
adjudicator at boot; the demo's `/operator` page gates its action buttons on the
connected wallet matching that authority.

## Wallet-adapter wiring rules (do not regress)

Verified end-to-end against real Phantom; regressing any one of these silently
breaks the modal click flow.

- `wallets={[]}` on `<WalletProvider>` for production. Wallet Standard
  auto-discovers Phantom / Solflare / Backpack / MetaMask / Magic Eden via
  `useStandardWalletAdapters`. Passing legacy adapter classes here makes the
  modal click dispatch to a stale instance and silently no-op.
- `autoConnect` on `<WalletProvider>` is required despite the name — in v0.15.x
  it gates the modal's select-then-connect path, not just reload-reconnect
  (anza-xyz/wallet-adapter#307).
- `<React.StrictMode>` MUST sit inside `<ConnectionProvider>` +
  `<WalletProvider>`, not wrapping them. Wrapping makes double-mount cleanup
  call `adapter.disconnect()` between mounts, leaving `connected=false` for the
  first sign attempt (solana-labs/wallet-adapter#686).
- Test mode (`VITE_TEST_MODE=true`) swaps `wallets={[]}` for
  `[new LocalKeypairAdapter()]` so e2e specs sign without Phantom popups.
  Production builds tree-shake it; `vite.config.ts` refuses a production bundle
  that touches `VITE_TEST_*`.

## Faucet env var

`seed-localnet.mjs` exports the local mint authorities' secret keys into
`.env.local`, consumed by the demo's faucet to sign SPL `MintTo`. Localnet only
— never run a build against devnet or mainnet with those vars set.

## Test gotcha

`apps/demo` consumes `@sooth/sdk-solana` via its `dist/` bundle, not `src/`.
After SDK edits run `pnpm -F @sooth/sdk-solana build` before
`pnpm -F @sooth/demo test`. The SDK's own Vitest suite hits `src/` directly;
only the bundled consumer needs the rebuild.
