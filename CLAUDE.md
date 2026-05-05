# CLAUDE.md — sooth-solana

Solana implementation of the Sooth Protocol. Companion repo to [`Tora-Build/sooth-alpha`](https://github.com/Tora-Build/sooth-alpha) (the EVM home). Will hold Anchor programs (`packages/programs-core/`) and the `@sooth/sdk-solana` TypeScript adapter. Currently spec-only — no Rust, no TypeScript implementation, just design docs and workspace bootstrap.

## Status

**Specs only, no code yet.** Workspace bootstraps (`Cargo.toml`, `package.json`, `pnpm-workspace.yaml`) are intentionally empty.

## Onboarding

- `HANDOVER.md` — canonical onboarding doc. Read it first.
- `docs/decision-log.md` — source of truth for what's resolved vs open.

## License

Apache-2.0.

## Guardrail

Do not write production code without explicit founder ask — implementation is gated on spikes P1 and P2 (see `docs/decision-log.md`).
