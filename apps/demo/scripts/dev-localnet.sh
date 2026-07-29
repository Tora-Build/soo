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

USDC_MINT_ADDR="H7hBn9A1MDuKLhLji26bkRv5P3zMnp9jQmxNo76wsGyK"

AMM_SO="$REPO_ROOT/target/deploy/sooth_amm.so"
MARKET_SO="$REPO_ROOT/target/deploy/sooth_market.so"
LAUNCHPAD_SO="$REPO_ROOT/target/deploy/sooth_launchpad.so"
ADJUDICATOR_SO="$REPO_ROOT/target/deploy/sooth_adjudicator.so"
BOOK_SO="$REPO_ROOT/target/deploy/sooth_book.so"

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

# The seed script reads program IDs from the built SDK IDLs/constants. Keep
# validator preload ids aligned with that exact source of truth.
read -r SOOTH_AMM_ID SOOTH_MARKET_ID SOOTH_LAUNCHPAD_ID SOOTH_ADJUDICATOR_ID SOOTH_BOOK_ID < <(
  REPO_ROOT="$REPO_ROOT" node --input-type=module <<'NODE'
const root = process.env.REPO_ROOT;
const sdk = `${root}/packages/sdk-solana/dist`;
const anchor = await import(new URL(`file://${sdk}/anchor/index.js`).href);
const pdas = await import(new URL(`file://${sdk}/pdas.js`).href);
const id = (idlAddress, fallback) => idlAddress || fallback.toBase58();
process.stdout.write([
  anchor.soothAmmIdl.address,
  id(anchor.soothMarketIdl.address, pdas.SOOTH_MARKET_PROGRAM_ID),
  id(anchor.soothLaunchpadIdl.address, pdas.SOOTH_LAUNCHPAD_PROGRAM_ID),
  anchor.soothAdjudicatorIdl.address,
  id(anchor.soothBookIdl.address, pdas.SOOTH_BOOK_PROGRAM_ID),
].join(" ") + "\n");
NODE
)

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
