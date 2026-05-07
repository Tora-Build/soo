#!/usr/bin/env bash
# Thin wrapper around the surfnet_* JSON-RPC cheatcodes. Intended to be
# run alongside `bash scripts/dev-surfpool.sh` — the dapp / fixture / e2e
# specs see the cheats as live state mutations on the same RPC.
#
# Most useful subcommand for this repo: `time-travel`. The 24h sell-lock
# in sooth_amm gates `claim_unlocked` and the operator
# request_lock → attest_outcome bridge on real wall-clock; on
# solana-test-validator there is no setClock so localnet UI smoke can't
# bridge those flows. Surfpool's `surfnet_timeTravel` does — call it once
# after kicking off a sell to fast-forward past the lock window.
#
# Usage:
#   bash scripts/surfnet-cheats.sh <subcommand> [flags]
#
# Subcommands:
#   time-travel --seconds <N>     Fast-forward the surfnet clock by N seconds
#                                 (UNIX timestamp delta). Default for the
#                                 24h sell-lock: --seconds 86400.
#   time-travel --slot <N>        Jump to absolute slot N.
#   pause                         Freeze slot advancement.
#   resume                        Resume slot advancement.
#   reset                         Reset every account to its initial state
#                                 (drops markets, USDC, positions).
#   set-account <pubkey> <file>   Apply a JSON dump (solana-test-validator
#                                 `--account` shape) at the given pubkey.
#   info                          Print surfnet info (runbook status, etc.)
#   logs [n]                      Print the last N transaction signatures
#                                 with logs (default n=20).
#
# Env:
#   RPC_URL  Default http://127.0.0.1:8899

set -euo pipefail

RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"

rpc() {
  curl -sS -X POST -H "Content-Type: application/json" \
    --data "$1" "$RPC_URL"
}

cmd="${1:-}"
case "$cmd" in
  time-travel)
    shift
    mode=""
    val=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --seconds) mode="absoluteTimestamp"; val="$2"; shift 2;;
        --slot) mode="absoluteSlot"; val="$2"; shift 2;;
        --epoch) mode="absoluteEpoch"; val="$2"; shift 2;;
        *) echo "unknown flag: $1" >&2; exit 2;;
      esac
    done
    if [[ -z "$mode" ]]; then
      echo "time-travel requires one of --seconds, --slot, --epoch" >&2
      exit 2
    fi
    if [[ "$mode" == "absoluteTimestamp" ]]; then
      now="$(date +%s)"
      target="$((now + val))"
      printf '[surfnet-cheats] timeTravel +%ss (target unix=%s)\n' "$val" "$target" >&2
      rpc "$(printf '{"jsonrpc":"2.0","id":1,"method":"surfnet_timeTravel","params":[{"absoluteTimestamp":%s}]}' "$target")"
    else
      printf '[surfnet-cheats] timeTravel %s=%s\n' "$mode" "$val" >&2
      rpc "$(printf '{"jsonrpc":"2.0","id":1,"method":"surfnet_timeTravel","params":[{"%s":%s}]}' "$mode" "$val")"
    fi
    echo
    ;;

  pause)
    rpc '{"jsonrpc":"2.0","id":1,"method":"surfnet_pauseClock","params":[]}'
    echo
    ;;

  resume)
    rpc '{"jsonrpc":"2.0","id":1,"method":"surfnet_resumeClock","params":[]}'
    echo
    ;;

  reset)
    rpc '{"jsonrpc":"2.0","id":1,"method":"surfnet_resetNetwork","params":[]}'
    echo
    ;;

  set-account)
    pubkey="${2:-}"
    file="${3:-}"
    if [[ -z "$pubkey" || -z "$file" ]]; then
      echo "set-account requires <pubkey> <json-file>" >&2
      exit 2
    fi
    payload="$(node -e '
const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const acc = j.account ?? j;
process.stdout.write(JSON.stringify({
  lamports: acc.lamports,
  data: acc.data,
  owner: acc.owner,
  executable: acc.executable ?? false,
  rentEpoch: acc.rentEpoch ?? 0,
}));
' "$file")"
    rpc "$(printf '{"jsonrpc":"2.0","id":1,"method":"surfnet_setAccount","params":["%s",%s]}' \
      "$pubkey" "$payload")"
    echo
    ;;

  info)
    rpc '{"jsonrpc":"2.0","id":1,"method":"surfnet_getSurfnetInfo","params":[]}'
    echo
    ;;

  logs)
    n="${2:-20}"
    rpc "$(printf '{"jsonrpc":"2.0","id":1,"method":"surfnet_getLocalSignatures","params":[{"limit":%s}]}' "$n")"
    echo
    ;;

  ""|help|-h|--help)
    sed -n '2,/^set -euo pipefail$/p' "$0" | sed 's/^# \?//'
    ;;

  *)
    echo "unknown subcommand: $cmd" >&2
    echo "run \`$0 help\` for usage" >&2
    exit 2
    ;;
esac
