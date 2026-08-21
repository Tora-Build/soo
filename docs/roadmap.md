# Roadmap — sooth-solana

> What is left, in priority order. Current state lives in
> [`status.md`](./status.md).

## Active

1. **Harden the devnet deployment.** Keep the program, the seed scripts, and
   both frontend surfaces in lockstep across upgrades; the deployed buffer carries
   headroom so an upgrade does not need a manual resize step.
2. **Guardian allowlist for the veto.** `dispute` is held by a single
   `dispute_authority`. Widening it to an allowlist is the remaining gap in the
   manual adjudicator's trust story.
3. **Observability.** Measure transaction retry rate under devnet load, with a
   target below 5%, and report RPC fallback behaviour during user testing.
4. **Indexing at production scale.** `apps/demo` reads accounts and CPI events
   directly, which suffices at demo scale. `packages/sooth-data` indexes the
   same data but is not deployed and not wired into the frontend; a busy market
   wants Geyser behind it. Decide the boundary before mainnet.

## Not in scope for this repo

- The EVM stack (lives in `sooth-alpha`).
- EVM-only apps (`sooth-alpha/apps/{telegram,market,world}`).
- HyperEVM precompile adjudicator and Lens post-action (chain-locked to EVM).
- The multi-actor CLI test harness — EVM-only.
- Off-chain signed orders, retroactive `T*` settlement, and three-outcome
  markets.
