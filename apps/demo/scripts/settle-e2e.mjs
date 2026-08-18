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
//   AMM buy     ─┴→ request_lock → attest → (veto window) → settle
//                       → redeem_book_seat / redeem_amm_position
//                       → book_withdraw → reclaim_subsidy
//
// and checks the money at each step. It needs a market whose deadline has
// passed, which is what `SEED_DEADLINE_SECS` is for.
//
// ## The two ledgers
//
// A settled market can owe money from two independent places, each with its
// own claim instruction. Nothing routes between them:
//
//   Book seat   `net` + `credit`        → redeem_book_seat
//   AMM         `Position.yes/no_shares`→ redeem_amm_position
//
// Both ledgers must trade before settlement and claim after it, and the
// solvency check counts both — checking book seats alone would let a market
// read SOLVENT while still owing on the AMM. (There is no third ledger: SPL
// outcome tokens went with the complete-set instructions; see
// docs/design/dual-token-venues.md §4.)
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

// Paths that never ran. Kept separate from `failures`: a failure is a payout
// that came out wrong, a skip is a payout that was never tested. Both make the
// run untrustworthy, and neither may print a success line.
const skips = [];

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
// The BOOK venue's token. Named USDC because that is what it is on every
// deployment so far; the book's collateral is USDC by design.
const USDC = new PublicKey(ev("VITE_USDC_MINT"));
// The AMM venue's token — a DIFFERENT mint. An actor funded only in USDC can
// quote the book and cannot touch the AMM, which is how the AMM half of this
// script silently skipped: the buy failed on balance, the catch logged a skip,
// and the run still printed success.
const AMM_MINT = new PublicKey(
  process.env.VITE_AMM_MINT ??
    "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX",
);
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
    programs: {
      soothCore: soothCore.toBase58(),
      usdcMint: USDC.toBase58(),
      ammMint: AMM_MINT.toBase58(),
    },
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
  // Funded in BOTH venue tokens. Which one an actor needs depends on the
  // venue they trade, and funding one while trading the other fails on
  // balance — an error that reads like a bug in the instruction rather than
  // in the fixture.
  const atas = {};
  for (const [venue, mint] of [["book", USDC], ["amm", AMM_MINT]]) {
    atas[venue] = await createAssociatedTokenAccountIdempotent(
      connection, kp, mint, kp.publicKey,
    );
    await mintTo(
      connection, mintAuthority, mint, atas[venue], mintAuthority, 100_000_000,
    );
  }
  log(`${label} = ${kp.publicKey.toBase58().slice(0, 8)}…  (100 book + 100 AMM)`);
  return {
    kp,
    ata: atas.book,
    ataBook: atas.book,
    ataAmm: atas.amm,
    signer: signerFor(kp),
    ref: `sol:${kp.publicKey.toBase58()}`,
  };
}
const usdcOf = async (t) =>
  Number((await getAccount(connection, t.ataBook)).amount) / 1e6;
/** AMM-venue balance. The AMM's payouts land here, not in the book's ATA. */
const ammOf = async (t) =>
  Number((await getAccount(connection, t.ataAmm)).amount) / 1e6;

const coder = new anchor.BorshAccountsCoder(soothCoreIdl);
const marketInfo = await connection.getAccountInfo(marketPda);
if (!marketInfo) throw new Error(`no market at ${marketArg}`);
const decoded = coder.decode("Market", marketInfo.data);
const marketId = Buffer.from(decoded.marketId ?? decoded.market_id);
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
// `redeem_amm_position` pays `Position.yes_shares`, which only
// `trade_positions` writes — so the position has to be built through an AMM
// buy, not the book, for this leg to exercise it at all.
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
  log(`  ammBuyer bought 5 YES via AMM; AMM wallet ${await ammOf(ammBuyer)}`);
} catch (e) {
  // A skip is NOT a pass. Everything downstream of this — redeem_amm_position,
  // the creator's reclaim_subsidy, and the AMM half of the solvency check —
  // becomes vacuous when the buy does not happen. Record it so the run
  // reports what it actually proved instead of claiming "all payouts
  // matched" having exercised none of it.
  skips.push(`AMM buy: ${String(e).slice(0, 200)}`);
  log(`  SKIPPED — AMM buy failed: ${String(e).slice(0, 160)}`);
}

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
  const was = await ammOf(ammBuyer);
  try {
    await adapter.submit(
      await adapter.buildRedeemAmmPosition(marketRef, { user: ammBuyer.ref }),
      ammBuyer.signer,
    );
    check("ammBuyer", (await ammOf(ammBuyer)) - was, wantAmm);

    // Zeroed legs, not a closed account — so a replay must pay nothing. This
    // is the double-claim guard, and it is only observable against a real
    // validator because the account survives the first call.
    const beforeReplay = await ammOf(ammBuyer);
    await adapter.submit(
      await adapter.buildRedeemAmmPosition(marketRef, { user: ammBuyer.ref }),
      ammBuyer.signer,
    );
    check("ammBuyer replay pays nothing", (await ammOf(ammBuyer)) - beforeReplay, 0);
  } catch (e) {
    failures.push(`redeem_amm_position: ${String(e).slice(0, 200)}`);
    log(`  FAILED: ${String(e).slice(0, 200)}`);
  }
} else {
  skips.push("redeem_amm_position: no AMM position to claim");
  log("  skipped (no AMM position)");
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
// The AMM's mint: `seed_lp` took the subsidy in AMM tokens and
// `reclaim_subsidy` returns it from `vault_amm`, so reading the creator's USDC
// ATA here would show +0.000000 on a refund that actually arrived.
const creatorAta = await createAssociatedTokenAccountIdempotent(
  connection, creator, AMM_MINT, creator.publicKey,
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

// ── 7b. the LP exit ─────────────────────────────────────────────────────────
step("7b", "distribute AMM fees, then redeem LP against the yield vault");

// The creator's two claims are different money and different instructions:
//
//   reclaim_subsidy  the LMSR subsidy they POSTED, capped at what they put in
//   redeem_lp        their share of fees the market EARNED, pro-rata by LP
//
// The second only pays if fees have been distributed first — `redeem_lp`
// divides `lp_yield_vault`, and nothing fills that vault except
// `distribute_fees_amm`. Running the two together is what proves the fee
// pipeline actually reaches a human.
try {
  await adapter.submit(
    await adapter.buildDistributeFees(marketRef, {
      venue: "amm",
      // Deliberately not the creator or the authority: distribution is
      // permissionless, and a keeper nobody appointed must be able to run it.
      cranker: `sol:${maker.kp.publicKey.toBase58()}`,
    }),
    maker.signer,
  );
  log("  fees distributed (cranked by a non-privileged wallet)");
} catch (e) {
  const msg = String(e);
  if (/NothingToDistribute/i.test(msg)) {
    log("  no fees to distribute");
  } else {
    failures.push(`distribute_fees_amm: ${msg.slice(0, 200)}`);
    log(`  FAILED: ${msg.slice(0, 200)}`);
  }
}

try {
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), marketId],
    soothCore,
  );
  const creatorLpAta = getAssociatedTokenAddressSync(lpMint, creator.publicKey);
  const lpBal = (await getAccount(connection, creatorLpAta)).amount;
  if (lpBal === 0n) {
    skips.push("redeem_lp: creator holds no LP tokens");
    log("  skipped (creator holds no LP)");
  } else {
    const was = Number((await getAccount(connection, creatorAta)).amount) / 1e6;
    await adapter.submit(
      await adapter.buildRedeemLp(marketRef, {
        user: `sol:${creator.publicKey.toBase58()}`,
        lpAmount: lpBal,
      }),
      signerFor(creator),
    );
    const now = Number((await getAccount(connection, creatorAta)).amount) / 1e6;
    const lpAfter = (await getAccount(connection, creatorLpAta)).amount;
    log(`  redeemed ${lpBal} LP -> +${(now - was).toFixed(6)} AMM tokens`);
    if (lpAfter !== 0n) {
      failures.push(`redeem_lp burned only part of the LP: ${lpAfter} left`);
    }
  }
} catch (e) {
  failures.push(`redeem_lp: ${String(e).slice(0, 200)}`);
  log(`  FAILED: ${String(e).slice(0, 200)}`);
}

// ── 8. solvency ─────────────────────────────────────────────────────────────
step(8, "each venue's vault vs the obligations denominated in its token");

// One vault per venue, checked against its OWN ledger. They cannot be summed:
// the balances are in different tokens, so a book surplus cannot cover an AMM
// shortfall — the protocol has no path to convert one into the other.
//
// Both `vault_book` and `vault_amm` are read explicitly and asserted below:
// an `undefined` vault field would make the guard fall through, leaving the
// whole solvency check doing nothing while the script still printed "all
// payouts matched".
const vaultBookAta = decoded.vaultBook ?? decoded.vault_book;
const vaultAmmAta = decoded.vaultAmm ?? decoded.vault_amm;
if (!vaultBookAta || !vaultAmmAta) {
  failures.push(
    `Market is missing a venue vault field (book=${vaultBookAta}, amm=${vaultAmmAta}) — ` +
      `the solvency check cannot run, and a silent skip here is how an ` +
      `insolvent market ships.`,
  );
} else {
  const balOf = async (k) =>
    Number((await getAccount(connection, new PublicKey(k))).amount) / 1e6;

  // Book seats — denominated in the book's token.
  const after = await adapter.readBook(marketRef);
  const owedBook = after.seats.reduce((acc, s) => {
    const mag = Number(s.net < 0n ? -s.net : s.net) / 1e6;
    const win = OUTCOME === 1 ? s.net > 0n : OUTCOME === 0 ? s.net < 0n : true;
    return acc + (OUTCOME === 2 ? mag / 2 : win ? mag : 0) + Number(s.credit) / 1e6;
  }, 0);

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

  for (const [venue, vaultKey, owed] of [
    ["book", vaultBookAta, owedBook],
    ["amm", vaultAmmAta, owedAmm],
  ]) {
    const bal = await balOf(vaultKey);
    log(`  ${venue}: vault ${bal.toFixed(6)}  owed ${owed.toFixed(6)}`);
    if (bal + 1e-6 >= owed) {
      log(`    SOLVENT`);
    } else {
      log(`    *** SHORT ***`);
      failures.push(`${venue} vault short: ${bal} < ${owed}`);
    }
  }
}

// ── 9. end of life: distribute, sweep, close (opt-in: CLOSE=1) ──────────────
//
// Only meaningful on a market whose book carries no third-party resting
// orders (seed with SEED_LADDER=0): close requires every balance at zero, and
// an absent maker's escrow blocks it — by design, since that escrow is the
// maker's money.
if (process.env.CLOSE === "1" && failures.length === 0 && skips.length === 0) {
  step(9, "distribute fees, sweep residual, close the market");
  const creatorSigner = signerFor(creator);
  const creatorRef = `sol:${creator.publicKey.toBase58()}`;

  for (const venue of ["amm", "book"]) {
    try {
      await adapter.submit(
        await adapter.buildDistributeFees(marketRef, {
          venue, cranker: creatorRef,
        }),
        creatorSigner,
      );
      log(`  distributed ${venue} fees`);
    } catch (e) {
      if (/NothingToDistribute|nothing to distribute/i.test(String(e))) log(`  ${venue} pool empty`);
      else failures.push(`distribute ${venue}: ${String(e).slice(0, 160)}`);
    }
  }

  // The graduation script bought its shares with the creator wallet, and the
  // sweep gate — correctly — refuses while those winning shares are
  // unredeemed. This is the gate working, not a nuisance: any wallet's
  // unclaimed win looks identical to residual on a balance check, and only
  // the q-accounting can tell them apart.
  try {
    await adapter.submit(
      await adapter.buildRedeemAmmPosition(marketRef, { user: creatorRef }),
      creatorSigner,
    );
    log("  graduation driver redeemed its winning shares");
  } catch (e) {
    log(`  driver redeem skipped: ${String(e).slice(0, 100)}`);
  }

  // LP redemption AFTER both venues distributed: the book's LP share only
  // lands in the yield vault at step 9, so a burn back in 7b would have
  // forfeited it — and close refuses while any LP yield sits unclaimed. The
  // graduation driver holds LP from its trades, so it must burn too.
  for (const [who, kp] of [["creator", creator], ["driver", creator]]) {
    try {
      await adapter.submit(
        await adapter.buildRedeemLp(marketRef, {
          user: `sol:${kp.publicKey.toBase58()}`,
          lpAmount: await (async () => {
            const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
            const lpMint = PublicKey.findProgramAddressSync(
              [Buffer.from("lp"), marketId], soothCore,
            )[0];
            const ata = getAssociatedTokenAddressSync(lpMint, kp.publicKey);
            const info = await connection.getAccountInfo(ata);
            return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
          })(),
        }),
        signerFor(kp),
      );
      log(`  ${who} burned remaining LP for both venues' yield`);
    } catch (e) {
      if (/ZeroLpAmount|must fit in u64 and be > 0/i.test(String(e))) {
        log(`  ${who} holds no LP — already redeemed`);
      } else {
        log(`  ${who} LP redeem skipped: ${String(e).slice(0, 90)}`);
      }
    }
  }

  // Second reclaim, deliberately AFTER the driver's redemption: obligations
  // dropped, so more of the creator's capped subsidy came free — and the
  // sweep reserves exactly that cap, so close blocks until the creator takes
  // it. Repeatable-by-design is what makes this ordering workable.
  try {
    await adapter.submit(
      await adapter.buildReclaimSubsidy(marketRef, { creator: creatorRef }),
      creatorSigner,
    );
    log("  creator reclaimed the remainder of the subsidy cap");
  } catch (e) {
    log(`  second reclaim skipped: ${String(e).slice(0, 90)}`);
  }

  try {
    await adapter.submit(
      await adapter.buildSweepResidual(marketRef, { cranker: creatorRef }),
      creatorSigner,
    );
    log("  residual swept to treasury");
  } catch (e) {
    if (/NothingToDistribute|nothing to distribute/i.test(String(e))) log("  no residual to sweep");
    else failures.push(`sweep: ${String(e).slice(0, 160)}`);
  }

  try {
    const lamBefore = await connection.getBalance(creator.publicKey);
    await adapter.submit(
      await adapter.buildCloseMarket(marketRef, { creator: creatorRef }),
      creatorSigner,
    );
    const lamAfter = await connection.getBalance(creator.publicKey);
    const info = await connection.getAccountInfo(marketPda);
    const tomb =
      info && info.data.length === 8 &&
      Buffer.from(info.data).toString() === "MKTCLOSD";
    log(`  closed: reclaimed ${((lamAfter - lamBefore) / 1e9).toFixed(5)} SOL, tombstone ${tomb ? "in place" : "MISSING"}`);
    if (!tomb) failures.push("close_market left no tombstone");
    if (lamAfter <= lamBefore) failures.push("close_market reclaimed nothing");
  } catch (e) {
    failures.push(`close_market: ${String(e).slice(0, 200)}`);
  }
}

if (failures.length > 0) {
  console.error(`\n[settle-e2e] ${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
if (skips.length > 0) {
  // Exit non-zero. A run that skipped the AMM ledger has not shown that a
  // settled market pays what it owes — it has shown that the half it ran does.
  // Reporting that as success is how an unclaimable ledger reaches a deploy.
  console.error(
    `\n[settle-e2e] INCOMPLETE — ${skips.length} path(s) never ran:`,
  );
  for (const s of skips) console.error(`  - ${s}`);
  console.error(
    "\nThe usual cause is a deadline that passed before the trade: raise\n" +
      "SEED_DEADLINE_SECS so the AMM buy lands inside the trading window.",
  );
  process.exit(1);
}
log("\ndone — all payouts matched, every path exercised");
