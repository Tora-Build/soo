// Audit every market on a cluster for exposure to the `wad_mul` wrap.
//
// ## The bug
//
// `wad_mul` computed the carry into its high limb wrongly, so any product
// exceeding `u128::MAX` silently lost 2^128 instead of returning
// `Err(Overflow)`. `lmsr_cost` ends in `wad_mul(b, m + ln_sum)`, and that
// product is `cost * 1e36`, so the wrap fires precisely when
//
//     lmsr_cost(q_yes, q_no, b) > u128::MAX / 1e36 = 340.282366920938463463
//
// Since `cost ≈ max(q_yes, q_no) + b·ln(2)`, a market is over the line as soon
// as `b > 491` even with nothing traded — b = 1000 starts at 693.1.
//
// ## What that means for a given market
//
// `cost_delta` differences two costs. While both endpoints sit in the SAME
// wrap band the constant error cancels exactly and every trade is priced
// correctly. Damage happens only when a trade STRADDLES a band boundary: the
// two endpoints wrapped a different number of times, so the difference is off
// by ±340.282 — which for a buy shows up as the program paying the trader.
//
// So "b is large" is not the same as "this market lost money". This script
// reports both: which band a market sits in, and whether its vault still backs
// the shares outstanding.
//
// ## The collateral check
//
// Every YES share and every NO share redeems for 1 USDC, but only one side
// wins, so the vault must hold at least `max(q_yes, q_no)`. A vault below that
// cannot pay out — that is the observable damage from a mispriced fill.
//
// Usage:
//   node scripts/audit-lmsr-wrap.mjs [--rpc <url>] [--program <pubkey>]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { deriveMarketVaultAta } from "@sooth/sdk-solana";

import { connect } from "./lib/rpc.mjs";

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DEMO_ROOT, "../..");

// u128::MAX / 1e36 — the exact cost above which `wad_mul` used to wrap.
const WRAP_THRESHOLD = 340.282366920938463463;
const WAD = 1e18;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const RPC = arg("rpc", "http://127.0.0.1:8899");
const idl = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "target/idl/sooth_core.json"), "utf8"),
);
const PROGRAM = new PublicKey(arg("program", idl.address));

const usdcMint = new PublicKey(
  arg("usdc", "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"),
);
const connection = connect(RPC);
const coder = new anchor.BorshAccountsCoder(idl);
const log = (...a) => console.log(...a);

/** Closed-form LMSR cost, in whole units. Mirrors `lmsr_cost` in the program. */
function lmsrCost(qYes, qNo, b) {
  const m = Math.max(qYes / b, qNo / b);
  const sum = Math.exp(qYes / b - m) + Math.exp(qNo / b - m);
  return b * (m + Math.log(sum));
}

/** Which 340.282-wide band a cost falls in. Same band => the error cancels. */
const band = (cost) => Math.floor(cost / WRAP_THRESHOLD);

log(`rpc:     ${RPC}`);
log(`program: ${PROGRAM.toBase58()}`);

const accounts = await connection.getProgramAccounts(PROGRAM, {
  filters: [
    {
      memcmp: {
        offset: 0,
        bytes: anchor.utils.bytes.bs58.encode(coder.accountDiscriminator("Market")),
      },
    },
  ],
});

if (accounts.length === 0) {
  log("\nno markets found — nothing to audit");
  process.exit(0);
}

log(`markets: ${accounts.length}\n`);

let exposed = 0;
let undercollateralised = 0;

for (const { pubkey, account } of accounts) {
  // Read `market_id` at its raw offset rather than decoding the whole account.
  //
  // Markets created by an older build have a shorter `Market` layout, and
  // Borsh throws on those — which would make this auditor blind to exactly the
  // markets most likely to predate the fix. `market_id` is the first field, so
  // its offset is stable across every layout revision.
  const marketId = account.data.subarray(8, 8 + 16);
  let market = null;
  try {
    market = coder.decode("Market", account.data);
  } catch {
    // Layout drift — fall back to deriving what we need from `market_id`.
  }

  const [ammPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm"), marketId],
    PROGRAM,
  );
  const ammInfo = await connection.getAccountInfo(ammPda);
  if (!ammInfo) {
    log(`${pubkey.toBase58()}  (no AMM state — skipped)`);
    continue;
  }
  // Same layout-tolerance as above. `AmmState` begins
  // `market: Pubkey, q_yes: i128, q_no: i128, b: i128`, and those four have
  // been stable across every revision, so read them at fixed offsets instead
  // of requiring the whole account to decode.
  const readI128 = (buf, off) => {
    const lo = buf.readBigUInt64LE(off);
    const hi = buf.readBigInt64LE(off + 8);
    return (hi << 64n) | lo;
  };
  let amm;
  try {
    amm = coder.decode("AmmState", ammInfo.data);
  } catch {
    amm = {
      qYes: readI128(ammInfo.data, 8 + 32),
      qNo: readI128(ammInfo.data, 8 + 32 + 16),
      b: readI128(ammInfo.data, 8 + 32 + 32),
      isGraduated: null, // beyond the stable prefix
    };
  }
  const b = Number(amm.b) / WAD;
  const qYes = Number(amm.qYes ?? amm.q_yes) / WAD;
  const qNo = Number(amm.qNo ?? amm.q_no) / WAD;

  const cost = lmsrCost(qYes, qNo, b);
  const costAtSeed = lmsrCost(0, 0, b); // b·ln(2)
  const overThreshold = cost > WRAP_THRESHOLD;

  // How far the current state sits from the nearest band edge, in shares. A
  // market deep inside a band needs a large trade to straddle one; a market
  // sitting near an edge could be pushed over by a single share.
  const nextEdge = (band(cost) + 1) * WRAP_THRESHOLD;
  const sharesToEdge = nextEdge - cost; // ≈ shares, since dCost/dq ≤ 1

  // Collateral: the vault must cover whichever side wins.
  // Prefer the recorded vault; derive it when the layout would not decode.
  const vaultPk = market
    ? new PublicKey(market.vault)
    : deriveMarketVaultAta(marketId, usdcMint, { soothCore: PROGRAM });
  const vaultInfo = await connection
    .getTokenAccountBalance(vaultPk)
    .catch(() => null);
  const vault = vaultInfo ? Number(vaultInfo.value.amount) / 1e6 : null;
  const required = Math.max(qYes, qNo);
  const short = vault !== null && vault < required;

  // Attribute the shortfall, because two unrelated bugs produce one.
  //
  // Under correct operation the vault holds the full LMSR cost: traders paid
  // `cost(q) - b·ln(2)` and the creator posted `b·ln(2)` as the subsidy at
  // seed. So `vault ≈ cost`.
  //
  //   - short by ≈ b·ln(2)  →  the subsidy was never transferred (B0:
  //     `seed_lp` took the deposit argument but never moved the tokens). The
  //     vault is structurally short from creation, independent of any trade.
  //   - short by something else, on a market in band > 0  →  a trade
  //     straddled a wrap boundary and was mispriced by ±340.282.
  //
  // Conflating them would send a pre-B0 market to the wrong remedy.
  const deficit = short ? required - vault : 0;
  const looksLikeMissingSubsidy =
    short && Math.abs(cost - vault - costAtSeed) < Math.max(0.01, cost * 0.01);

  if (overThreshold) exposed += 1;
  if (short) undercollateralised += 1;

  log(`${pubkey.toBase58()}${market ? "" : "   (older Market layout)"}`);
  log(`  b=${b}  q=(${qYes.toFixed(2)}, ${qNo.toFixed(2)})  graduated=${amm.isGraduated ?? amm.is_graduated ?? "?"}`);
  log(
    `  lmsr cost   ${cost.toFixed(4)}   (at seed ${costAtSeed.toFixed(4)})` +
      `  threshold ${WRAP_THRESHOLD.toFixed(4)}`,
  );
  log(
    overThreshold
      ? `  WRAP BAND   ${band(cost)}  — was in the wrapped regime under the old program`
      : `  WRAP BAND   0  — always below the threshold, never affected`,
  );
  if (overThreshold) {
    log(`  next edge   ${sharesToEdge.toFixed(2)} shares away`);
  }
  log(
    vault === null
      ? `  vault       (unreadable)`
      : `  vault       ${vault.toFixed(6)} USDC   needs >= ${required.toFixed(6)}` +
        (short ? `   *** SHORT by ${deficit.toFixed(6)} ***` : `   ok`),
  );
  if (short) {
    log(
      looksLikeMissingSubsidy
        ? `  cause       unposted LMSR subsidy (B0), not the wrap —` +
          ` vault holds the trader inflow but not b·ln(2)=${costAtSeed.toFixed(4)}`
        : overThreshold
          ? `  cause       consistent with a wrap-straddling trade (band ${band(cost)})`
          : `  cause       unexplained — below the wrap threshold and subsidy looks posted`,
    );
  }
  log("");
}

log("─".repeat(60));
log(`markets audited:            ${accounts.length}`);
log(`in a wrapped band (b>~491): ${exposed}`);
log(`under-collateralised:       ${undercollateralised}`);
if (undercollateralised > 0) {
  log("");
  log("An under-collateralised vault cannot pay out every winning share.");
  log("Fixing the program does not refill it — those markets need re-seeding.");
}
