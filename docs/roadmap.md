# Roadmap — sooth-solana

> What's left, in priority order. Refresh when items resolve.

The dapp works locally end-to-end with 19/19 Playwright e2e specs green on a fresh Surfpool boot (verified 2026-05-08). All four implementable production programs (`sooth_amm`, `sooth_market`, `sooth_launchpad`, `sooth_adjudicator`) are FULLY implemented including the previously-blocked trade-to-graduate / dismiss-market / claim-refund / LP-redeem flows. Demo dapp surfaces every program write that matters: buy / sell / mint / merge / redeem / claim-unlocked / create-market / faucet / request-lock / attest-outcome / dismiss-market / claim-refund / redeem-LP.

## Active

1. **Founder decision on P1.** All evidence is in `docs/research/monaco-investigation-week-01.md`. Once approved (or rejected), `sooth_book` becomes scaffold-able. Until then `/orderbook/:market` renders an "unavailable" card directly (covered by spec 18).
2. **Finish the AMM devnet deploy.** Get ~3 SOL into `apps/demo/.deploy-payer.json` (fresh airdrop or out-of-band funding) and run

   ```
   solana program deploy target/deploy/sooth_amm.so \
     --program-id target/deploy/sooth_amm-keypair.json \
     --keypair apps/demo/.deploy-payer.json --use-rpc --url devnet
   ```

   Then `node apps/demo/scripts/seed-devnet.mjs --keypair apps/demo/.deploy-payer.json --with-market` to seed the demo market.

3. **Founder decision on P3** (indexer namespace strategy). Until then the demo footer pill renders "Indexer pending (P3)" and `useIndexerStatus` short-circuits on Solana chain IDs. The status shape reserves `solanaMainnet/Devnet/Localnet` slots so a future indexer drops in cleanly.
4. **Performance / observability.** No structured indexer integration yet — see #3. Decide on Helius / Triton / custom Postgres ingest before broader user testing.

## Pending decisions (`docs/decision-log.md`)

| ID     | Decision                                                                                      | Type                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Custom-built `sooth_book` vs Monaco fork                                                      | Founder approval. Engineering recommendation: **fork** (2 hard sites, ~3-4 months). See `docs/research/monaco-investigation-week-01.md`. |
| **P3** | Indexer namespace strategy: widen `chainId` (text) or namespace Solana to integers (900/901)? | Founder.                                                                                                                                 |
| **P5** | Acceptance threshold for race-induced retries on Solana                                       | Operational target (suggest <5%); needs devnet to validate.                                                                              |
| **P6** | Privy Solana SDK eval                                                                         | Wallet UX; current demo uses `@solana/wallet-adapter-react`.                                                                             |
| **P7** | Pricing model: who pays priority fees?                                                        | Founder.                                                                                                                                 |
| **P8** | CLI port to Solana                                                                            | Low priority; deferable.                                                                                                                 |

## What's NOT in scope for this repo

- The EVM stack (lives in `sooth-alpha`).
- Apps consuming the EVM SDK (`sooth-alpha/apps/{telegram,market,world}`); only the demo is forked here as the SDK-compatibility test harness.
- HyperEVM precompile adjudicator and Lens post-action (chain-locked to EVM).
- The multi-actor CLI test harness — stays EVM-only per P8.

## Questions to escalate

Founder decisions: P1 (sooth_book direction — research complete), P3 (indexer namespace), P6 (Privy), P7 (priority fee model). Engineers can drive P5 (retry threshold; needs devnet first) and P8 (CLI port).
