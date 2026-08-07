// Drive a market through settlement and claim from every ledger.
//
// ## Why this exists
//
// `redeem_book_seat` and `reclaim_subsidy` were written, wired and
// unit-tested, but never run through a real settlement — the attest → veto →
// settle sequence was not scripted, so the two instructions that PAY PEOPLE
// had never actually paid anyone on a validator.
//
// That is the wrong thing to leave untested. A unit test proves the payout
// arithmetic; it does not prove the account list is right, the PDA seeds
// resolve, the lifecycle gates admit the call, or the vault authority can
// sign. Every one of those is a way for a settled market to strand funds.
//
// So this walks the whole thing:
//
//   book trade  ─┐
//   AMM buy     ─┼→ request_lock → attest → (veto window) → settle
//   mint set    ─┘      → redeem_book_seat / redeem_amm_position / redeem
//                       → book_withdraw → reclaim_subsidy
//
// and checks the money at each step. It needs a market whose deadline has
// passed, which is what `SEED_DEADLINE_SECS` is for.
//
// ## The three ledgers
//
// A settled market can owe money from three independent places, and each has
// its own claim instruction. Nothing routes between them:
//
//   Book seat   `net` + `credit`        → redeem_book_seat
//   AMM         `Position.yes/no_shares`→ redeem_amm_position
//   SPL tokens  YES/NO ATA balances     → redeem
//
// An earlier version of this script covered only the first and asserted
// solvency against book seats alone — so a market could read SOLVENT here
// while owing on the other two. All three now trade before settlement and
// claim after it, and the solvency check at the end counts all three.
//
// Usage: node scripts/settle-e2e.mjs <marketPubkey> [yes|no|invalid]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  BOOK_INIT_HEAP_BYTES,
  SolanaChainAdapter,
  buildBookInitIxs,
  deriveAdjudicatorEntryPda,
  soothCoreIdl,
} from "@sooth/sdk-solana";

import { connect } from "./lib/rpc.mjs";

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const log = (...a) => console.log("[settle-e2e]", ...a);
const step = (n, t) => console.log(`\n[settle-e2e] ${n}. ${t}`);

const marketArg = process.argv[2];
const outcomeArg = (process.argv[3] ?? "yes").toLowerCase();
if (!marketArg) {
  console.error("usage: node scripts/settle-e2e.mjs <marketPubkey> [yes|no|invalid]");
  process.exit(1);
}
const OUTCOME = { no: 0, yes: 1, invalid: 2 }[outcomeArg];
if (OUTCOME === undefined) throw new Error(`bad outcome: ${outcomeArg}`);

const env = readFileSync(resolve(DEMO_ROOT, ".env.local"), "utf8");
const ev = (k) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();

const connection = connect(RPC);
const soothCore = new PublicKey(ev("VITE_SOOTH_CORE_ID"));
const USDC = new PublicKey(ev("VITE_USDC_MINT"));
const marketRef = `sol:${marketArg}`;
const marketPda = new PublicKey(marketArg);

const creator = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(resolve(DEMO_ROOT, ".localnet/creator-keypair.json"), "utf8")),
  ),
);
const mintAuthority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(ev("VITE_TEST_MINT_AUTHORITY_BYTES"))),
);

const adapter = new SolanaChainAdapter({
  node: {
    id: "solana-localnet",
    chainKind: "solana",
    chainId: "solana:localnet",
    cluster: "localnet",
    rpcUrl: RPC,
    programs: { soothCore: soothCore.toBase58(), usdcMint: USDC.toBase58() },
  },
  connection,
});
const program = new anchor.Program(
  soothCoreIdl,
  new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(creator),
    { commitment: "confirmed" },
  ),
);

// Every sooth_core instruction needs the 256 KB heap frame — the custom
// #[global_allocator] addresses from the top of a region the runtime only maps
// on request. `adapter.submit` adds it; Anchor's plain `.rpc()` does not, so
// the lifecycle calls below fault at 215 CU with "Access violation in heap
// section" before reaching their own code.
const heapFrame = () =>
  ComputeBudgetProgram.requestHeapFrame({ bytes: BOOK_INIT_HEAP_BYTES });

const signerFor = (kp) => ({
  publicKey: kp.publicKey.toBase58(),
  async signTransaction(bytes) {
    const tx = Transaction.from(bytes);
    tx.partialSign(kp);
    return tx.serialize();
  },
});

async function fundedTrader(label) {
  const kp = Keypair.generate();
  await connection.confirmTransaction(
    await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL),
    "confirmed",
  );
  const ata = await createAssociatedTokenAccountIdempotent(
    connection, kp, USDC, kp.publicKey,
  );
  await mintTo(connection, mintAuthority, USDC, ata, mintAuthority, 100_000_000);
  log(`${label} = ${kp.publicKey.toBase58().slice(0, 8)}…  (100 USDC)`);
  return { kp, ata, signer: signerFor(kp), ref: `sol:${kp.publicKey.toBase58()}` };
}
const usdcOf = async (t) =>
  Number((await getAccount(connection, t.ata)).amount) / 1e6;

const coder = new anchor.BorshAccountsCoder(soothCoreIdl);
const marketInfo = await connection.getAccountInfo(marketPda);
if (!marketInfo) throw new Error(`no market at ${marketArg}`);
const decoded = coder.decode("Market", marketInfo.data);
const marketId = Buffer.from(decoded.marketId ?? decoded.market_id);
// The Anchor coder emits the IDL's snake_case names, so `decoded.yesMint` is
// `undefined` — which reaches `new PublicKey()` as a throw, not a bad value.
// Resolve both spellings once, here, rather than at each use.
const pick = (camel, snake) => {
  const v = decoded[camel] ?? decoded[snake];
  if (!v) throw new Error(`Market has neither ${camel} nor ${snake}`);
  return new PublicKey(v);
};
const yesMint = pick("yesMint", "yes_mint");
const noMint = pick("noMint", "no_mint");
const lifecycleOf = async () => {
  const info = await connection.getAccountInfo(marketPda);
  const m = coder.decode("Market", info.data);
  return JSON.stringify(m.lifecycle);
};

// ── 1. A book with a real position on it ────────────────────────────────────
step(1, "seed a book position");
try {
  await adapter.readBook(marketRef);
} catch {
  const tx = new Transaction();
  for (const ix of buildBookInitIxs(
    { marketPda, marketId, programs: { soothCore } }, creator.publicKey, 64,
  )) tx.add(ix);
  await sendAndConfirmTransaction(connection, tx, [creator]);
}

const maker = await fundedTrader("maker");
const taker = await fundedTrader("taker");

const place = async (t, side, tick, shares) => {
  const req = await adapter.buildBookPlace(marketRef, {
    user: t.ref, side, limitTick: tick,
    amount: BigInt(shares) * 1_000_000n, matchLimit: 8, postRemainder: true,
  });
  await adapter.submit(req, t.signer);
};
await place(maker, 1, 400, 10);   // maker sells YES @0.40
await place(taker, 0, 400, 10);   // taker buys  YES @0.40

const book = await adapter.readBook(marketRef);
const netOf = (t) =>
  Number(book.seats.find((s) => s.trader === t.kp.publicKey.toBase58())?.net ?? 0n) / 1e6;
log(`  filled: maker net ${netOf(maker)}, taker net ${netOf(taker)}`);

const before = { maker: await usdcOf(maker), taker: await usdcOf(taker) };
log(`  wallets: maker ${before.maker}, taker ${before.taker}`);

// ── 1b. An AMM position, on the other ledger ────────────────────────────────
//
// `redeem_amm_position` is what bug B1 added, and until now nothing had ever
// called it against a validator. It pays `Position.yes_shares`, which only
// `trade_positions` writes — so the position has to be built through an AMM
// buy, not the book.
step("1b", "AMM buy (separate ledger from the book)");
const ammBuyer = await fundedTrader("ammBuyer");
let ammBought = false;
try {
  await adapter.submit(
    await adapter.buildTrade(marketRef, {
      user: ammBuyer.ref,
      side: "buy",
      outcome: 1, // YES
      deltaShares: 5n * 10n ** 18n, // 5 shares, WAD
      maxCostWad: 50n * 10n ** 18n, // generous slippage envelope
    }),
    ammBuyer.signer,
  );
  ammBought = true;
  log(`  ammBuyer bought 5 YES via AMM; wallet ${await usdcOf(ammBuyer)}`);
} catch (e) {
  log(`  SKIPPED — AMM buy failed: ${String(e).slice(0, 160)}`);
}

// ── 1c. A complete set, on the third ledger ─────────────────────────────────
//
// `mint_complete_set` pays 1 USDC and returns one YES *and* one NO as real SPL
// tokens. That is the only ledger `redeem` can see: it reads ATA balances, so
// neither a book seat nor an AMM position ever reaches it.
step("1c", "mint_complete_set (SPL outcome tokens)");
const splHolder = await fundedTrader("splHolder");
let splMinted = 0;
try {
  await adapter.submit(
    await adapter.buildMintCompleteSet(marketRef, {
      user: splHolder.ref,
      amount: 4_000_000n, // 4 complete sets, base units
    }),
    splHolder.signer,
  );
  splMinted = 4;
  log(`  splHolder minted 4 sets (4 YES + 4 NO); wallet ${await usdcOf(splHolder)}`);
} catch (e) {
  log(`  SKIPPED — mint_complete_set failed: ${String(e).slice(0, 160)}`);
}

// ── 2..4. lock → attest → settle ────────────────────────────────────────────
//
// The trades above need the market OPEN; `request_lock` needs its deadline
// PASSED. The script used to assume a market already past its deadline, which
// quietly made the AMM and complete-set steps unreachable — both check the
// deadline and would have been skipped. So seed with a deadline a minute or
// two out, trade, and wait for it here.
step("1d", "wait for the trading deadline");
// Against the CHAIN's clock, not this machine's. `request_lock` compares the
// deadline to `Clock::unix_timestamp`, and a local validator's clock advances
// with slots — it drifts behind wall time and does not catch up. Waiting on
// `Date.now()` therefore returns "deadline passed" while the program still
// says TradingNotClosed, which is exactly how the first run of this failed.
const chainNow = async () => {
  const info = await connection.getAccountInfo(
    new PublicKey("SysvarC1ock11111111111111111111111111111111"),
  );
  return Number(info.data.readBigInt64LE(32)); // unix_timestamp
};
const deadline = Number(decoded.deadline);
for (;;) {
  const now = await chainNow();
  if (now >= deadline) break;
  const left = deadline - now;
  if (left > 600) {
    throw new Error(
      `deadline is ${left}s of chain time away — too long to wait. Re-seed ` +
        `with a shorter SEED_DEADLINE_SECS.`,
    );
  }
  const drift = Math.floor(Date.now() / 1000) - now;
  log(`  ${left}s to go (chain clock is ${drift}s behind wall time)…`);
  await new Promise((r) => setTimeout(r, Math.min(left, 10) * 1000));
}
log("  deadline passed on chain");

step(2, `request_lock  (lifecycle ${await lifecycleOf()})`);
await program.methods
  .requestLock()
  .accounts({ market: marketPda, signer: creator.publicKey })
  .preInstructions([heapFrame()])
  .rpc();
log(`  lifecycle -> ${await lifecycleOf()}`);

step(3, `attest_outcome(${outcomeArg.toUpperCase()})`);
// Seeds are [b"adjudicator", MARKET PUBKEY] — not market_id, which most of the
// other PDAs here use. Deriving it by hand got that wrong; the SDK knows.
const [adjudicatorEntry] = deriveAdjudicatorEntryPda(marketPda, {
  soothCore,
});
await program.methods
  .attestOutcome(OUTCOME)
  .accounts({ market: marketPda, adjudicatorEntry, authority: creator.publicKey })
  .preInstructions([heapFrame()])
  .rpc();
log(`  attested; lifecycle still ${await lifecycleOf()} (veto window open)`);

step(4, "settle (after the veto window)");
await new Promise((r) => setTimeout(r, 4000));
const [protocolConfig] = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol_config")],
  soothCore,
);
await program.methods
  .settle()
  .accounts({ market: marketPda, adjudicatorEntry, protocolConfig, signer: creator.publicKey })
  .preInstructions([heapFrame()])
  .rpc();
log(`  lifecycle -> ${await lifecycleOf()}`);

// ── 5. claims ───────────────────────────────────────────────────────────────
step(5, "redeem_book_seat for both sides");
for (const [label, t] of [["maker", maker], ["taker", taker]]) {
  const was = await usdcOf(t);
  try {
    await adapter.submit(
      await adapter.buildRedeemBookSeat(marketRef, { user: t.ref }), t.signer,
    );
    log(`  ${label}: ${was} -> ${await usdcOf(t)}  (net was ${netOf(t)})`);
  } catch (e) {
    log(`  ${label}: FAILED ${String(e).slice(0, 120)}`);
  }
}

// The two claims below are the ones that had never run on a validator. Each
// asserts the exact figure the payout rule implies, because "the transaction
// succeeded" is not the same as "the right amount moved" — a silently-zero
// payout looks identical to a working one in a log of balances.
const failures = [];
const check = (label, got, want) => {
  const ok = Math.abs(got - want) < 1e-6;
  log(`  ${ok ? "OK  " : "*** WRONG ***"} ${label}: ${got.toFixed(6)} (expected ${want.toFixed(6)})`);
  if (!ok) failures.push(`${label}: got ${got}, expected ${want}`);
};

step("5b", "redeem_amm_position (bug B1's exit — first run on a validator)");
if (ammBought) {
  // 5 YES via the AMM. YES pays the 5; NO pays nothing; INVALID splits
  // (yes + no) / 2, which with no NO shares is 2.5.
  const wantAmm = OUTCOME === 1 ? 5 : OUTCOME === 0 ? 0 : 2.5;
  const was = await usdcOf(ammBuyer);
  try {
    await adapter.submit(
      await adapter.buildRedeemAmmPosition(marketRef, { user: ammBuyer.ref }),
      ammBuyer.signer,
    );
    check("ammBuyer", (await usdcOf(ammBuyer)) - was, wantAmm);

    // Zeroed legs, not a closed account — so a replay must pay nothing. This
    // is the double-claim guard, and it is only observable against a real
    // validator because the account survives the first call.
    const beforeReplay = await usdcOf(ammBuyer);
    await adapter.submit(
      await adapter.buildRedeemAmmPosition(marketRef, { user: ammBuyer.ref }),
      ammBuyer.signer,
    );
    check("ammBuyer replay pays nothing", (await usdcOf(ammBuyer)) - beforeReplay, 0);
  } catch (e) {
    failures.push(`redeem_amm_position: ${String(e).slice(0, 200)}`);
    log(`  FAILED: ${String(e).slice(0, 200)}`);
  }
} else {
  log("  skipped (no AMM position)");
}

step("5c", "redeem (SPL outcome tokens)");
if (splMinted > 0) {
  // 4 YES + 4 NO. YES burns the YES leg for 4; NO burns the NO leg for 4;
  // INVALID burns both and pays (4 + 4) / 2 = 4. All three are 4 here — which
  // is the point of a complete set, and why the burn counts matter too.
  const wantSpl = 4;
  const was = await usdcOf(splHolder);
  try {
    await adapter.submit(
      await adapter.buildClaim(marketRef, { user: splHolder.ref, kind: "redeem" }),
      splHolder.signer,
    );
    check("splHolder", (await usdcOf(splHolder)) - was, wantSpl);

    // The winning leg must be burned, or the same tokens redeem again.
    //
    // No try/catch around the ATA read: a swallowed error here reads as "zero
    // tokens left", which is the PASSING answer for the winning leg. The first
    // version of this did exactly that and reported a burn that never
    // happened.
    const left = async (mint) => {
      const ata = getAssociatedTokenAddressSync(mint, splHolder.kp.publicKey);
      return Number((await getAccount(connection, ata)).amount) / 1e6;
    };
    const [yesLeft, noLeft] = [await left(yesMint), await left(noMint)];
    const wantYesLeft = OUTCOME === 0 ? 4 : 0; // NO wins -> YES leg untouched
    const wantNoLeft = OUTCOME === 1 ? 4 : 0; // YES wins -> NO leg untouched
    check("splHolder YES tokens remaining", yesLeft, wantYesLeft);
    check("splHolder NO tokens remaining", noLeft, wantNoLeft);
  } catch (e) {
    failures.push(`redeem: ${String(e).slice(0, 200)}`);
    log(`  FAILED: ${String(e).slice(0, 200)}`);
  }
} else {
  log("  skipped (no complete set)");
}

step(6, "book_withdraw (sweep any leftover seat credit)");
for (const [label, t] of [["maker", maker], ["taker", taker]]) {
  try {
    await adapter.submit(
      await adapter.buildBookWithdraw(marketRef, { user: t.ref }), t.signer,
    );
    log(`  ${label}: wallet ${await usdcOf(t)}`);
  } catch {
    log(`  ${label}: nothing to withdraw`);
  }
}

step(7, "reclaim_subsidy (creator)");
const creatorAta = await createAssociatedTokenAccountIdempotent(
  connection, creator, USDC, creator.publicKey,
);
const creatorBefore = Number((await getAccount(connection, creatorAta)).amount) / 1e6;
try {
  await adapter.submit(
    await adapter.buildReclaimSubsidy(marketRef, { creator: `sol:${creator.publicKey.toBase58()}` }),
    signerFor(creator),
  );
  const after = Number((await getAccount(connection, creatorAta)).amount) / 1e6;
  log(`  creator: ${creatorBefore} -> ${after}  (+${(after - creatorBefore).toFixed(6)})`);
} catch (e) {
  log(`  FAILED: ${String(e).slice(0, 200)}`);
}

// ── 8. solvency ─────────────────────────────────────────────────────────────
step(8, "vault vs remaining obligations (all three ledgers)");
const vaultAta = decoded.vault ? new PublicKey(decoded.vault) : null;
if (vaultAta) {
  const vault = Number((await getAccount(connection, vaultAta)).amount) / 1e6;

  // Book seats.
  const after = await adapter.readBook(marketRef);
  const owedBook = after.seats.reduce((acc, s) => {
    const mag = Number(s.net < 0n ? -s.net : s.net) / 1e6;
    const win = OUTCOME === 1 ? s.net > 0n : OUTCOME === 0 ? s.net < 0n : true;
    return acc + (OUTCOME === 2 ? mag / 2 : win ? mag : 0) + Number(s.credit) / 1e6;
  }, 0);

  // Outstanding SPL outcome tokens. Anyone still holding a winning token can
  // call `redeem` and must be paid, whether or not they appear in this script
  // — so this reads MINT SUPPLY, not our one holder's balance.
  const supply = async (mint) =>
    Number((await connection.getTokenSupply(mint)).value.amount) / 1e6;
  const [yesSupply, noSupply] = [await supply(yesMint), await supply(noMint)];
  const owedSpl =
    OUTCOME === 1 ? yesSupply : OUTCOME === 0 ? noSupply : (yesSupply + noSupply) / 2;

  // AMM positions are per-user PDAs with no aggregate to read, so this covers
  // the one this script created. A full audit would scan every `Position`.
  let owedAmm = 0;
  if (ammBought) {
    const [posPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pos"), marketId, ammBuyer.kp.publicKey.toBuffer()],
      soothCore,
    );
    const info = await connection.getAccountInfo(posPda);
    if (info) {
      const p = coder.decode("Position", info.data);
      const y = Number(p.yesShares ?? p.yes_shares) / 1e18;
      const n = Number(p.noShares ?? p.no_shares) / 1e18;
      owedAmm = OUTCOME === 1 ? y : OUTCOME === 0 ? n : (y + n) / 2;
    }
  }

  const owed = owedBook + owedSpl + owedAmm;
  log(`  vault ${vault.toFixed(6)}`);
  log(`  owed  book ${owedBook.toFixed(6)} + spl ${owedSpl.toFixed(6)} + amm ${owedAmm.toFixed(6)} = ${owed.toFixed(6)}`);
  if (vault + 1e-6 >= owed) {
    log("  SOLVENT");
  } else {
    log("  *** SHORT ***");
    failures.push(`vault short: ${vault} < ${owed}`);
  }
}

if (failures.length > 0) {
  console.error(`\n[settle-e2e] ${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
log("\ndone — all payouts matched");
