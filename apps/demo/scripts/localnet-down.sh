#!/usr/bin/env bash
# Stop the validator started by localnet-up.sh. Only ever kills the pid we
# wrote — never a broad pkill, which on a dev machine could take out something
# the operator started themselves.
set -euo pipefail
DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$DEMO_DIR/.localnet.pid"
[[ -f "$PID_FILE" ]] || { echo "[localnet] no pid file — nothing to stop"; exit 0; }
PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$PID" 2>/dev/null || true
  echo "[localnet] stopped $PID"
else
  echo "[localnet] pid $PID not running"
fi
rm -f "$PID_FILE"
