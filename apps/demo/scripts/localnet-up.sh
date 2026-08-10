#!/usr/bin/env bash
# Boot the validator ALONE, detached from vite.
#
# `dev-localnet.sh` runs vite in the foreground and traps its exit to stop the
# validator. That is right for a one-command demo, and wrong for development:
# restarting vite to pick up a code change also kills the chain. The symptom is
# nasty — the UI keeps working, every on-chain read quietly degrades to empty,
# and the market reads as "not graduated", so the orderbook simply disappears
# with nothing on screen saying the chain is gone.
#
# This script boots only the validator and leaves it running. Restart vite as
# often as you like; the chain outlives it.
#
#   bash scripts/localnet-up.sh          # boot (leaves ledger intact if warm)
#   bash scripts/localnet-up.sh --reset  # wipe and boot clean
#   bash scripts/localnet-down.sh        # stop it
#
# After a --reset, re-seed with:  bash scripts/seed-fixture.sh <wallet>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../.." && pwd)"

LOCALNET_DIR="$DEMO_DIR/.localnet"
PID_FILE="$DEMO_DIR/.localnet.pid"
LOG="$LOCALNET_DIR/validator.log"
LEDGER_DIR="$LOCALNET_DIR/ledger"
# One mint per venue, both pinned by `address = ...` in the program, so both
# must be preloaded or create_market fails on a constraint that does not
# mention a missing mint.
USDC_DUMP="$LOCALNET_DIR/usdc-mint-account.json"
USDC_MINT_ADDR="ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"
AMM_DUMP="$LOCALNET_DIR/amm-mint-account.json"
AMM_MINT_ADDR="CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu"
CORE_SO="$REPO_ROOT/target/deploy/sooth_core.so"
RPC_PORT="${RPC_PORT:-8899}"

RESET=""
[[ "${1:-}" == "--reset" ]] && RESET="--reset"

log() { printf "[localnet] %s\n" "$*"; }

mkdir -p "$LOCALNET_DIR"

if lsof -nP -iTCP:"$RPC_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  log "already listening on :$RPC_PORT — nothing to do"
  exit 0
fi

[[ -f "$CORE_SO" ]] || { log "ERROR: $CORE_SO missing — run 'anchor build'"; exit 1; }

# The program id the .so was built for, so a rebuild that changed it is caught
# here rather than as a stream of AccountNotFound errors in the browser.
SOOTH_CORE_ID="$(node -e '
  const idl = require("'"$REPO_ROOT"'/target/idl/sooth_core.json");
  process.stdout.write(idl.address);
')"

if [[ -n "$RESET" ]]; then
  log "prepare: writing USDC mint dump"
  (cd "$DEMO_DIR" && node scripts/seed-localnet.mjs prepare >/dev/null)
fi
[[ -f "$USDC_DUMP" ]] || { log "ERROR: no USDC dump — boot once with --reset"; exit 1; }

log "booting validator on :$RPC_PORT  (program $SOOTH_CORE_ID)"
solana-test-validator \
  $RESET \
  --quiet \
  --rpc-port "$RPC_PORT" \
  --ledger "$LEDGER_DIR" \
  --limit-ledger-size 10000000 \
  --bpf-program "$SOOTH_CORE_ID" "$CORE_SO" \
  --account "$USDC_MINT_ADDR" "$USDC_DUMP" \
  --account "$AMM_MINT_ADDR" "$AMM_DUMP" \
  >"$LOG" 2>&1 &

echo $! > "$PID_FILE"
log "pid $(cat "$PID_FILE"), log $LOG"

for _ in $(seq 1 60); do
  if solana cluster-version --url "http://127.0.0.1:$RPC_PORT" >/dev/null 2>&1; then
    log "healthy"
    [[ -n "$RESET" ]] && log "ledger was reset — run: bash scripts/seed-fixture.sh <wallet>"
    exit 0
  fi
  sleep 1
done

log "ERROR: did not become healthy — see $LOG"
exit 1
