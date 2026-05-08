#!/usr/bin/env bash
# One-command Surfpool spinup for the Sooth Solana demo.
#
# Drop-in for `dev:localnet` that swaps `solana-test-validator` for
# `surfpool` (https://surfpool.run). Why bother:
#
#   - Sub-second startup vs ~10s for solana-test-validator.
#   - 22 cheatcodes incl. `surfnet_timeTravel` — bridges the 24h sell-lock
#     gate that blocks claim_unlocked / operator settle UI smoke on
#     localnet (test-validator has no setClock).
#   - Mainnet-state cloning on demand (see `--network mainnet` flag).
#   - Built-in transaction profiling + Studio web UI.
#
# Flow:
#   1. Pre-flight: surfpool installed; .so files built.
#   2. Stop a previously-launched surfpool we started (PID file).
#   3. Refuse to clobber an unrelated process on the RPC port.
#   4. `seed-localnet.mjs prepare` → write USDC mint JSON dump.
#   5. Boot `surfpool start --ci --offline` from the Anchor workspace —
#      Surfpool auto-detects the workspace, generates a default txtx.yml
#      if none exists, and deploys all 5 programs from target/deploy
#      to their declared addresses (per Anchor.toml [programs.localnet]).
#   6. Wait for RPC health.
#   7. Curl `surfnet_setAccount` to load the canonical USDC mint at
#      4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU. (Surfpool's
#      `--snapshot` flag would handle this declaratively but means
#      pre-baking a JSON file; cheatcode keeps the script self-contained.)
#   8. `seed-localnet.mjs init` (unchanged — still talks to 8899 via RPC).
#   9. Boot vite.
#
# Cheatcode helper for time-sensitive flows:
#   ./scripts/surfnet-cheats.sh time-travel --seconds 86400
#   See the script for the full surfaced cheat menu.
#
# Safety: only kills processes from the PID file we wrote.

set -euo pipefail

# ─── Resolve paths ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../.." && pwd)"
ANCHOR_WORKSPACE="$REPO_ROOT/packages/programs-core"

LOCALNET_DIR="$DEMO_DIR/.localnet"
SURFPOOL_PID_FILE="$DEMO_DIR/.surfpool.pid"
SURFPOOL_LOG="$LOCALNET_DIR/surfpool.log"
USDC_DUMP="$LOCALNET_DIR/usdc-mint-account.json"

USDC_MINT_ADDR="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

VITE_PORT="${VITE_PORT:-5175}"
RPC_PORT="${RPC_PORT:-8899}"

mkdir -p "$LOCALNET_DIR"

log() { printf "[dev-surfpool] %s\n" "$*"; }
err() { printf "[dev-surfpool] ERROR: %s\n" "$*" >&2; }

rpc() {
  curl -sS -X POST -H "Content-Type: application/json" \
    --data "$1" "http://127.0.0.1:$RPC_PORT"
}

# ─── Pre-flight ────────────────────────────────────────────────────────────
if ! command -v surfpool >/dev/null 2>&1; then
  err "surfpool not found on PATH. Install via:"
  err "  curl -sL https://run.surfpool.run/ | bash"
  err "Or with cargo:"
  err "  cargo install surfpool-cli"
  exit 1
fi

for so in sooth_amm sooth_market sooth_launchpad sooth_adjudicator sooth_book; do
  if [[ ! -f "$REPO_ROOT/target/deploy/${so}.so" ]]; then
    err "missing $REPO_ROOT/target/deploy/${so}.so"
    err "Run from repo root: cd packages/programs-core && cargo build-sbf"
    exit 1
  fi
done

# ─── Stop a previously-launched surfpool (only ours) ──────────────────────
if [[ -f "$SURFPOOL_PID_FILE" ]]; then
  OLD_PID="$(cat "$SURFPOOL_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    if ps -p "$OLD_PID" -o command= 2>/dev/null | grep -q surfpool; then
      log "stopping previous surfpool (PID $OLD_PID)"
      kill "$OLD_PID" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$OLD_PID" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
  fi
  rm -f "$SURFPOOL_PID_FILE"
fi

# ─── Refuse to clobber an unrelated process on the RPC port ──────────────
if lsof -nP -iTCP:"$RPC_PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  err "port $RPC_PORT already in use. Another validator/surfpool may be running."
  err "Stop it first or set RPC_PORT=<other>."
  exit 1
fi

# ─── Phase 1: USDC mint JSON dump ─────────────────────────────────────────
log "phase 1: prepare USDC mint dump"
(cd "$DEMO_DIR" && node scripts/seed-localnet.mjs prepare)

if [[ ! -f "$USDC_DUMP" ]]; then
  err "phase 1 did not produce $USDC_DUMP"
  exit 1
fi

# ─── Phase 2: boot surfpool ──────────────────────────────────────────────
log "phase 2: booting surfpool on :$RPC_PORT"
log "  workspace: $ANCHOR_WORKSPACE"
log "  log:       $SURFPOOL_LOG"

# `--ci` disables the TUI, Studio, profiling, and verbose logs — same shape
# as a CI pipeline would want. `--offline` cuts the lazy mainnet-clone
# behavior so localnet stays self-contained. Surfpool auto-deploys all 5
# programs from target/deploy to the addresses declared in Anchor.toml's
# `[programs.localnet]` block on first start (it generates a default
# txtx.yml runbook if none exists).
NO_DNA=1 surfpool start \
  --ci \
  --offline \
  --port "$RPC_PORT" \
  --manifest-file-path "$ANCHOR_WORKSPACE/Anchor.toml" \
  >"$SURFPOOL_LOG" 2>&1 &
SURFPOOL_PID=$!
echo "$SURFPOOL_PID" > "$SURFPOOL_PID_FILE"
log "surfpool PID: $SURFPOOL_PID"

cleanup() {
  log "cleanup: stopping surfpool (PID $SURFPOOL_PID)"
  kill "$SURFPOOL_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$SURFPOOL_PID" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$SURFPOOL_PID" 2>/dev/null || true
  rm -f "$SURFPOOL_PID_FILE"
}
trap cleanup EXIT INT TERM

# ─── Wait for RPC readiness ──────────────────────────────────────────────
log "waiting for surfpool RPC to become healthy..."
HEALTHY=0
for i in $(seq 1 60); do
  if ! kill -0 "$SURFPOOL_PID" 2>/dev/null; then
    err "surfpool process exited early — see $SURFPOOL_LOG"
    tail -40 "$SURFPOOL_LOG" >&2 || true
    exit 1
  fi
  if curl -sf -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
    "http://127.0.0.1:$RPC_PORT" >/dev/null 2>&1; then
    HEALTHY=1
    log "surfpool healthy after ${i}s"
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" != "1" ]]; then
  err "surfpool did not become healthy within 60s"
  err "check $SURFPOOL_LOG"
  exit 1
fi

# ─── Phase 2.4: airdrop deploy payer + deploy 5 programs ─────────────────
#
# Surfpool with `--ci --offline --manifest-file-path` does NOT auto-deploy
# the .so binaries; it only registers the program IDs from
# `[programs.localnet]` for txtx workflows. Deploy via solana CLI against
# the canonical declare_id! pubkeys (kept in lockstep across the IDLs +
# Anchor.toml + this script per docs/decision-log.md D6).
DEPLOY_PAYER="$DEMO_DIR/.deploy-payer.json"
if [[ ! -f "$DEPLOY_PAYER" ]]; then
  err "missing $DEPLOY_PAYER (deploy payer keypair)"
  exit 1
fi
DEPLOY_PAYER_PUBKEY="$(solana-keygen pubkey "$DEPLOY_PAYER")"
log "phase 2.4: airdrop 1000 SOL to deploy payer $DEPLOY_PAYER_PUBKEY"
rpc "$(printf '{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","params":["%s",1000000000000]}' "$DEPLOY_PAYER_PUBKEY")" >/dev/null
sleep 1
log "  deploying 5 programs (sooth_amm / market / launchpad / adjudicator / book)"
for so in sooth_amm sooth_market sooth_launchpad sooth_adjudicator sooth_book; do
  SO_PATH="$REPO_ROOT/target/deploy/${so}.so"
  KP_PATH="$REPO_ROOT/target/deploy/${so}-keypair.json"
  if [[ ! -f "$KP_PATH" ]]; then
    err "missing $KP_PATH"
    exit 1
  fi
  log "    deploy $so"
  solana program deploy "$SO_PATH" \
    --program-id "$KP_PATH" \
    --keypair "$DEPLOY_PAYER" \
    --url "http://127.0.0.1:$RPC_PORT" \
    --use-rpc \
    --output json 2>&1 | tail -1 >> "$SURFPOOL_LOG" || {
      err "$so deploy failed — see $SURFPOOL_LOG"
      exit 1
    }
done

# ─── Phase 2.5: load USDC mint via cheatcode ─────────────────────────────
#
# Surfpool's auto-deploy handles the 4 .so binaries but doesn't know about
# the USDC mint account dump. Load it via `surfnet_setAccount`. The dump
# format mirrors `solana account --output json` — we extract lamports +
# data + owner inline rather than requiring a snapshot file.
log "phase 2.5: load USDC mint at $USDC_MINT_ADDR"
# Surfpool's `surfnet_setAccount` accepts `data` as a hex string, NOT the
# `[base64string, "base64"]` tuple `solana account --output json` produces
# (which is what test-validator's `--account` flag consumes). Translate.
USDC_DATA="$(node -e '
const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const acc = j.account ?? j;
const dataHex = Array.isArray(acc.data)
  ? Buffer.from(acc.data[0], acc.data[1] ?? "base64").toString("hex")
  : Buffer.from(acc.data, "base64").toString("hex");
process.stdout.write(JSON.stringify({
  lamports: acc.lamports,
  data: dataHex,
  owner: acc.owner,
  executable: acc.executable ?? false,
  rentEpoch: acc.rentEpoch ?? 0,
}));
' "$USDC_DUMP")"

rpc "$(printf '{"jsonrpc":"2.0","id":1,"method":"surfnet_setAccount","params":["%s",%s]}' \
  "$USDC_MINT_ADDR" "$USDC_DATA")" >/dev/null

# ─── Phase 3: bootstrap protocol state ───────────────────────────────────
log "phase 3: init protocol + market + fund user"
(cd "$DEMO_DIR" && SOLANA_RPC_URL="http://127.0.0.1:$RPC_PORT" node scripts/seed-localnet.mjs init)

# ─── Phase 4: vite ───────────────────────────────────────────────────────
log "phase 4: starting vite on :$VITE_PORT"
log ""
log "==== Cheatcode pointers ===="
log "  Time-travel past the 24h sell-lock window:"
log "    bash scripts/surfnet-cheats.sh time-travel --seconds 86400"
log "  Pause / resume the clock for stable replay:"
log "    bash scripts/surfnet-cheats.sh pause"
log "    bash scripts/surfnet-cheats.sh resume"
log "  Reset to initial state without restarting:"
log "    bash scripts/surfnet-cheats.sh reset"
log ""

cd "$DEMO_DIR"
exec node node_modules/vite/bin/vite.js --port "$VITE_PORT"
