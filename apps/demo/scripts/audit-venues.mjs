// Post-seed audit against the live localnet ledger.
//
// The unit suites prove the program refuses what it should. This checks the
// other half: that a real seeded ledger is actually in the shape those proofs
// assume — two distinct venue vaults per market, the graduation flag set where
// the fixture says it graduated, fees accumulating in the venue that earned
// them, and the fee pool draining to the pinned destinations.

import { readFileSync } from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { Program, AnchorProvider, BN } = anchorPkg;
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const ROOT = "/Users/mohammadzakerirad/Sooth/sooth-solana/.agents/analyze";
const idl = JSON.parse(
  readFileSync(`${ROOT}/packages/sdk-solana/src/anchor/sooth_core.json`, "utf8"),
);

const env = Object.fromEntries(
  readFileSync(`${ROOT}/apps/demo/.env.local`, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const PROGRAM_ID = new PublicKey(env.VITE_SOOTH_CORE_ID);
const BOOK_MINT = new PublicKey(env.VITE_USDC_MINT);
const AMM_MINT = new PublicKey("CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu");
const GRADUATED = new PublicKey(env.VITE_DEMO_MARKET_REF.replace("sol:", ""));
const BONDING = new PublicKey(
  env.VITE_DEMO_EXTRA_MARKET_REFS.replace("sol:", ""),
);

const kp = (bytes) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(bytes)));
const creator = kp(env.VITE_TEST_AUTHORITY_BYTES);
const user = kp(env.VITE_TEST_KEYPAIR_BYTES);

const connection = new Connection(RPC, "confirmed");
const wallet = {
  publicKey: creator.publicKey,
  signTransaction: async (tx) => (tx.partialSign(creator), tx),
  signAllTransactions: async (txs) => (txs.forEach((t) => t.partialSign(creator)), txs),
  payer: creator,
};
const program = new Program(
  idl,
  new AnchorProvider(connection, wallet, { commitment: "confirmed" }),
);

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function balance(addr) {
  const info = await connection.getAccountInfo(addr);
  if (!info || info.data.length < 72) return null;
  return Buffer.from(info.data).readBigUInt64LE(64);
}

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

// ── 1. Market shape ────────────────────────────────────────────────────────
console.log("\n[1] market accounts carry two distinct venue vaults");
const markets = {};
for (const [name, key] of [["graduated", GRADUATED], ["bonding", BONDING]]) {
  const m = await program.account.market.fetch(key);
  markets[name] = m;
  const vAmm = m.vaultAmm.toBase58();
  const vBook = m.vaultBook.toBase58();
  check(`${name}: vault_amm ≠ vault_book`, vAmm !== vBook, `${vAmm.slice(0, 8)} / ${vBook.slice(0, 8)}`);

  const ammInfo = await connection.getAccountInfo(m.vaultAmm);
  const bookInfo = await connection.getAccountInfo(m.vaultBook);
  const mintOf = (i) => (i ? new PublicKey(i.data.subarray(0, 32)).toBase58() : "missing");
  check(`${name}: vault_amm holds the AMM mint`, mintOf(ammInfo) === AMM_MINT.toBase58());
  check(`${name}: vault_book holds the book mint`, mintOf(bookInfo) === BOOK_MINT.toBase58());
}

// ── 2. Graduation gate ─────────────────────────────────────────────────────
console.log("\n[2] book_enabled matches what the fixture claims");
check("graduated market has book_enabled", markets.graduated.bookEnabled === true);
check("bonding market has book_enabled = false", markets.bonding.bookEnabled === false);

// ── 3. An AMM trade moves ONLY AMM tokens ──────────────────────────────────
console.log("\n[3] an AMM buy touches the AMM venue and nothing else");
const mid = markets.bonding.marketId;
const seeds = {
  // Seeds are the program's, not guesses — see packages/sdk-solana/src/pdas.ts.
  ammState: pda([Buffer.from("amm"), Buffer.from(mid)]),
  position: pda([Buffer.from("pos"), Buffer.from(mid), user.publicKey.toBuffer()]),
  vaultAuthority: pda([Buffer.from("vault"), Buffer.from(mid)]),
  feePoolAmm: pda([Buffer.from("fee_pool_amm"), Buffer.from(mid)]),
  feePoolBook: pda([Buffer.from("fee_pool_book"), Buffer.from(mid)]),
  config: pda([Buffer.from("protocol_config")]),
  lpMint: pda([Buffer.from("lp"), Buffer.from(mid)]),
  lpMintAuthority: pda([Buffer.from("lp_mint_authority"), Buffer.from(mid)]),
};

const before = {
  vaultAmm: await balance(markets.bonding.vaultAmm),
  vaultBook: await balance(markets.bonding.vaultBook),
  feeAmm: await balance(seeds.feePoolAmm),
  feeBook: await balance(seeds.feePoolBook),
};

const userAmmAta = getAssociatedTokenAddressSync(AMM_MINT, user.publicKey);
const userLpAta = getAssociatedTokenAddressSync(seeds.lpMint, user.publicKey);
const asUser = new Program(
  idl,
  new AnchorProvider(
    connection,
    {
      publicKey: user.publicKey,
      signTransaction: async (tx) => (tx.partialSign(user), tx),
      signAllTransactions: async (txs) => (txs.forEach((t) => t.partialSign(user)), txs),
      payer: user,
    },
    { commitment: "confirmed" },
  ),
);

const HEAP = () => ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 });
const CU = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });

const buyTx = new Transaction()
  .add(HEAP())
  .add(CU())
  .add(
    createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userLpAta, user.publicKey, seeds.lpMint,
    ),
  )
  .add(
    await asUser.methods
      .tradePositions(1, new BN((5n * 10n ** 18n).toString()), new BN((100n * 10n ** 18n).toString()))
      .accounts({
        market: BONDING,
        ammState: seeds.ammState,
        position: seeds.position,
        vaultAuthority: seeds.vaultAuthority,
        userAmmAta,
        marketVault: markets.bonding.vaultAmm,
        ammMint: AMM_MINT,
        protocolConfig: seeds.config,
        marketFeePool: seeds.feePoolAmm,
        lpMint: seeds.lpMint,
        lpMintAuthority: seeds.lpMintAuthority,
        userLpAta,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction(),
  );

try {
  const sig = await connection.sendTransaction(buyTx, [user]);
  await connection.confirmTransaction(sig, "confirmed");
  const after = {
    vaultAmm: await balance(markets.bonding.vaultAmm),
    vaultBook: await balance(markets.bonding.vaultBook),
    feeAmm: await balance(seeds.feePoolAmm),
    feeBook: await balance(seeds.feePoolBook),
  };
  check("AMM vault grew", after.vaultAmm > before.vaultAmm, `+${after.vaultAmm - before.vaultAmm}`);
  check("AMM fee pool grew", after.feeAmm > before.feeAmm, `+${after.feeAmm - before.feeAmm}`);
  check("book vault UNCHANGED", after.vaultBook === before.vaultBook);
  check("book fee pool UNCHANGED", after.feeBook === before.feeBook);
} catch (e) {
  check("AMM buy succeeded", false, String(e.message ?? e).slice(0, 160));
}

// ── 4. The fee pool drains to the pinned destinations ──────────────────────
console.log("\n[4] distribute_fees_amm pays the pinned destinations");
const cfg = await program.account.protocolConfig.fetch(seeds.config);
const feePoolAuthority = pda([Buffer.from("fee_pool_authority")]);
const lpYieldAuthority = pda([Buffer.from("lp_yield_authority")]);

const dest = {
  lp: pda([Buffer.from("lp_yield_amm"), Buffer.from(mid)]),
  adj: getAssociatedTokenAddressSync(AMM_MINT, markets.bonding.adjudicator, true),
  treasury: getAssociatedTokenAddressSync(AMM_MINT, cfg.treasury, true),
};
await connection.confirmTransaction(
  await connection.sendTransaction(
    new Transaction().add(
      ...[[dest.adj, markets.bonding.adjudicator], [dest.treasury, cfg.treasury]].map(
        ([addr, owner]) =>
          createAssociatedTokenAccountIdempotentInstruction(
            creator.publicKey,
            addr,
            owner,
            AMM_MINT,
          ),
      ),
    ),
    [creator],
  ),
  "confirmed",
);

const poolBefore = await balance(seeds.feePoolAmm);
const dBefore = {
  bBase: await balance(markets.bonding.vaultAmm),
  lp: (await balance(dest.lp)) ?? 0n,
  adj: (await balance(dest.adj)) ?? 0n,
  treasury: (await balance(dest.treasury)) ?? 0n,
};

try {
  const sig = await connection.sendTransaction(
    new Transaction().add(HEAP()).add(CU()).add(
      await asUser.methods
        .distributeFeesAmm()
        .accounts({
          config: seeds.config,
          market: BONDING,
          feePoolAuthority,
          venueMint: AMM_MINT,
          feePool: seeds.feePoolAmm,
          bBaseYieldVault: markets.bonding.vaultAmm,
          lpYieldAuthority,
          lpYieldVault: dest.lp,
          adjudicatorFeeVault: dest.adj,
          protocolTreasuryVault: dest.treasury,
          // Cranked by `user` — not the authority, creator or adjudicator.
          cranker: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ),
    [user],
  );
  await connection.confirmTransaction(sig, "confirmed");

  const moved = {
    bBase: (await balance(markets.bonding.vaultAmm)) - dBefore.bBase,
    lp: (await balance(dest.lp)) - dBefore.lp,
    adj: (await balance(dest.adj)) - dBefore.adj,
    treasury: (await balance(dest.treasury)) - dBefore.treasury,
  };
  const sum = moved.bBase + moved.lp + moved.adj + moved.treasury;

  check("a non-privileged cranker succeeded", true);
  check("pool fully drained", (await balance(seeds.feePoolAmm)) === 0n);
  check("parts sum to the whole", sum === poolBefore, `${sum} vs ${poolBefore}`);
  check(
    "b_base got its configured share",
    moved.bBase === (poolBefore * BigInt(cfg.bBaseShareBps)) / 10_000n,
    `${moved.bBase}`,
  );
  check(
    "lp got its configured share",
    moved.lp === (poolBefore * BigInt(cfg.lpYieldShareBps)) / 10_000n,
    `${moved.lp}`,
  );
  check(
    "adjudicator got its configured share",
    moved.adj === (poolBefore * BigInt(cfg.adjudicatorShareBps)) / 10_000n,
    `${moved.adj}`,
  );
} catch (e) {
  check("distribute_fees_amm succeeded", false, String(e.message ?? e).slice(0, 200));
}

// ── 5. A stranger cannot redirect the money ────────────────────────────────
console.log("\n[5] the same crank with a substituted destination is refused");
const thief = Keypair.generate();
const thiefAta = getAssociatedTokenAddressSync(AMM_MINT, thief.publicKey);
await connection.confirmTransaction(
  await connection.sendTransaction(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        creator.publicKey, thiefAta, thief.publicKey, AMM_MINT,
      ),
    ),
    [creator],
  ),
  "confirmed",
);

for (const [label, override] of [
  ["lp yield vault", { lpYieldVault: thiefAta }],
  ["adjudicator vault", { adjudicatorFeeVault: thiefAta }],
  ["treasury vault", { protocolTreasuryVault: thiefAta }],
  ["b_base vault", { bBaseYieldVault: thiefAta }],
]) {
  const base = {
    config: seeds.config,
    market: BONDING,
    feePoolAuthority,
    venueMint: AMM_MINT,
    feePool: seeds.feePoolAmm,
    bBaseYieldVault: markets.bonding.vaultAmm,
    lpYieldAuthority,
    lpYieldVault: dest.lp,
    adjudicatorFeeVault: dest.adj,
    protocolTreasuryVault: dest.treasury,
    cranker: user.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  try {
    const sig = await connection.sendTransaction(
      new Transaction().add(HEAP()).add(CU()).add(
        await asUser.methods.distributeFeesAmm().accounts({ ...base, ...override }).instruction(),
      ),
      [user],
    );
    await connection.confirmTransaction(sig, "confirmed");
    check(`substituted ${label} REFUSED`, false, "the transaction succeeded");
  } catch (e) {
    const msg = String(e.message ?? e);
    const code = msg.match(/custom program error: 0x([0-9a-f]+)/i);
    check(`substituted ${label} refused`, true, code ? `err ${parseInt(code[1], 16)}` : "rejected");
  }
}

// ── 6. The BOOK venue's distribution validates too ─────────────────────────
//
// Its pool is empty (the seeded ladder is all resting makers, no fills), so it
// cannot pay anything. But account validation runs BEFORE the handler's
// `require!(total > 0)`, so reaching `NothingToDistribute` proves the whole
// account set — including the treasury binding — is satisfiable on this venue.
// Anything in the 2000-range would mean it is not, which is exactly the state
// `address = config.treasury` left it in: the book's treasury account can only
// hold one mint, and it was not this one.
console.log("\n[6] distribute_fees_book's accounts are satisfiable");
{
  const feePoolBook = pda([Buffer.from("fee_pool_book"), Buffer.from(mid)]);
  const bookTreasury = getAssociatedTokenAddressSync(BOOK_MINT, cfg.treasury, true);
  const bookLp = pda([Buffer.from("lp_yield_book"), Buffer.from(mid)]);
  const bookAdj = getAssociatedTokenAddressSync(BOOK_MINT, markets.bonding.adjudicator, true);
  await connection.confirmTransaction(
    await connection.sendTransaction(
      new Transaction().add(
        ...[[bookTreasury, cfg.treasury], [bookAdj, markets.bonding.adjudicator]].map(
          ([addr, owner]) =>
            createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, addr, owner, BOOK_MINT),
        ),
      ),
      [creator],
    ),
    "confirmed",
  );
  check("book fee pool is empty as expected", (await balance(feePoolBook)) === 0n);
  try {
    await connection.sendTransaction(
      new Transaction().add(HEAP()).add(CU()).add(
        await asUser.methods
          .distributeFeesBook()
          .accounts({
            config: seeds.config,
            market: BONDING,
            feePoolAuthority,
            venueMint: BOOK_MINT,
            feePool: feePoolBook,
            lpMint: pda([Buffer.from("lp"), Buffer.from(mid)]),
            lpYieldAuthority,
            lpYieldVault: bookLp,
            adjudicatorFeeVault: bookAdj,
            protocolTreasuryVault: bookTreasury,
            cranker: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ),
      [user],
    );
    check("reached the handler (empty pool should have stopped it)", false, "unexpectedly succeeded");
  } catch (e) {
    const m = String(e.message ?? e).match(/custom program error: 0x([0-9a-f]+)/i);
    const code = m ? parseInt(m[1], 16) : -1;
    check(
      "accounts validate; stopped at NothingToDistribute",
      code === 6032,
      code === -1 ? String(e.message ?? e).slice(0, 120) : `err ${code}`,
    );
  }
}

console.log(`\n${failures === 0 ? "AUDIT PASSED" : `AUDIT FAILED — ${failures} check(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
