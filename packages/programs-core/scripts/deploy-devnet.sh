#!/usr/bin/env bash
# Deploy (or upgrade) the Sooth programs on devnet.
#
# Two programs, and both are required: `sooth_core::buy` invokes `sooth_log`
# for the durable OrdersFilled record, so a crossing buy fails outright if the
# sink is not deployed. sooth_log is deployed FIRST for that reason (and it is
# the cheaper of the two, so a short drip still lands something useful).
#
# Preflight checks, per program:
#
#   1. The .so exists and is not stale relative to the Rust sources.
#   2. The deploy keypair's pubkey EQUALS declare_id! in that crate's lib.rs.
#      This is the trap worth automating: `anchor build` silently GENERATES a
#      new keypair when target/deploy/<name>-keypair.json is missing — the
#      default state of any git worktree, since each has its own target/.
#      Deploying with it puts the program at the wrong address, where Anchor's
#      `program_id == crate::ID` check then fails EVERY instruction. The
#      failure is total and looks nothing like a deploy problem.
#   3. The payer covers rent + fees, with an exact shortfall figure if not.
#
# Rent is ~9.2 SOL for both at current sizes (--max-len = exact .so size, no
# upgrade headroom) and is recoverable with `solana program close`. Devnet's
# faucet is rate-limited, so fund in whatever increments you can get; this
# script is idempotent and safe to rerun.
#
# To rehearse against a real Agave runtime without spending devnet SOL:
#
#   solana-test-validator --reset \
#     --bpf-program BgcooFgTuDQdoQkjLrZNRM6zM4Bu9bnAEenqdKjjR25W target/deploy/sooth_core.so \
#     --bpf-program 6TVeQ2JzYUXNsUG7kJpGvQ2Y6kKCxNkkAWSFrEG4vb59 target/deploy/sooth_log.so
#
# That is how the 256 KB allocator was verified outside the test harness: with
# requestHeapFrame the program runs, without it every instruction faults with
# "Access violation in heap section" — the same result Agave 3.1.8 and LiteSVM
# both give.
#
#   Usage:  bash packages/programs-core/scripts/deploy-devnet.sh
#   Env:    KEYPAIR=/path/to/payer.json   (default: ~/.config/solana/id.json)
#           RPC=https://...               (default: public devnet)
#           DEPLOY_DIR=/path/target/deploy (default: <repo>/target/deploy —
#                                           point this at the canonical repo
#                                           when running from a worktree)
set -uo pipefail

RPC="${RPC:-https://api.devnet.solana.com}"
KEYPAIR="${KEYPAIR:-$HOME/.config/solana/id.json}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$REPO/target/deploy}"
PROGRAMS_DIR="$REPO/packages/programs-core/programs"
FEE_BUFFER="0.05"

# Ascending by size. sooth_log is also a hard prerequisite for sooth_core's
# buy path, so this order is load-bearing, not just drip-friendly.
declare -a PROGRAMS=(sooth_log sooth_core)
# .so name -> crate directory (hyphenated, unlike the crate name).
crate_dir() { printf '%s' "${1//_/-}"; }

die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
bytes()    { wc -c < "$1" | tr -d ' '; }
rent_sol() { solana rent "$1" --url "$RPC" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1; }
bal_sol()  { solana balance -k "$KEYPAIR" --url "$RPC" 2>/dev/null | grep -oE '[0-9]+\.?[0-9]*' | head -1; }
on_chain() { solana program show "$1" --url "$RPC" >/dev/null 2>&1; }
ge() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 >= b+0)}'; }

PAYER="$(solana address -k "$KEYPAIR" 2>/dev/null)" || die "cannot read payer keypair $KEYPAIR"
BAL="$(bal_sol)"; BAL="${BAL:-0}"

printf '\n'
printf '═══════════════════════════════════════════════════════\n'
printf '  Sooth → devnet\n'
printf '═══════════════════════════════════════════════════════\n'
printf '  Payer:    %s\n' "$PAYER"
printf '  Balance:  %s SOL\n' "$BAL"
printf '  RPC:      %s\n' "$RPC"
printf '  Deploy:   %s\n' "${DEPLOY_DIR/#$REPO\//}"
printf '───────────────────────────────────────────────────────\n'

# ── Preflight every program before spending anything ────────────────────────
TOTAL_NEED=0
declare -a LIVE=() TODO=()
for p in "${PROGRAMS[@]}"; do
  SO="$DEPLOY_DIR/$p.so"
  KP="$DEPLOY_DIR/${p}-keypair.json"
  LIB="$PROGRAMS_DIR/$(crate_dir "$p")/src/lib.rs"

  [ -f "$SO" ] || die "missing $SO — run \`anchor build\` from $REPO"
  [ -f "$LIB" ] || die "missing $LIB"
  DECLARED="$(grep -oE 'declare_id!\("[^"]+"\)' "$LIB" | grep -oE '"[^"]+"' | tr -d '"')"
  LEN="$(bytes "$SO")"

  # Already live? Then we neither need nor necessarily CAN touch it: the
  # upgrade authority may belong to someone else, and a different build of the
  # same source is perfectly usable. sooth_log in particular is a no-op sink
  # whose only contract is accepting `log(Vec<u8>)` — any build satisfying
  # that works, so comparing binary sizes against a foreign deployment would
  # be a false alarm. Skip the local checks entirely.
  if on_chain "$DECLARED"; then
    AUTH="$(solana program show "$DECLARED" --url "$RPC" 2>/dev/null | grep -oE 'Authority: \S+' | awk '{print $2}')"
    ON_LEN="$(solana program show "$DECLARED" --url "$RPC" 2>/dev/null | grep -oE 'Data Length: [0-9]+' | grep -oE '[0-9]+')"
    if [ "$AUTH" = "$PAYER" ]; then
      printf '  %-11s %9s B  %8s     ✓ live, we hold upgrade authority\n' "$p" "${ON_LEN:-?}" "-"
    else
      printf '  %-11s %9s B  %8s     ✓ live, authority %s\n' "$p" "${ON_LEN:-?}" "-" "${AUTH:0:8}…"
    fi
    LIVE+=("$p")
    continue
  fi

  # Needs deploying — now the local artifact has to be right.
  [ -f "$KP" ] || die "missing program keypair $KP (needed to deploy $p at $DECLARED)"

  NEWER="$(find "$PROGRAMS_DIR" -name '*.rs' -newer "$SO" 2>/dev/null | head -1)"
  [ -z "$NEWER" ] || die "$p: ${NEWER#"$REPO"/} is newer than the .so — rebuild first"

  ACTUAL="$(solana address -k "$KP")"
  if [ "$DECLARED" != "$ACTUAL" ]; then
    printf '\n  %s program-id mismatch:\n' "$p"
    printf '    declare_id!  %s   (%s)\n' "$DECLARED" "${LIB#"$REPO"/}"
    printf '    keypair      %s   (%s)\n' "$ACTUAL" "${KP#"$REPO"/}"
    printf '\n'
    printf '  A worktree has its own target/, so `anchor build` generated a\n'
    printf '  fresh keypair instead of reusing the real one. Point at the\n'
    printf '  canonical deploy directory rather than deploying to the wrong\n'
    printf '  address:\n\n'
    printf '    DEPLOY_DIR=<canonical-repo>/target/deploy \\\n'
    printf '      bash packages/programs-core/scripts/deploy-devnet.sh\n'
    die "$p keypair does not match declare_id!"
  fi

  RENT="$(rent_sol "$LEN")"
  [ -n "$RENT" ] || die "could not compute rent for $p ($LEN bytes) — RPC unreachable?"
  printf '  %-11s %9s B  %8s SOL  → deploy\n' "$p" "$LEN" "$RENT"
  TODO+=("$p")
  TOTAL_NEED="$(awk -v t="$TOTAL_NEED" -v r="$RENT" -v f="$FEE_BUFFER" 'BEGIN{printf "%.4f", t+r+f}')"
done
printf '───────────────────────────────────────────────────────\n'
printf '  Needed:   %s SOL (undeployed only)\n' "$TOTAL_NEED"
printf '═══════════════════════════════════════════════════════\n\n'

if ! ge "$BAL" "$TOTAL_NEED"; then
  SHORT="$(awk -v n="$TOTAL_NEED" -v b="$BAL" 'BEGIN{d=n-b; if(d<0)d=0; printf "%.2f", d}')"
  printf '  Insufficient funds: need ~%s SOL, have %s.\n\n' "$TOTAL_NEED" "$BAL"
  printf '  Fund %s with ~%s more SOL, then rerun. Programs already\n' "$PAYER" "$SHORT"
  printf '  on-chain are skipped, so a partial drip still makes progress.\n\n'
  printf '    solana airdrop 2 %s --url %s\n' "$PAYER" "$RPC"
  printf '    https://faucet.solana.com  (2.5 SOL/day, GitHub auth)\n\n'
  exit 1
fi

# ── Deploy ──────────────────────────────────────────────────────────────────
printf '[1/2] Deploying (smallest first)...\n'
if [ "${#TODO[@]}" -eq 0 ]; then printf '  nothing to do — all programs live\n'; fi
for p in "${TODO[@]:-}"; do
  [ -n "$p" ] || continue
  SO="$DEPLOY_DIR/$p.so"
  KP="$DEPLOY_DIR/${p}-keypair.json"
  PID="$(solana address -k "$KP")"
  LEN="$(bytes "$SO")"

  RENT="$(rent_sol "$LEN")"
  COST="$(awk -v r="${RENT:-0}" -v f="$FEE_BUFFER" 'BEGIN{printf "%.4f", r+f}')"
  CUR="$(bal_sol)"; CUR="${CUR:-0}"
  if ! ge "$CUR" "$COST"; then
    printf '  ⏸ %s needs ~%s SOL, have %s — stopping here. Rerun after funding.\n' "$p" "$COST" "$CUR"
    break
  fi

  printf '  → %s (%s B, ~%s SOL)\n' "$p" "$LEN" "$COST"
  if ! solana program deploy "$SO" --program-id "$KP" --keypair "$KEYPAIR" \
        --url "$RPC" --max-len "$LEN"; then
    printf '\n  ✗ %s deploy failed. Rerun after funding — partially written\n' "$p"
    printf '    buffers are resumable, and `solana program close --buffers`\n'
    printf '    reclaims rent from abandoned ones.\n\n'
    exit 1
  fi
  on_chain "$PID" && printf '    ✓ live: %s\n' "$PID" \
                  || printf '    ? deploy returned ok but not visible yet\n'
done

# ── Verify from on-chain truth, not loop state ──────────────────────────────
printf '\n[2/2] Verifying...\n'
FAILED=0
for p in "${PROGRAMS[@]}"; do
  SO="$DEPLOY_DIR/$p.so"
  LEN="$(bytes "$SO")"
  # Resolve from declare_id!, not the keypair file: the declared id is where
  # the program MUST live, and a program we did not deploy (sooth_log) has no
  # keypair here at all.
  PID="$(grep -oE 'declare_id!\("[^"]+"\)' "$PROGRAMS_DIR/$(crate_dir "$p")/src/lib.rs" | grep -oE '"[^"]+"' | tr -d '"')"
  if ! on_chain "$PID"; then
    printf '  ✗ %-11s NOT deployed (%s)\n' "$p" "$PID"
    FAILED=1; continue
  fi
  INFO="$(solana program show "$PID" --url "$RPC" 2>/dev/null)"
  ON_LEN="$(printf '%s' "$INFO" | grep -oE 'Data Length: [0-9]+' | grep -oE '[0-9]+')"
  # Only assert byte-equality for programs THIS run deployed. A pre-existing
  # deployment may be a different build of the same source and still correct.
  if [[ " ${TODO[*]:-} " == *" $p "* ]] && [ -n "$ON_LEN" ] && [ "$ON_LEN" != "$LEN" ]; then
    printf '  ✗ %-11s on-chain %s B != local %s B — not the build you tested\n' "$p" "$ON_LEN" "$LEN"
    FAILED=1; continue
  fi
  printf '  ✓ %-11s %s (%s B)\n' "$p" "$PID" "${ON_LEN:-$LEN}"
done

BAL_END="$(bal_sol)"
printf '\n  Balance: %s → %s SOL\n' "$BAL" "${BAL_END:-?}"

if [ "$FAILED" -ne 0 ]; then
  printf '\n  ✗ one or more programs are not correctly deployed — see above.\n'
  printf '    The demo and SDK need BOTH: sooth_core::buy invokes sooth_log.\n\n'
  exit 1
fi

CORE_ID="$(grep -oE 'declare_id!\("[^"]+"\)' "$PROGRAMS_DIR/sooth-core/src/lib.rs" | grep -oE '"[^"]+"' | tr -d '"')"
printf '\n  https://explorer.solana.com/address/%s?cluster=devnet\n\n' "$CORE_ID"
printf '  Reminder: every transaction must send requestHeapFrame(256 KB).\n'
printf '  sooth_core installs a 256 KB #[global_allocator]; without the frame\n'
printf '  EVERY instruction faults with "Access violation in heap section".\n'
printf '  @sooth/sdk-solana does this on all paths.\n\n'
printf '  Devnet mock USDC (D19): ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX\n'
printf '  Mint authority:         apps/demo/.localnet/mint-authority.json\n'
printf '                          (EXJ7ZiAXvSpNGzhHEFBewUaJ4fdZtAfuFBRhYsQPV5Y9)\n'
printf '  BACK THAT FILE UP — it is untracked, and losing it means this\n'
printf '  constant has to change and the program be redeployed again.\n\n'
printf '  Note an UPGRADE needs ~8 SOL free for the buffer account (refunded\n'
printf '  on completion), not just the rent delta.\n\n'
printf '  Next: seed a market, then point the demo at chain 901.\n\n'
