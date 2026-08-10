# Roadmap — sooth-solana

> What's left, in priority order. Refresh when items resolve.

The dapp works locally end-to-end with 19/19 Playwright e2e specs green on a fresh Surfpool boot (verified 2026-05-08). All four implementable production programs (`sooth_amm`, `sooth_market`, `sooth_launchpad`, `sooth_adjudicator`) are FULLY implemented including the previously-blocked trade-to-graduate / dismiss-market / claim-refund / LP-redeem flows. Demo dapp surfaces every program write that matters: buy / sell / mint / merge / redeem / claim-unlocked / create-market / faucet / request-lock / attest-outcome / dismiss-market / claim-refund / redeem-LP.

## Active

1. **Schedule the Monaco fork for `sooth_book`.** P1 is resolved: fork Monaco. The real port is a ~3-4 month feature-branch effort; the current repo only reserves the program-id slot and keeps `/orderbook/:market` in the gated state until the fork lands.
2. **Finish the AMM devnet deploy.** Get ~3 SOL into `apps/demo/.deploy-payer.json` (fresh airdrop or out-of-band funding) and run

   ```
   solana program deploy target/deploy/sooth_amm.so \
     --program-id target/deploy/sooth_amm-keypair.json \
     --keypair apps/demo/.deploy-payer.json --use-rpc --url devnet
   ```

   Then `bash apps/demo/scripts/seed-fixture.sh` (with `SOLANA_RPC_URL`/`SOLANA_WS_URL` set for a remote cluster) to seed the demo markets.

3. **Build the standalone Solana indexer.** P3 is resolved: do not widen the EVM Ponder `chainId` model. Keep the Solana indexer decoupled, with the existing `solanaMainnet` / `solanaDevnet` / `solanaLocalnet` status shape ready for integration.
4. **Performance / observability.** Measure retry rate during devnet validation and keep it under the P5 target of <5%. No structured Solana indexer integration exists yet, so broader user testing should include RPC fallback behavior and indexer-lag reporting.

## What's NOT in scope for this repo

- The EVM stack (lives in `sooth-alpha`).
- Apps consuming the EVM SDK (`sooth-alpha/apps/{telegram,market,world}`); only the demo is forked here as the SDK-compatibility test harness.
- HyperEVM precompile adjudicator and Lens post-action (chain-locked to EVM).
- The multi-actor CLI test harness — stays EVM-only per P8.

## Questions to escalate

No founder-blocking Solana architecture decisions remain from P1/P3/P5/P6/P7/P8 as of 2026-05-08. Escalate only if the Monaco fork estimate, standalone indexer shape, retry-rate target, wallet-adapter choice, priority-fee policy, or deferred CLI scope needs to change.
