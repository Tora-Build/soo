#!/usr/bin/env bash
# Deploy (or upgrade) sooth_core on devnet.
#
# The 5→1 merge left a single program, so main's drip-funding loop across six
# programs is gone; what remains is the part that actually prevents mistakes.
#
# Preflight checks, in order:
#
#   1. The .so exists and is fresh relative to the sources.
#   2. The deploy keypair's pubkey EQUALS declare_id! in lib.rs.
#      This is the trap worth automating: `anchor build` silently generates a
#      NEW keypair when target/deploy/<name>-keypair.json is missing — which
#      happens in any git worktree, since each has its own target/. Deploying
#      with it puts the program at the wrong address, where Anchor's
#      `program_id == crate::ID` check then fails EVERY instruction. The
#      failure is total and looks nothing like a deploy problem.
#   3. The payer can cover rent + fees, with an exact funding figure if not.
#
# Rent is ~7.9 SOL at the current binary size (--max-len = exact .so size, no
# upgrade headroom) and is recoverable with `solana program close`. Devnet's
# faucet is rate-limited, so fund in whatever increments you can get; this
# script is idempotent and safe to rerun.
#
# To rehearse against a real Agave runtime without spending devnet SOL:
#
#   solana-test-validator --reset --bpf-program \
#     BgcooFgTuDQdoQkjLrZNRM6zM4Bu9bnAEenqdKjjR25W target/deploy/sooth_core.so
#
# That is how the 256 KB allocator was verified outside the test harness:
# with requestHeapFrame the program runs, without it every instruction faults
# with "Access violation in heap section" — same result Agave 3.1.8 and
# LiteSVM both give.
#
#   Usage:  bash packages/programs-core/scripts/deploy-devnet.sh
#   Env:    KEYPAIR=/path/to/payer.json   (default: ~/.config/solana/id.json)
#           RPC=https://...               (default: public devnet)
#           PROGRAM_KEYPAIR=/path/to/sooth_core-keypair.json
set -uo pipefail

RPC="${RPC:-https://api.devnet.solana.com}"
KEYPAIR="${KEYPAIR:-$HOME/.config/solana/id.json}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEPLOY="$REPO/target/deploy"
SO="$DEPLOY/sooth_core.so"
PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-$DEPLOY/sooth_core-keypair.json}"
LIB_RS="$REPO/packages/programs-core/programs/sooth-core/src/lib.rs"
FEE_BUFFER="0.05"

die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
bytes()    { wc -c < "$1" | tr -d ' '; }
rent_sol() { solana rent "$1" --url "$RPC" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1; }
bal_sol()  { solana balance -k "$KEYPAIR" --url "$RPC" 2>/dev/null | grep -oE '[0-9]+\.?[0-9]*' | head -1; }
on_chain() { solana program show "$1" --url "$RPC" >/dev/null 2>&1; }
ge() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 >= b+0)}'; }

printf '\n'
printf '═══════════════════════════════════════════════════════\n'
printf '  sooth_core → devnet\n'
printf '═══════════════════════════════════════════════════════\n'

# ── 1. Artifact ─────────────────────────────────────────────────────────────
[ -f "$SO" ] || die "missing $SO — run \`anchor build\` from $REPO first"
[ -f "$PROGRAM_KEYPAIR" ] || die "missing program keypair $PROGRAM_KEYPAIR"
LEN="$(bytes "$SO")"

NEWER="$(find "$REPO/packages/programs-core/programs" -name '*.rs' -newer "$SO" 2>/dev/null | head -1)"
if [ -n "$NEWER" ]; then
  printf '  ! %s is newer than the .so — rebuild before deploying\n' "${NEWER#"$REPO"/}"
  die "stale build artifact"
fi

# ── 2. Program id ───────────────────────────────────────────────────────────
DECLARED="$(grep -oE 'declare_id!\("[^"]+"\)' "$LIB_RS" | grep -oE '"[^"]+"' | tr -d '"')"
ACTUAL="$(solana address -k "$PROGRAM_KEYPAIR")"
if [ "$DECLARED" != "$ACTUAL" ]; then
  printf '  declare_id!   %s   (%s)\n' "$DECLARED" "${LIB_RS#"$REPO"/}"
  printf '  keypair       %s   (%s)\n' "$ACTUAL" "${PROGRAM_KEYPAIR#"$REPO"/}"
  printf '\n'
  printf '  A worktree gets its own target/, so `anchor build` generated a\n'
  printf '  fresh keypair rather than reusing the real one. Point at the\n'
  printf '  canonical keypair instead of deploying to the wrong address:\n'
  printf '\n'
  printf '    PROGRAM_KEYPAIR=<repo>/target/deploy/sooth_core-keypair.json \\\n'
  printf '      bash packages/programs-core/scripts/deploy-devnet.sh\n'
  die "program keypair does not match declare_id!"
fi

# ── 3. Funding ──────────────────────────────────────────────────────────────
PAYER="$(solana address -k "$KEYPAIR")"
BAL="$(bal_sol)"; BAL="${BAL:-0}"
RENT="$(rent_sol "$LEN")"
[ -n "$RENT" ] || die "could not compute rent for $LEN bytes (RPC unreachable?)"
NEED="$(awk -v r="$RENT" -v f="$FEE_BUFFER" 'BEGIN{printf "%.4f", r+f}')"

if on_chain "$DECLARED"; then MODE="upgrade"; else MODE="deploy"; fi

printf '  Program:  %s\n' "$DECLARED"
printf '  Binary:   %s bytes\n' "$LEN"
printf '  Payer:    %s\n' "$PAYER"
printf '  Balance:  %s SOL\n' "$BAL"
printf '  Rent:     %s SOL (+%s fees)\n' "$RENT" "$FEE_BUFFER"
printf '  RPC:      %s\n' "$RPC"
printf '  Mode:     %s\n' "$MODE"
printf '═══════════════════════════════════════════════════════\n\n'

if [ "$MODE" = "deploy" ] && ! ge "$BAL" "$NEED"; then
  SHORT="$(awk -v n="$NEED" -v b="$BAL" 'BEGIN{d=n-b; if(d<0)d=0; printf "%.2f", d}')"
  printf '  Insufficient funds: need ~%s SOL, have %s.\n\n' "$NEED" "$BAL"
  printf '  Fund %s with ~%s more SOL, then rerun.\n' "$PAYER" "$SHORT"
  printf '  Devnet faucet is rate-limited; drip in whatever you can get —\n'
  printf '  this script is idempotent.\n\n'
  printf '    solana airdrop 2 %s --url %s\n' "$PAYER" "$RPC"
  printf '    https://faucet.solana.com  (2.5 SOL/day, GitHub auth)\n\n'
  exit 1
fi

# ── 4. Deploy ───────────────────────────────────────────────────────────────
printf '[1/2] %s...\n' "$MODE"
if ! solana program deploy "$SO" \
      --program-id "$PROGRAM_KEYPAIR" \
      --keypair "$KEYPAIR" \
      --url "$RPC" \
      --max-len "$LEN"; then
  printf '\n  ✗ deploy failed. Rerun after funding — partially written buffers\n'
  printf '    are resumable, and `solana program close --buffers` reclaims\n'
  printf '    rent from abandoned ones.\n\n'
  exit 1
fi

# ── 5. Verify ───────────────────────────────────────────────────────────────
printf '\n[2/2] Verifying...\n'
on_chain "$DECLARED" || die "deploy reported success but $DECLARED is not visible"
INFO="$(solana program show "$DECLARED" --url "$RPC" 2>/dev/null)"
printf '%s\n' "$INFO" | sed 's/^/  /'

ON_LEN="$(printf '%s' "$INFO" | grep -oE 'Data Length: [0-9]+' | grep -oE '[0-9]+')"
if [ -n "$ON_LEN" ] && [ "$ON_LEN" != "$LEN" ]; then
  die "on-chain data length $ON_LEN != local .so $LEN — deploy is not the build you tested"
fi

printf '\n  ✓ live: %s\n' "$DECLARED"
printf '  https://explorer.solana.com/address/%s?cluster=devnet\n\n' "$DECLARED"
printf '  Reminder: every transaction must send requestHeapFrame(256 KB).\n'
printf '  sooth_core installs a 256 KB #[global_allocator], and without the\n'
printf '  frame EVERY instruction faults with "Access violation in heap\n'
printf '  section". @sooth/sdk-solana does this on all paths.\n\n'
printf '  Next: seed a market, then point the demo at chain 901.\n\n'
