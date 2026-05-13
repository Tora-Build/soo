#!/usr/bin/env bash
# One-command localnet spinup for the Sooth Solana demo.
#
#   1. Kills any leftover solana-test-validator we previously started
#      (recorded in apps/demo/.localnet.pid).
#   2. Runs `seed-localnet.mjs prepare` to write a USDC mint JSON dump.
#   3. Boots solana-test-validator --reset with all Sooth programs deployed
#      from target/deploy/*.so AND the USDC mint preloaded at the canonical
#      address via --account.
#   4. Waits for the validator to be healthy.
#   5. Runs `seed-localnet.mjs init` to airdrop SOL, mint USDC, init a market,
#      and write apps/demo/.env.local.
#   6. Boots vite on the demo's configured port (foreground).
#   7. On Ctrl-C, kills the validator we started.
#
# Does NOT touch the user's running vite at PID 57333 — see the
# `Constraints` section of the task brief. We use vite's `--port` flag to
# pick a different port if 5175 is taken.
#
# Safety: only kills processes from the PID file we wrote (no broad pkill).

set -euo pipefail

# ─── Resolve paths ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../.." && pwd)"

LOCALNET_DIR="$DEMO_DIR/.localnet"
VALIDATOR_PID_FILE="$DEMO_DIR/.localnet.pid"
VALIDATOR_LOG="$LOCALNET_DIR/validator.log"
LEDGER_DIR="$LOCALNET_DIR/ledger"
USDC_DUMP="$LOCALNET_DIR/usdc-mint-account.json"

USDC_MINT_ADDR="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

AMM_SO="$REPO_ROOT/target/deploy/sooth_amm.so"
MARKET_SO="$REPO_ROOT/target/deploy/sooth_market.so"
LAUNCHPAD_SO="$REPO_ROOT/target/deploy/sooth_launchpad.so"
ADJUDICATOR_SO="$REPO_ROOT/target/deploy/sooth_adjudicator.so"
BOOK_SO="$REPO_ROOT/target/deploy/sooth_book.so"

AMM_KEYPAIR="$REPO_ROOT/target/deploy/sooth_amm-keypair.json"
MARKET_KEYPAIR="$REPO_ROOT/target/deploy/sooth_market-keypair.json"
LAUNCHPAD_KEYPAIR="$REPO_ROOT/target/deploy/sooth_launchpad-keypair.json"
ADJUDICATOR_KEYPAIR="$REPO_ROOT/target/deploy/sooth_adjudicator-keypair.json"
BOOK_KEYPAIR="$REPO_ROOT/target/deploy/sooth_book-keypair.json"

VITE_PORT="${VITE_PORT:-5175}"
RPC_PORT="${RPC_PORT:-8899}"

mkdir -p "$LOCALNET_DIR"

log() { printf "[dev-localnet] %s\n" "$*"; }
err() { printf "[dev-localnet] ERROR: %s\n" "$*" >&2; }

# ─── Pre-flight: tools + .so files ────────────────────────────────────────
if ! command -v solana-test-validator >/dev/null 2>&1; then
  err "solana-test-validator not found on PATH. Install via:"
  err "  sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
  exit 1
fi

for so in "$AMM_SO" "$MARKET_SO" "$LAUNCHPAD_SO" "$ADJUDICATOR_SO" "$BOOK_SO"; do
  if [[ ! -f "$so" ]]; then
    err "missing $so"
    err "Run from repo root: cd packages/programs-core && cargo build-sbf"
    exit 1
  fi
done

for keypair in "$AMM_KEYPAIR" "$MARKET_KEYPAIR" "$LAUNCHPAD_KEYPAIR" "$ADJUDICATOR_KEYPAIR" "$BOOK_KEYPAIR"; do
  if [[ ! -f "$keypair" ]]; then
    err "missing $keypair"
    err "Run from repo root: cd packages/programs-core && cargo build-sbf"
    exit 1
  fi
done

# The seed script reads program IDs from generated IDL addresses, which are
# regenerated from target/deploy keypairs. Keep validator preload ids aligned.
SOOTH_AMM_ID="$(solana address -k "$AMM_KEYPAIR")"
SOOTH_MARKET_ID="$(solana address -k "$MARKET_KEYPAIR")"
SOOTH_LAUNCHPAD_ID="$(solana address -k "$LAUNCHPAD_KEYPAIR")"
SOOTH_ADJUDICATOR_ID="$(solana address -k "$ADJUDICATOR_KEYPAIR")"
SOOTH_BOOK_ID="$(solana address -k "$BOOK_KEYPAIR")"

# ─── Stop a previously-launched validator (only ours) ─────────────────────
if [[ -f "$VALIDATOR_PID_FILE" ]]; then
  OLD_PID="$(cat "$VALIDATOR_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    # Verify the PID actually belongs to a solana-test-validator before
    # killing — guard against PID reuse on long-lived shells.
    if ps -p "$OLD_PID" -o command= 2>/dev/null | grep -q solana-test-validator; then
      log "stopping previous validator (PID $OLD_PID)"
      kill "$OLD_PID" 2>/dev/null || true
      # Wait up to 10s for graceful shutdown
      for _ in $(seq 1 20); do
        kill -0 "$OLD_PID" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
  fi
  rm -f "$VALIDATOR_PID_FILE"
fi

# ─── Refuse to clobber an unrelated validator on the RPC port ─────────────
if lsof -nP -iTCP:"$RPC_PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  err "port $RPC_PORT already in use. A validator may be running outside this script."
  err "Stop it first or set RPC_PORT=<other> (note: validator/RPC ports are coupled,"
  err "and the demo currently expects 8899 — change apps/demo/.env.local accordingly)."
  exit 1
fi

# ─── Phase 1: write USDC mint JSON dump ───────────────────────────────────
log "phase 1: prepare USDC mint dump"
(cd "$DEMO_DIR" && node scripts/seed-localnet.mjs prepare)

if [[ ! -f "$USDC_DUMP" ]]; then
  err "phase 1 did not produce $USDC_DUMP"
  exit 1
fi

# ─── Boot validator ───────────────────────────────────────────────────────
log "phase 2: booting solana-test-validator on :$RPC_PORT"
log "  programs:"
log "    sooth_amm         = $SOOTH_AMM_ID"
log "    sooth_market      = $SOOTH_MARKET_ID"
log "    sooth_launchpad   = $SOOTH_LAUNCHPAD_ID"
log "    sooth_adjudicator = $SOOTH_ADJUDICATOR_ID"
log "    sooth_book        = $SOOTH_BOOK_ID"
log "  preloaded mint: $USDC_MINT_ADDR (.localnet/usdc-mint-account.json)"
log "  ledger: $LEDGER_DIR"
log "  log:    $VALIDATOR_LOG"

# --reset wipes the ledger so each run starts clean.
# --quiet suppresses the per-slot status spam; we still capture stderr.
# Run in background so we can run phase 3 + vite in foreground.
solana-test-validator \
  --reset \
  --quiet \
  --rpc-port "$RPC_PORT" \
  --ledger "$LEDGER_DIR" \
  --bpf-program "$SOOTH_AMM_ID" "$AMM_SO" \
  --bpf-program "$SOOTH_MARKET_ID" "$MARKET_SO" \
  --bpf-program "$SOOTH_LAUNCHPAD_ID" "$LAUNCHPAD_SO" \
  --bpf-program "$SOOTH_ADJUDICATOR_ID" "$ADJUDICATOR_SO" \
  --bpf-program "$SOOTH_BOOK_ID" "$BOOK_SO" \
  --account "$USDC_MINT_ADDR" "$USDC_DUMP" \
  >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID=$!
echo "$VALIDATOR_PID" > "$VALIDATOR_PID_FILE"
log "validator PID: $VALIDATOR_PID"

cleanup() {
  log "cleanup: stopping validator (PID $VALIDATOR_PID)"
  kill "$VALIDATOR_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$VALIDATOR_PID" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$VALIDATOR_PID" 2>/dev/null || true
  rm -f "$VALIDATOR_PID_FILE"
}
trap cleanup EXIT INT TERM

# ─── Wait for validator readiness ─────────────────────────────────────────
log "waiting for validator to become healthy..."
HEALTHY=0
for i in $(seq 1 60); do
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    err "validator process exited early — see $VALIDATOR_LOG"
    tail -40 "$VALIDATOR_LOG" >&2 || true
    exit 1
  fi
  if solana cluster-version --url "http://127.0.0.1:$RPC_PORT" >/dev/null 2>&1; then
    HEALTHY=1
    log "validator healthy after ${i}s"
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" != "1" ]]; then
  err "validator did not become healthy within 60s"
  err "check $VALIDATOR_LOG"
  exit 1
fi

# ─── Phase 3: init market + airdrop USDC ──────────────────────────────────
log "phase 3: init market + fund user"
(cd "$DEMO_DIR" && SOLANA_RPC_URL="http://127.0.0.1:$RPC_PORT" node scripts/seed-localnet.mjs init)

# ─── Phase 4: vite ────────────────────────────────────────────────────────
log "phase 4: starting vite on :$VITE_PORT"
log "  if port is taken, vite will fail — set VITE_PORT=<other> and retry"

# Foreground vite. Use --port to honor the env override.
cd "$DEMO_DIR"
exec node node_modules/vite/bin/vite.js --port "$VITE_PORT"
