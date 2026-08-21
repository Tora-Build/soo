# soo-arena

Arena social backend: Cloudflare Worker + D1. Serves `/api/arena/*` for the
demo app — profiles, wallet sign-in, daily claims, reactions, comments, and
play scoring. Wallets and markets are base58 Solana pubkeys, case-sensitive,
stored verbatim.

## Deploy

From `infra/arena-api/`, in order:

```sh
npx wrangler d1 create soo-arena
# paste the printed database_id into wrangler.toml (d1_databases -> database_id)

npx wrangler d1 migrations apply soo-arena --remote

npx wrangler deploy
```

Then set `VITE_ARENA_API_BASE` to the printed `https://soo-arena.<account>.workers.dev`
URL at demo build time (no trailing slash — the client appends `/api/arena/...`).

## Smoke test

```sh
BASE=https://soo-arena.<account>.workers.dev
curl -s "$BASE/api/arena/bootstrap" | head -c 200   # {"profile":null,"leaderboard":[],"social":null}
curl -s "$BASE/api/arena/bootstrap?wallet=EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw"  # guest profile echo
```

## Local dev

`npx wrangler dev` (local D1 is automatic; apply migrations first with
`npx wrangler d1 migrations apply soo-arena --local`).
