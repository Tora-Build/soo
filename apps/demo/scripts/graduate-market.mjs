// Drive a bonding market to graduation on localnet.
//
// ## Why this exists
//
// Graduation fires when accumulated fees reach the LMSR's maximum subsidy,
// `b * ln(2)`. At a 1% fee that means roughly `69 * b` USDC of volume — so the
// liquidity parameter sets BOTH how realistic the AMM feels and how much
// trading it takes to unlock the orderbook, and those pull in opposite
// directions:
//
//   b = 1000  price impact 0.02 pts/share (realistic)   ~69,000 USDC to graduate
//   b = 50    price impact 0.50 pts/share (usable)      ~3,500 USDC to graduate
//   b = 1     price impact 10.7 pts/share (absurd)      ~70 USDC to graduate
//
// The first graduated localnet fixture used b = 1, which is why buying a single
// share moved the price by ten points. That was the fixture, not the pricing —
// the program's LMSR matches the closed form to 1e-14 at every b.
//
// b = 50 is the compromise, and reaching graduation there needs ~3,500 USDC of
// volume, which is what this script supplies.
//
// ## Why it alternates YES and NO
//
// Fees accrue on volume, but price moves on IMBALANCE. Buying only YES pins the
// market at 1.0 long before the fee target is hit, leaving a graduated market
// nobody can trade against. Alternating keeps `q_yes ≈ q_no`, so the price stays
// near 0.50 while the fee pool fills — the market graduates balanced.
//
// Usage: node scripts/graduate-market.mjs <marketPubkey>

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { SolanaChainAdapter } from "@sooth/sdk-solana";

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALNET_DIR = resolve(DEMO_ROOT, ".localnet");
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const WAD = 10n ** 18n;

function loadKeypair(path) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

function log(...args) {
  console.log("[graduate]", ...args);
}

const marketArg = process.argv[2];
if (!marketArg) {
  console.error("usage: node scripts/graduate-market.mjs <marketPubkey>");
  process.exit(1);
}
const marketRef = marketArg.startsWith("sol:") ? marketArg : `sol:${marketArg}`;

const connection = new Connection(RPC, "confirmed");
// The creator holds the minted USDC float; the user wallet is deliberately
// left alone so the operator's own balance is not consumed by the fixture.
const trader = loadKeypair(resolve(LOCALNET_DIR, "creator-keypair.json"));

const env = readFileSync(resolve(DEMO_ROOT, ".env.local"), "utf8");
function envVar(key, fallback) {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : fallback;
}

const adapter = new SolanaChainAdapter({
  node: {
    id: "solana-localnet",
    chainKind: "solana",
    chainId: "solana:localnet",
    cluster: "localnet",
    rpcUrl: RPC,
    programs: {
      soothCore: envVar("VITE_SOOTH_CORE_ID"),
      usdcMint: envVar("VITE_USDC_MINT"),
    },
  },
  connection,
});

const traderRef = `sol:${trader.publicKey.toBase58()}`;

// `submit` takes a SignerRef, not a Keypair — the adapter is written against
// the wallet-adapter shape the browser supplies. A local keypair signs the
// same way, so this is the whole bridge.
const signer = {
  publicKey: trader.publicKey.toBase58(),
  // The adapter hands over SERIALIZED bytes and expects signed bytes back —
  // it never sees a Transaction object, because a browser wallet does not
  // hand one over either.
  async signTransaction(bytes) {
    const tx = Transaction.from(bytes);
    tx.partialSign(trader);
    return tx.serialize();
  },
};

async function state() {
  const snap = await adapter.readSnapshot(marketRef);
  return snap.market;
}

const before = await state();
log(
  `market ${marketArg.slice(0, 10)}  b=${Number(before.b) / 1e18}` +
    `  q=(${Number(before.qYes) / 1e18}, ${Number(before.qNo) / 1e18})`,
);
if (before.isGraduated) {
  log("already graduated — nothing to do");
  process.exit(0);
}

// One "round" buys the same size on both sides, so imbalance stays near zero
// and only the fee pool grows.
const SHARES_PER_LEG = BigInt(process.env.GRAD_STEP_SHARES ?? "50") * WAD;
const MAX_ROUNDS = Number(process.env.GRAD_MAX_ROUNDS ?? "200");

let rounds = 0;
let graduated = false;

for (; rounds < MAX_ROUNDS; rounds += 1) {
  for (const outcome of [1, 0]) {
    // maxCost is a slippage bound, not a budget — a share can never cost more
    // than 1 USDC under LMSR, so leg size + headroom is always sufficient.
    const maxCostWad = SHARES_PER_LEG * 2n;
    const req = await adapter.buildTrade(marketRef, {
      outcome,
      deltaShares: SHARES_PER_LEG,
      maxCostWad,
      user: traderRef,
    });
    try {
      await adapter.submit(req, signer);
    } catch (err) {
      log(`round ${rounds} outcome ${outcome} failed: ${String(err)}`);
      // `submit` surfaces the error code but not the program trace, so
      // replay the same instruction through simulate to recover the log.
      const { Transaction: T, TransactionInstruction: TI, PublicKey: PK } =
        await import("@solana/web3.js");
      const toIx = (m) =>
        new TI({
          programId: new PK(m.ixProgramId ?? m.programId),
          keys: (m.ixKeys ?? m.keys).map((k) => ({
            pubkey: new PK(k.pubkey),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Buffer.from(m.ixData ?? m.data, "base64"),
        });
      const tx = new T();
      for (const pre of req.meta.preIxs ?? []) tx.add(toIx(pre));
      tx.add(toIx(req.meta));
      tx.feePayer = trader.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sim = await connection.simulateTransaction(tx);
      console.log((sim.value.logs ?? []).join("\n"));
      throw err;
    }
  }

  const now = await state();
  if (now.isGraduated) {
    graduated = true;
    break;
  }
  if (rounds % 10 === 0) {
    const b = Number(now.b) / 1e18;
    const qy = Number(now.qYes) / 1e18;
    const qn = Number(now.qNo) / 1e18;
    const p = Math.exp(qy / b) / (Math.exp(qy / b) + Math.exp(qn / b));
    log(
      `round ${rounds}  q=(${qy.toFixed(1)}, ${qn.toFixed(1)})  p=${p.toFixed(4)}`,
    );
  }
}

const after = await state();
const b = Number(after.b) / 1e18;
const qy = Number(after.qYes) / 1e18;
const qn = Number(after.qNo) / 1e18;
const p = Math.exp(qy / b) / (Math.exp(qy / b) + Math.exp(qn / b));
const p2 =
  Math.exp((qy + 1) / b) / (Math.exp((qy + 1) / b) + Math.exp(qn / b));

log("");
log(graduated ? "=== graduated ===" : `=== NOT graduated after ${rounds} rounds ===`);
log(`b            ${b}`);
log(`q            (${qy.toFixed(2)}, ${qn.toFixed(2)})`);
log(`YES price    ${p.toFixed(4)}`);
log(`+1 share ->  ${p2.toFixed(4)}  (${((p2 - p) * 100).toFixed(2)} pts impact)`);
if (!graduated) process.exit(1);
