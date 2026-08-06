#!/usr/bin/env bash
# Build the full localnet fixture on an already-running validator.
#
# `dev-localnet.sh` seeds ONE market. A useful test session needs three things
# that one market cannot be at once:
#
#   1. a BONDING market with a realistic b, so AMM price impact looks like
#      production (b = 1000 → 0.02 pts per share);
#   2. a GRADUATED market, so the orderbook is reachable at all — which needs a
#      small enough b to actually reach the fee threshold (b = 50 → ~3,500 USDC
#      of volume, driven here rather than clicked);
#   3. a two-sided ladder resting on that book, so there is something to cross.
#
# Doing this by hand after every validator restart is how markets end up
# orphaned out of .env.local. This script is the repeatable version.
#
# Usage: bash scripts/seed-fixture.sh [wallet-to-fund]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DEMO_DIR"

FUND_WALLET="${1:-}"

log() { printf "\n[fixture] %s\n" "$*"; }

log "1/4  bonding market (b=1000) — realistic AMM price impact"
BONDING=$(SEED_B_WAD=1000 node scripts/seed-localnet.mjs init \
  | tee /dev/stderr | grep "market PDA:" | awk '{print $NF}')

log "2/4  graduated market (b=50) — reachable graduation, usable impact"
GRADUATED=$(SEED_B_WAD=50 node scripts/seed-localnet.mjs init \
  | tee /dev/stderr | grep "market PDA:" | awk '{print $NF}')

log "3/4  driving $GRADUATED to graduation"
node scripts/graduate-market.mjs "$GRADUATED"

# The book must EXIST even when empty — `book_place` needs the account — but
# resting a maker ladder in it is optional. SEED_LADDER=0 gives a completely
# clean book to trade into from scratch.
if [[ "${SEED_LADDER:-1}" == "0" ]]; then
  log "4/4  initialising an EMPTY book (SEED_LADDER=0)"
  node scripts/seed-book.mjs "$GRADUATED" --empty
else
  log "4/4  resting a two-sided ladder on the graduated book"
  node scripts/seed-book.mjs "$GRADUATED"
fi

# The last seed run left ITS market as the default; the graduated one is the
# interesting one to land on, so make that the default and carry the other.
# `node -e` does NOT put a script path in argv, so the first real argument is
# argv[1], not argv[2]. Destructuring one slot too far read the market address
# as the filename and died on ENOENT — after graduation and the ladder had
# already succeeded, so the whole fixture looked broken when only the last
# step was.
node -e '
const fs = require("node:fs");
const [, path, main, extra] = process.argv;
let s = fs.readFileSync(path, "utf8");
s = s.replace(/^VITE_DEMO_MARKET_REF=.*$/m, `VITE_DEMO_MARKET_REF=sol:${main}`);
s = s.replace(
  /^VITE_DEMO_EXTRA_MARKET_REFS=.*$/m,
  `VITE_DEMO_EXTRA_MARKET_REFS=sol:${extra}`,
);
fs.writeFileSync(path, s);
' .env.local "$GRADUATED" "$BONDING"

if [[ -n "$FUND_WALLET" ]]; then
  log "funding $FUND_WALLET"
  node scripts/fund-wallet.mjs "$FUND_WALLET"
fi

log "done"
echo "  graduated (orderbook): $GRADUATED"
echo "  bonding   (AMM):       $BONDING"
echo
echo "Restart vite so it picks up the rewritten .env.local."
