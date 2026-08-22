// Building a `ResolutionCommitment` — tape to tree to ceilings to a file a
// client can fetch a proof out of.
//
// The order of operations matters and is not arbitrary:
//
//   1. Replay the tape and compute entitlements (`tape.mjs`, `entitlements.mjs`).
//   2. CLAMP every entitlement against the account it will be checked against
//      on chain. The program enforces `valid_* <= held` and `refund <= cost`
//      per leaf; a tree that violates either is not merely wrong, it is
//      UNREDEEMABLE — the wallet's proof verifies and the payout still fails.
//      So the clamp is applied here, and where it bites it is reported,
//      because the only honest reason for it to bite is a tape that did not
//      reach far enough.
//   3. One leaf per ACCOUNT, not per tape entry. Once a commitment exists,
//      `redeem_amm_position` refuses a `None` claim — so a position with no
//      leaf can never redeem. Every position and every seat gets a leaf, even
//      an all-zero one.
//   4. Sum the leaves into the two per-venue ceilings the publish instruction
//      checks the vaults against.

import {
  computeAmmEntitlements,
  computeBookEntitlements,
  orderLeaves,
} from "./entitlements.mjs";
import { ammLeaf, bookLeaf, buildTree, hex, verifyProof } from "./merkle.mjs";
import { readVoidTape } from "./tape.mjs";

const abs = (v) => (v < 0n ? -v : v);
const min = (a, b) => (a < b ? a : b);
const big = (v) => BigInt(v.toString());

/** The accounting convention this tree was built under, stamped into the artifact. */
export const CONVENTION = "sooth-tstar/fifo-v1";

/**
 * Everything a `--void` run produces, computed and checked but not submitted.
 *
 * Separated from publication so `--plan` and a real publish run exactly the
 * same computation and a human can inspect the table before anything signs.
 */
export async function buildCommitment({
  chain,
  marketPk,
  tStar,
  tStarSource,
  maxSignatures = 20_000,
  onProgress = null,
  // Injectable so the accounting above the replay is testable without a
  // validator. Production always leaves this null and reads the chain.
  tape: providedTape = null,
}) {
  const anomalies = [];
  const refs = await chain.readMarketAccount(marketPk);

  if (!(tStar > refs.startTime)) {
    throw new Error(
      `T* ${tStar} is not after the market's start_time ${refs.startTime} — ` +
        `the program refuses it (InvalidTStar), and it would void every trade the market saw`,
    );
  }

  const tape =
    providedTape ??
    (await readVoidTape({
      connection: chain.connection,
      program: chain.program,
      marketPk,
      bookPk: refs.book,
      maxSignatures,
      onProgress,
    }));
  anomalies.push(...tape.anomalies);

  const amm = computeAmmEntitlements({ trades: tape.ammTrades, tStar });
  const book = computeBookEntitlements({ legs: tape.bookLegs, tStar });
  anomalies.push(...amm.anomalies, ...book.anomalies);

  // ── AMM leaves, one per position ─────────────────────────────────────────
  const tapeWallets = [...new Set(tape.ammTrades.map((t) => t.wallet))];
  const positionRead = await chain.readPositions(marketPk, {
    marketId: refs.marketId,
    wallets: tapeWallets,
  });
  if (positionRead.source !== "getProgramAccounts") {
    anomalies.push(
      `position set came from the TAPE, not from getProgramAccounts ` +
        `(${positionRead.reason}) — a wallet the tape missed has no leaf and cannot redeem. ` +
        `Publish from an endpoint that serves getProgramAccounts if you can.`,
    );
  }
  const positions = positionRead.positions;
  const ammRows = [];
  for (const p of positions) {
    const wallet = p.account.user.toBase58();
    const heldYes = big(p.account.yesShares ?? p.account.yes_shares);
    const heldNo = big(p.account.noShares ?? p.account.no_shares);
    const lockedCost = big(p.account.lockedCostUsdc ?? p.account.locked_cost_usdc);
    const e = amm.entitlements.get(wallet);

    const rawYes = e?.validYesWad ?? 0n;
    const rawNo = e?.validNoWad ?? 0n;
    const rawRefund = e?.refundUsdc ?? 0n;
    const validYes = min(rawYes, heldYes < 0n ? 0n : heldYes);
    const validNo = min(rawNo, heldNo < 0n ? 0n : heldNo);
    const refund = min(rawRefund, lockedCost);

    if (validYes !== rawYes || validNo !== rawNo || refund !== rawRefund) {
      anomalies.push(
        `${wallet}: AMM entitlement clamped to the position ` +
          `(yes ${rawYes}->${validYes}, no ${rawNo}->${validNo}, refund ${rawRefund}->${refund}) — ` +
          `the replay disagrees with the account, so the tape is probably incomplete`,
      );
    }
    if (!e && (heldYes > 0n || heldNo > 0n)) {
      anomalies.push(
        `${wallet}: holds AMM shares but appears nowhere in the tape — leafed at zero, ` +
          `which pays it NOTHING. Check the walk depth before publishing.`,
      );
    }

    ammRows.push({
      kind: "amm",
      wallet,
      userBytes: p.account.user.toBuffer(),
      validYesWad: validYes,
      validNoWad: validNo,
      voidRefundUsdc: refund,
      heldYesWad: heldYes,
      heldNoWad: heldNo,
      lockedCostUsdc: lockedCost,
      voidedYesWad: e?.voidedYesWad ?? 0n,
      voidedNoWad: e?.voidedNoWad ?? 0n,
    });
  }

  // ── Book leaves, one per seat ────────────────────────────────────────────
  const seats = (await chain.readBookSeats(refs.book)) ?? [];
  const bookRows = [];
  for (const seat of seats) {
    const wallet = seat.trader;
    const net = big(seat.net);
    const e = book.entitlements.get(wallet);
    let validNet = e?.validNet ?? 0n;

    // Same side, no larger — `assert_book_claim_within_seat`, mirrored.
    if (validNet !== 0n && (validNet > 0n) !== (net > 0n)) validNet = 0n;
    if (abs(validNet) > abs(net)) validNet = net > 0n ? abs(net) : -abs(net);

    const voided = abs(net) - abs(validNet);
    const rawRefund = e?.refundUsdc ?? 0n;
    const refund = min(rawRefund, voided);
    if (validNet !== (e?.validNet ?? 0n) || refund !== rawRefund) {
      anomalies.push(
        `${wallet}: book entitlement clamped to the seat ` +
          `(net ${e?.validNet ?? 0n}->${validNet}, refund ${rawRefund}->${refund})`,
      );
    }

    bookRows.push({
      kind: "book",
      wallet,
      userBytes: Buffer.from(bs58ToBytes(wallet)),
      validNet,
      bookVoidRefundUsdc: refund,
      heldNet: net,
      credit: big(seat.credit),
      voidedShares: voided,
    });
  }

  // ── The tree ─────────────────────────────────────────────────────────────
  const ordered = orderLeaves([...ammRows, ...bookRows]);
  if (ordered.length === 0) {
    throw new Error(
      "no positions and no seats on this market — there is nothing to commit to, " +
        "and the program refuses leaf_count 0 (EmptyCommitment)",
    );
  }

  for (const row of ordered) {
    row.leaf =
      row.kind === "amm"
        ? ammLeaf(marketPk, row.userBytes, row.validYesWad, row.validNoWad, row.voidRefundUsdc)
        : bookLeaf(marketPk, row.userBytes, row.validNet, row.bookVoidRefundUsdc);
  }
  const { root, proofs } = buildTree(ordered.map((r) => r.leaf));
  ordered.forEach((row, i) => {
    row.index = i;
    row.proof = proofs[i];
    // Cheap, and it catches a tree-shape bug here rather than at redemption,
    // where it would look like the wallet's fault.
    if (!verifyProof(row.leaf, row.proof, root)) {
      throw new Error(`internal: leaf ${i} (${row.wallet}) does not verify against its own root`);
    }
  });

  const totalVoidRefundUsdc = ammRows.reduce((s, r) => s + r.voidRefundUsdc, 0n);
  const totalBookVoidRefundUsdc = bookRows.reduce((s, r) => s + r.bookVoidRefundUsdc, 0n);

  return {
    market: marketPk.toBase58(),
    programId: chain.programId.toBase58(),
    convention: CONVENTION,
    tStar,
    tStarSource,
    root,
    leafCount: ordered.length,
    totalVoidRefundUsdc,
    totalBookVoidRefundUsdc,
    rows: ordered,
    ammRows,
    bookRows,
    refs,
    tape,
    anomalies,
  };
}

/**
 * The per-wallet artifact a client fetches a proof out of.
 *
 * `byWallet` is the index a UI actually uses: one lookup by base58 address
 * gives the leaf values and the sibling list, which is exactly the argument
 * shape `redeem_amm_position` / `redeem_book_seat` take. `leaves` keeps the
 * ORDERED list beside it, because the tree's shape depends on that order and
 * a third party reproducing the root needs it.
 */
export function proofArtifact(plan) {
  const byWallet = {};
  const leaves = plan.rows.map((row) => {
    const common = {
      index: row.index,
      venue: row.kind,
      wallet: row.wallet,
      leaf: hex(row.leaf),
      proof: row.proof.map(hex),
    };
    const entry =
      row.kind === "amm"
        ? {
            ...common,
            validYesWad: row.validYesWad.toString(),
            validNoWad: row.validNoWad.toString(),
            voidRefundUsdc: row.voidRefundUsdc.toString(),
          }
        : {
            ...common,
            validNet: row.validNet.toString(),
            bookVoidRefundUsdc: row.bookVoidRefundUsdc.toString(),
          };
    byWallet[row.wallet] ??= {};
    byWallet[row.wallet][row.kind] = entry;
    return entry;
  });

  return {
    version: 1,
    market: plan.market,
    programId: plan.programId,
    convention: plan.convention,
    tStar: plan.tStar,
    tStarSource: plan.tStarSource,
    merkleRoot: hex(plan.root),
    leafCount: plan.leafCount,
    totalVoidRefundUsdc: plan.totalVoidRefundUsdc.toString(),
    totalBookVoidRefundUsdc: plan.totalBookVoidRefundUsdc.toString(),
    generatedAt: Math.floor(Date.now() / 1000),
    sourceTape: {
      signatures: plan.tape.signatureCount,
      ammTrades: plan.tape.ammTrades.length,
      bookLegs: plan.tape.bookLegs.length,
    },
    anomalies: plan.anomalies,
    leaves,
    byWallet,
  };
}

/** The table `--plan` prints. Fixed width, no colour, no emoji. */
export function renderTable(plan) {
  const lines = [];
  const wad = (v) => (Number(v) / 1e18).toFixed(4);
  const usdc = (v) => (Number(v) / 1e6).toFixed(6);

  lines.push(`market            ${plan.market}`);
  lines.push(`T*                ${plan.tStar} (${new Date(plan.tStar * 1000).toISOString()}) via ${plan.tStarSource}`);
  lines.push(`convention        ${plan.convention}`);
  lines.push(`merkle root       ${hex(plan.root)}`);
  lines.push(`leaf count        ${plan.leafCount}`);
  lines.push(`AMM  refund total ${usdc(plan.totalVoidRefundUsdc)} USDC`);
  lines.push(`book refund total ${usdc(plan.totalBookVoidRefundUsdc)} USDC`);
  lines.push(
    `tape              ${plan.tape.signatureCount} signatures, ` +
      `${plan.tape.ammTrades.length} AMM trades, ${plan.tape.bookLegs.length} book legs`,
  );
  lines.push("");

  if (plan.ammRows.length > 0) {
    lines.push("AMM leaves (shares in WAD, refund in USDC)");
    lines.push(
      "  idx wallet                                       held yes  valid yes   held no   valid no      refund",
    );
    for (const r of plan.ammRows) {
      lines.push(
        `  ${String(r.index).padStart(3)} ${r.wallet.padEnd(44)} ` +
          `${wad(r.heldYesWad).padStart(9)} ${wad(r.validYesWad).padStart(10)} ` +
          `${wad(r.heldNoWad).padStart(9)} ${wad(r.validNoWad).padStart(10)} ` +
          `${usdc(r.voidRefundUsdc).padStart(11)}`,
      );
    }
    lines.push("");
  }

  if (plan.bookRows.length > 0) {
    lines.push("BOOK leaves (net in shares, refund in USDC)");
    lines.push("  idx wallet                                        held net   valid net      refund");
    for (const r of plan.bookRows) {
      lines.push(
        `  ${String(r.index).padStart(3)} ${r.wallet.padEnd(44)} ` +
          `${usdc(r.heldNet).padStart(11)} ${usdc(r.validNet).padStart(11)} ` +
          `${usdc(r.bookVoidRefundUsdc).padStart(11)}`,
      );
    }
    lines.push("");
  }

  if (plan.anomalies.length > 0) {
    lines.push("ANOMALIES — read these before publishing:");
    for (const a of plan.anomalies) lines.push(`  - ${a}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Local base58, so this module needs nothing from `config.mjs`.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58ToBytes(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = B58.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base58 character ${JSON.stringify(ch)}`);
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
