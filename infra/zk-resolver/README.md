# zk-resolver

Resolution service for `sooth_core` markets on devnet
(`EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw`). Two jobs:

1. **Attest.** Watch markets whose deadline has passed, obtain a Primus zkTLS
   attestation of the committed data source, and submit `attest_outcome_zk`.
2. **Void.** Compute the per-wallet T\* entitlement tree from the market's own
   event tape and publish a commitment to it (`--void`, see below).

It does **not** settle. `attest_outcome_zk` records an outcome and opens the
veto window; `settle` finalizes afterwards. That separation is the safety net
against a bad attestation, and this service deliberately stays on the recording
side of it.

---

## Runtime: a plain Node service, not a Cloudflare Worker

This is option (b), and the reason is not preference — the Primus SDK cannot
run on workerd. Evidence, all from `@primuslabs/zktls-core-sdk@0.2.6`:

| What the SDK needs | Where | Available on Workers |
| --- | --- | --- |
| Native N-API addon `build/Release/primus-zktls-native.node`, built by `node-gyp` from `binding.gyp` in an npm `install` hook; ships prebuilt `libprimus-zk.dylib` / `.so` | `src/primus_zk.ts`, `native/` | No — workerd cannot load native addons |
| WASM fallback: emscripten **pthreads** build (4.9 MB `client_plugin.wasm`) | `src/algorithm/` | No |
| `require("worker_threads")`, `parentPort`, `new Worker` | `client_plugin.worker.js`, `client_plugin.js` | No — `nodejs_compat` does not provide `worker_threads` |
| `fs.readFileSync` + `importScripts` implemented as `(0, eval)(...)` | `client_plugin.worker.js` | No — workerd forbids dynamic code generation |
| `SharedArrayBuffer` for the pthread heap | `client_plugin.js` | No |
| `global.WebSocket = require('ws')` at module load; `ws` is built on node `net` sockets | `src/primus_zk.ts:3` | No |

Beyond the module graph, the shape of the work is wrong for a Worker even if
the code loaded: `startAttestation` runs an MPC-TLS / proxy-TLS session over a
long-lived WebSocket to Primus' algorithm service and then polls
`getAttestationResult` every 500 ms for up to two minutes (default
`timeout = 2 * 60 * 1000`). That is wall-clock and CPU well past what a Worker
invocation is shaped for, and it is real computation, not I/O wait that
`waitUntil` can absorb.

So: a plain Node process, driven by cron, systemd, or a scheduled GitHub
Actions workflow. Deployment recipes for all three are below. Nothing here
pretends to be a Worker.

---

## How it works

One pass over `markets.json`. For each market:

1. **Read the chain.** Deadline, lifecycle, and the `AdjudicatorEntry` —
   attestor, comparator, threshold, value scale, `rule_hash`, and whether it is
   already attested.
2. **Skip what is not due.** Before the deadline, already attested, disputed,
   not zk-enabled, or already settled: nothing to do.
3. **Verify the rule.** `rule_hash` is a commitment to `(url, parsePath)`, and
   a hash cannot be inverted — so the endpoint has to come from `markets.json`.
   It is hashed and compared to the market's commitment before anything else
   happens. A mismatch is **refused loudly**, never attempted.
4. **Lock if needed.** `attest_outcome_zk` requires the market to be `Locked`.
   `request_lock` is signer-gated on `adjudicator_entry.authority`; the
   resolver does it only if its key *is* that authority, and otherwise reports
   the market as blocked rather than pretending.
5. **Attest.** Primus observes the endpoint inside a TLS session and signs what
   it saw. The result is verified locally — by Primus' own `verifyAttestation`
   and independently by this service's own encoder, the same one the program
   uses — before a fee is spent.
6. **Submit** `attest_outcome_zk`, then read the entry back and log the outcome
   the *chain* recorded.

### Idempotency

The **chain** is the authority, not any local file. A market with an
`attested_outcome` is skipped, and `attest_outcome_zk` independently rejects a
second attestation with `AlreadyAttested`. That holds across restarts, a
redeployed host, duplicated cron ticks, and two operators running the service
at once. `.state/resolver.json` adds only operational memory — the resolving
signature, and a retry backoff after failures. Deleting it is safe.

### Who signs, and why registration must match

The `appId` / `appSecret` authenticate this service to Primus and sign the
*request*. They do **not** sign the attestation. Every Primus attestation is
signed by Primus' global attestor:

```
0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6
```

**A market intended for real Primus attestations must be registered with that
address as its `attestor_evm`.** `register_zk_adjudicator` writes the attestor
once and it cannot be changed afterwards; get it wrong and the market can never
be resolved by this service. The Primus source refuses such a market up front
rather than burning a fee on a guaranteed `ZkAttestorMismatch`.

### What a real Primus attestation actually looks like

Recorded from a live `startAttestation` against Coinbase BTC-USD spot.
`scripts/primus-probe.mjs` reproduces it standalone, for one unit of quota and
no chain access:

```
recipient      "0x0000000000000000000000000000000000000000"   the default userAddress
request        { url, header: "", method: "GET", body: "" }   header BLANKED
reponseResolve [ { keyName: "amount", parseType: "", parsePath: "$.data.amount" } ]
data           "{\"amount\":\"76656.69\"}"                     single-key object
attConditions  "[{\"op\":\"REVEAL_STRING\",\"field\":\"$.data.amount\",\"reveal_id\":\"amount\"}]"
timestamp      1787319198412                                  MILLISECONDS
additionParams "{\"algorithmType\":\"proxytls\"}"               NON-EMPTY
attestors      [ { attestorAddr: "0xdb736b13…d8ef6", url: "https://primuslabs.xyz" } ]
signatures     [ 65 bytes, v = 0x1b ]
```

Four points that matter, all of which the program already handles:

- **`header` and `parseType` come back empty.** Primus moves the request
  headers into its own transport map and does not echo `parseType`. The digest
  is over what Primus returns, and the resolver submits exactly those fields,
  so the `header` / `parseType` in `markets.json` describe the request only.
- **`data` is the single-key object form** keyed by `keyName` — precisely one
  of the two shapes `zk/value.rs::extract_value_token` accepts.
- **`timestamp` is milliseconds.** `zk/verify.rs::normalize_timestamp` divides
  by 1000 above its `10^12` floor, so both readings are accepted and only one
  is possible for a given value.
- **`additionParams` is non-empty.** It is inside the digest and re-hashed on
  chain verbatim, well under the 512-byte cap; nothing interprets it.

Attested value precision varies between readings — 2 and 3 decimals were both
observed within a minute — and the program REJECTS a value carrying more
fractional digits than the registered `value_scale`. Register scale with
headroom (8 for a USD price feed), not with the feed's typical precision.

### Gemini

Optional, advisory, and **structurally off the resolution path**. It may help a
human author or sanity-check a rule *before* it goes on chain
(`node src/index.mjs --review`). It never decides an outcome — the on-chain
comparator does that, inside `zk::verify_attestation`, applied to a value that
arrived under a signature. The resolution loop never imports `gemini.mjs`, and
the model is never handed an attestation. See the boundary note at the top of
`src/gemini.mjs`.

---

## Layout

```
infra/zk-resolver/
  README.md
  package.json
  markets.json              the registry: market -> {url, parsePath, keyName}
  .env.example              secret names; copy to .env (gitignored)
  src/
    index.mjs               CLI, the pass, per-market orchestration
    resolve.mjs             the decision procedure — pure, unit-tested
    chain.mjs               Solana reads/writes, heap frame, HTTP confirmation
    registry.mjs            registry load/validate + rule-hash verification
    feed.mjs                endpoint fetch, parsePath, fixed point, comparators
    evm.mjs                 attestation encoding/signing/recovery + golden self-test
    config.mjs              env layering, keypair parsing (JSON or base58)
    state.mjs               the journal (operational memory, not the safety net)
    gemini.mjs              advisory rule review — OFF the resolution path
    deps.mjs                dependency resolution (installed, or from the monorepo)
    sources/
      primus.mjs            real Primus attestations
      fixture.mjs           locally-signed attestations, for the dry run
    void/
      merkle.mjs            leaf encoding + tree, written against the program
      entitlements.mjs      the FIFO accounting — pure, unit-tested
      tape.mjs              event replay: AMM logs + book emit_cpi inner ixs
      commitment.mjs        tape -> clamps -> tree -> ceilings -> artifact
      run.mjs               the `--void` pass
  scripts/
    dry-run-devnet.mjs      full loop against devnet, no Primus needed
    void-dry-run-devnet.mjs T* voiding end to end on devnet, on its own market
  test/
    rule.test.mjs           rule-hash verification, parsePath, fixed point
    idempotency.test.mjs    the decision procedure and the journal
    void-merkle.test.mjs    leaf preimages and tree shape, pinned byte for byte
    void-entitlements.test.mjs  the accounting convention
    void-commitment.test.mjs    clamps, leaf-per-account, per-venue ceilings
```

`@sooth/sdk-solana` is not published, so the resolver reads it from the
monorepo's built `dist/`. **Run this service from a checkout of the repo with
the SDK built.**

---

## T\* voiding

`--void` is the second thing this service does, and it is a different job from
attestation: it computes the per-wallet **entitlement tree** for a market whose
event became public at some T\* strictly before the lock, and publishes a
32-byte commitment to it. The mechanism, the trust model and the on-chain half
are in `docs/design/t-star-voiding.md`; this is the operator's half.

```sh
# Print the table and the root. Submits nothing, needs no key.
node src/index.mjs --void --only <market> --t-star auto

# The same computation, then publish_resolution_commitment.
node src/index.mjs --void --only <market> --t-star auto --publish
```

### Where T\* comes from

- **zkTLS markets** — `--t-star auto` reads the Primus attestation's own signed
  timestamp out of the `ZkOutcomeAttested` log (`attestation_ts`, normalized to
  unix seconds). `attest_outcome_zk` does not PERSIST it — `AdjudicatorEntry`
  has one reserved byte left — but it emits it, so the value is public and a
  disputer checks it the same way this reads it. It is when the attestor
  LOOKED, not when the event happened, so it is an upper bound on the true T\*
  and errs toward voiding less.
- **Manual markets** — `--t-star <unix seconds>`, the operator's stated
  judgement, evidenced off-chain and disputable like everything else. The
  program only enforces `start_time < t_star <= min(attested_at, deadline)`.

### The accounting convention

Stamped into every artifact as `sooth-tstar/fifo-v1`, because a tree is only
checkable if the function that produced it is stated:

- Every acquisition is a **lot** carrying `{shares, cost, ts}`.
- **Sells retire the earliest lots first (FIFO)**, in acquisition order,
  regardless of when the sell happened. A post-T\* sale does **not** return
  shares to the pre-T\* pool: a wallet that bought pre-T\*, bought again
  post-T\*, then sold, is left holding its POST-T\* lots. The alternative
  hands the informed trader a free unwind — buy after T\*, sell after T\*,
  keep the pre-T\* settlement and the proceeds.
- Of the lots still held: `ts <= T*` settles normally; `ts > T*` is voided, pays
  nothing, and its **cost** comes back instead.
- Partial sells shrink a lot's shares and cost pro rata, floored.
- The book is the same rule on its single signed axis: a fill closes existing
  opposite exposure before it opens anything, and only the opening part carries
  basis (`split_delta`, mirrored).

Every entitlement is then **clamped** against the account the program will check
it against — `valid_* <= held`, `refund <= locked_cost_usdc`, and on the book
same-side-and-no-larger with the refund capped at the voided shares' face value.
A leaf that violates any of those verifies against the root and then fails to
pay, so the clamp happens here; where it bites, the run says so, because the
only honest reason is a tape that did not reach far enough.

### The proof artifact

One JSON per market, at `.state/resolutions/<market>.json` (override with
`--out`). This is the proof distribution: a wallet **cannot redeem a voided
position without it**, because a live commitment makes the claim argument
mandatory.

```json
{
  "version": 1,
  "market": "...", "programId": "...", "convention": "sooth-tstar/fifo-v1",
  "tStar": 1787385553, "tStarSource": "operator",
  "merkleRoot": "0x5512...", "leafCount": 1,
  "totalVoidRefundUsdc": "3174765", "totalBookVoidRefundUsdc": "0",
  "anomalies": [],
  "leaves": [ { "index": 0, "venue": "amm", "wallet": "...",
                "validYesWad": "...", "validNoWad": "...",
                "voidRefundUsdc": "...", "leaf": "0x...", "proof": ["0x..."] } ],
  "byWallet": { "<wallet>": { "amm": { ... }, "book": { ... } } }
}
```

`byWallet` is the index a UI uses: one lookup by address yields exactly the
argument `redeem_amm_position` / `redeem_book_seat` take. `leaves` keeps the
ORDERED list beside it, because the tree's shape depends on that order — AMM
leaves first, then book leaves, each sorted by raw pubkey bytes ascending — and
a third party reproducing the root needs it.

A run whose tree does not match the root already on chain writes
`<market>.mismatch.json` and leaves the live file alone. Overwriting would
replace every live proof with proofs against a root nobody published.

### Publishing, and the veto window

`publish_resolution_commitment` is accepted only while
`now < attested_at + veto_period_secs`, and it is **one-shot**: the PDA is
created with `init`, so a second call fails and only the dispute authority's
`revoke_resolution_commitment` clears the way. That is why `--void` prints by
default and publishes only when asked.

**On this devnet deployment `veto_period_secs` is 2.** A window that short is
shorter than a confirmation round trip, so a resolver that attests and then
starts replaying the tape has already missed it. Two consequences:

- compute the tree **before** the lock — trading stops there, so the tape is
  final and nothing is lost by being early;
- attest and publish in **one transaction**. `publish_resolution_commitment`
  reads `attested_at` from an account the instruction before it just wrote, and
  the window it checks is genuinely open at that instant.
  `scripts/void-dry-run-devnet.mjs --publish` does exactly this.

`--void --publish` checks the window before building anything and reports the
remaining seconds, so a closed window is a message rather than a rejected
signature.

The other refusal worth knowing: publication is gated on the vaults covering
what it promises, **per venue**, and the bound is deliberately conservative — a
voided share is counted twice, once at face in the outstanding ledger and again
inside the refund ceiling. A thin market can therefore be refused
(`1017 CommitmentExceedsVault`) for a tree it could in fact afford. Refusing an
honest-but-large commitment costs the voiding; accepting an insolvent one costs
somebody their redemption.

### Proving it

```sh
npm test                              # 69 tests, of which 40 are the void path
node scripts/void-dry-run-devnet.mjs  # devnet, own throwaway market, no publish
```

The tree this service builds is checked against the Rust verifier by
`packages/sdk-solana/tests/t-star-voiding-resolver.test.ts`, which imports
`src/void/merkle.mjs` and `src/void/entitlements.mjs` and hands their output to
the real `publish_resolution_commitment` / `redeem_amm_position` on LiteSVM. An
encoding mismatch is the single most likely way to build a worthless tree, and
that round trip is what rules it out.

---

## Deploy

From `infra/zk-resolver/`, in order:

```sh
# 1. Build the SDK the resolver reads (from the repo root).
cd ../.. && pnpm install && pnpm -F @sooth/sdk-solana build && cd infra/zk-resolver

# 2. Install this service's own dependencies.
#    The Primus SDK builds a native addon on macOS arm64 and Ubuntu.
npm install

# 3. Provide secrets (see the two options below).

# 4. Register the markets you want watched in markets.json.

# 5. Verify without submitting anything.
node src/index.mjs --once --plan

# 6. Run one real pass.
node src/index.mjs --once
```

### Secrets

Never hardcoded, never committed. Either real environment variables:

```sh
export SOLANA_RPC_URL='https://api.devnet.solana.com'
export RESOLVER_KEYPAIR="$(cat ~/.config/solana/zk-resolver.json)"
export PRIMUS_APP_ID='...'
export PRIMUS_APP_SECRET='...'
export GEMINI_API_KEY='...'        # optional, --review only
```

or a gitignored dotenv file:

```sh
cp .env.example .env
$EDITOR .env
node src/index.mjs --once --env-file .env
```

`RESOLVER_KEYPAIR` is a **funded fee payer, not a privileged key** —
`attest_outcome_zk` is permissionless and the attestation carries its own
authority. Fund it on devnet:

```sh
solana-keygen new -o ~/.config/solana/zk-resolver.json
solana airdrop 2 "$(solana-keygen pubkey ~/.config/solana/zk-resolver.json)" --url devnet
```

The one exception: if you also want the resolver to `request_lock` markets that
are past their deadline but still `Open`, this key must **be** the market's
`adjudicator_entry.authority`. Otherwise lock them yourself and the resolver
will attest them on its next pass.

### Registering a market so this service can resolve it

`markets.json` entries must describe exactly what the market committed to:

```json
{
  "markets": [
    {
      "market": "7dJPap1jJWX29P365vnTnTBoaNk4GomYxPeV9Ua4LGKE",
      "label": "btc-spot",
      "url": "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      "parsePath": "$.data.amount",
      "keyName": "amount"
    }
  ]
}
```

and the market must have been registered with
`attestorEvm = 0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6` and
`ruleHash = computeRuleHash(url, parsePath)`. `--plan` reports a mismatch of
either without submitting anything.

### Scheduling, roughly every 5 minutes

**cron:**

```cron
*/5 * * * * cd /srv/soo/infra/zk-resolver && /usr/bin/node src/index.mjs --once --env-file .env >> /var/log/zk-resolver.log 2>&1
```

**systemd** (`zk-resolver.service` + `zk-resolver.timer`):

```ini
# zk-resolver.service
[Unit]
Description=Sooth zkTLS resolver
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/srv/soo/infra/zk-resolver
EnvironmentFile=/etc/zk-resolver.env
ExecStart=/usr/bin/node src/index.mjs --once
```

```ini
# zk-resolver.timer
[Unit]
Description=Run the Sooth zkTLS resolver every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl enable --now zk-resolver.timer
```

**GitHub Actions** (`.github/workflows/zk-resolver.yml`, secrets in repo
settings):

```yaml
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:

jobs:
  resolve:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: pnpm install && pnpm -F @sooth/sdk-solana build
      - run: npm install
        working-directory: infra/zk-resolver
      - run: node src/index.mjs --once
        working-directory: infra/zk-resolver
        env:
          SOLANA_RPC_URL: ${{ secrets.SOLANA_RPC_URL }}
          RESOLVER_KEYPAIR: ${{ secrets.RESOLVER_KEYPAIR }}
          PRIMUS_APP_ID: ${{ secrets.PRIMUS_APP_ID }}
          PRIMUS_APP_SECRET: ${{ secrets.PRIMUS_APP_SECRET }}
```

Or run it as a long-lived process instead of a scheduled one:
`node src/index.mjs --watch` (interval from `RESOLVER_INTERVAL_MS`, default
5 minutes).

---

## Smoke test

```sh
# Unit tests — rule-hash verification, the decision procedure, the journal.
npm test

# Read-only. Needs no keys and no Primus credentials; submits nothing.
node src/index.mjs --once --plan

# Full loop against devnet with a locally-signed attestation instead of
# Primus. Creates its own throwaway markets; touches none of yours.
SOLANA_RPC_URL='<devnet rpc>' node scripts/dry-run-devnet.mjs

# T* voiding end to end on devnet: its own market, traded on both sides of a
# T* it chooses, replayed off the cluster. Publishes nothing without --publish.
node scripts/void-dry-run-devnet.mjs
```

The dry run is the end-to-end proof: it exercises deadline detection,
rule-hash verification, locking, submission, read-back, idempotency across a
simulated restart, and refusal on a rule mismatch — everything except the
Primus call itself.

---

## CLI

```
--once             one pass, exit (default; what cron runs)
--watch            loop, RESOLVER_INTERVAL_MS between passes
--plan             read chain state and report; submits nothing
--review           Gemini rule review (advisory, never resolves)
--source <name>    "primus" (default) or "fixture"
--only <market>    restrict to one market pubkey
--env-file <path>  load secrets from a dotenv file

--void             compute the T* entitlement tree and print it (see below)
--t-star <v>       T*: unix seconds, or "auto"
--publish          also submit publish_resolution_commitment
--out <dir>        where the proof JSON lands (default .state/resolutions)
--max-signatures   ceiling on the tape walk (default 20000)
```

Exit code is non-zero when any market was **refused** (a configuration error
your scheduler should surface). Transient failures are logged, backed off, and
retried on the next pass without failing the run.
