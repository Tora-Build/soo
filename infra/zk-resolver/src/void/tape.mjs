// The trade tape, replayed from chain events.
//
// The chain stores aggregates — `Position.yes_shares`, a seat's signed `net` —
// and no per-trade history at all. What it DOES have is the event log, and
// every acquisition on either venue is in it with a wallet, an amount and a
// timestamp. That is the whole basis of T* voiding: the resolver computes from
// public events, the chain verifies a commitment to the computation, and any
// observer can replay the same walk and check it.
//
// Three event shapes carry an acquisition:
//
//   `PositionTraded`  AMM buy/sell. Signed `delta_shares` and `cost_wad`, and
//                     its own `ts`.
//   `PositionSold`    AMM sell. No `ts` field — but `unlock_at` was written as
//                     `now + LOCK_DURATION_SECS` at exactly one site
//                     (`sell_positions.rs`), so the sell's moment is recovered
//                     exactly, the same derivation `LockEntry::sold_at()` uses.
//   `BookFilled`      one book match. Rides an `emit_cpi!` inner instruction
//                     rather than a log, carries `taker_side` and per fill the
//                     maker, tick and amount. Both parties are derived from it.
//
// Cost per party per book fill comes from `legCosts`, which mirrors
// `book/settlement.rs::leg_costs` including which side absorbs the rounding
// remainder — get that wrong and the refund ceiling is off by a base unit per
// fill in a direction the program will reject.

import { legCosts } from "./entitlements.mjs";

/** `sell_positions.rs::LOCK_DURATION_SECS`. */
export const LOCK_DURATION_SECS = 24 * 60 * 60;

/** Signatures per `getSignaturesForAddress` page; 1000 is the RPC's maximum. */
const PAGE = 1000;

const toBig = (v) => BigInt(v.toString());
const abs = (v) => (v < 0n ? -v : v);

/**
 * Every signature that touched `address`, oldest last, paged to exhaustion.
 *
 * Paged rather than capped at one call because a partial tape produces a wrong
 * tree, silently. `maxSignatures` is a safety valve, and hitting it is
 * reported as an anomaly rather than treated as the end of history.
 */
async function allSignatures(connection, address, maxSignatures) {
  const out = [];
  let before;
  for (;;) {
    const page = await connection.getSignaturesForAddress(address, {
      limit: PAGE,
      ...(before ? { before } : {}),
    });
    if (page.length === 0) break;
    out.push(...page);
    if (page.length < PAGE) break;
    before = page[page.length - 1].signature;
    if (out.length >= maxSignatures) break;
  }
  return out;
}

/**
 * Replay one market's acquisitions.
 *
 * Walks the market PDA and the book PDA — every AMM instruction touches the
 * former and every book match the latter, and a match touches both, so the two
 * lists are unioned by signature and each transaction is fetched once.
 *
 * Returns normalized tapes in CHAIN order (oldest first), which is the order
 * the positions actually moved through. Timestamps decide validity; order
 * decides which lots a sell retires, and those are different questions.
 */
export async function readVoidTape({
  connection,
  program,
  marketPk,
  bookPk = null,
  maxSignatures = 20_000,
  onProgress = null,
}) {
  const anomalies = [];
  const coder = program.coder;
  const marketBase58 = marketPk.toBase58();

  const sigLists = [await allSignatures(connection, marketPk, maxSignatures)];
  if (bookPk) sigLists.push(await allSignatures(connection, bookPk, maxSignatures));

  const seen = new Map();
  for (const list of sigLists) {
    for (const s of list) if (!seen.has(s.signature)) seen.set(s.signature, s);
  }
  const sigs = [...seen.values()].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  if (sigs.length >= maxSignatures) {
    anomalies.push(
      `signature walk hit the ${maxSignatures} cap — the tape may be incomplete, ` +
        `raise --max-signatures before trusting this tree`,
    );
  }

  const ammTrades = [];
  const bookLegs = [];
  let scanned = 0;

  for (const sig of sigs) {
    if (sig.err) continue; // a failed transaction moved nothing
    const tx = await connection.getTransaction(sig.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    scanned += 1;
    if (onProgress && scanned % 25 === 0) onProgress(scanned, sigs.length);
    if (!tx?.meta) continue;
    const blockTs = tx.blockTime ?? 0;

    // ── AMM: `emit!`, so the payload is a `Program data:` log line ──────────
    for (const line of tx.meta.logMessages ?? []) {
      const m = line.match(/^Program data: (.+)$/);
      if (!m) continue;
      let decoded = null;
      try {
        decoded = coder.events.decode(m[1]);
      } catch {
        continue; // not one of ours, or an older shape
      }
      if (!decoded) continue;

      if (/^positionTraded$/i.test(decoded.name)) {
        const d = decoded.data;
        if (d.market.toBase58() !== marketBase58) continue;
        const delta = toBig(d.deltaShares);
        if (delta === 0n) continue;
        ammTrades.push({
          wallet: d.user.toBase58(),
          outcome: Number(d.outcome),
          deltaSharesWad: delta,
          costWad: abs(toBig(d.costWad)),
          ts: Number(toBig(d.ts)) || blockTs,
          signature: sig.signature,
          kind: delta > 0n ? "buy" : "sell",
        });
      } else if (/^positionSold$/i.test(decoded.name)) {
        const d = decoded.data;
        if (d.market.toBase58() !== marketBase58) continue;
        const shares = toBig(d.sharesSold);
        if (shares === 0n) continue;
        // `unlock_at - LOCK_DURATION_SECS` recovers the sell's moment exactly.
        // The event carries no `ts` of its own and `blockTime` is the fallback
        // only when the derivation is impossible.
        const unlockAt = d.unlockAt == null ? null : Number(toBig(d.unlockAt));
        ammTrades.push({
          wallet: d.user.toBase58(),
          outcome: Number(d.outcome),
          deltaSharesWad: -shares,
          // Proceeds, not cost — a sell removes lots and their basis with
          // them, so this number is informational for the printed table only.
          costWad: toBig(d.amountUsdc) * 10n ** 12n,
          ts: unlockAt == null ? blockTs : unlockAt - LOCK_DURATION_SECS,
          signature: sig.signature,
          kind: "sell",
        });
      }
    }

    // ── Book: `emit_cpi!`, so the payload is an inner instruction ──────────
    if (tx.meta.innerInstructions?.length) {
      const inner = tx.meta.innerInstructions.flatMap((group) =>
        group.instructions.map((ix) => decodeBs58(ix.data)),
      );
      let events = [];
      try {
        events = decodeBookEvents(inner);
      } catch (err) {
        anomalies.push(`${sig.signature}: book event decode failed — ${err.message}`);
      }
      for (const event of events) {
        if (event.kind !== "filled") continue;
        if (event.market !== marketBase58) continue;
        const ts = Number(event.ts) || blockTs;
        for (const fill of event.fills) {
          const { bidCost, askCost } = legCosts(fill.priceTick, fill.amount, event.takerSide);
          const takerIsBid = event.takerSide === 0;
          // The book's single signed axis: bid = long YES (+), ask = long NO (-).
          bookLegs.push({
            wallet: event.taker,
            role: "taker",
            deltaShares: takerIsBid ? fill.amount : -fill.amount,
            costUsdc: takerIsBid ? bidCost : askCost,
            priceTick: fill.priceTick,
            ts,
            signature: sig.signature,
          });
          bookLegs.push({
            wallet: fill.maker,
            role: "maker",
            deltaShares: takerIsBid ? -fill.amount : fill.amount,
            costUsdc: takerIsBid ? askCost : bidCost,
            priceTick: fill.priceTick,
            ts,
            signature: sig.signature,
          });
        }
      }
    }
  }

  return {
    ammTrades,
    bookLegs,
    anomalies,
    signatureCount: sigs.length,
    scanned,
  };
}

// The two SDK helpers are injected at module init rather than imported at the
// top, because `chain.mjs` is what resolves the SDK's built `dist/` and this
// module must stay importable (and unit-testable) without it.
let decodeBookEvents = () => [];
let decodeBs58 = () => Buffer.alloc(0);

export function installBookDecoders({ decodeBookEventsFromInner, bs58Decode }) {
  decodeBookEvents = decodeBookEventsFromInner;
  decodeBs58 = bs58Decode;
}

/**
 * T\* for a zkTLS market: the Primus attestation's own signed `timestamp`.
 *
 * `attest_outcome_zk` does not PERSIST it — `AdjudicatorEntry` has one reserved
 * byte left — but it emits it, normalized to unix seconds, as
 * `ZkOutcomeAttested.attestation_ts`. That log is public, so a T\* taken from
 * it is checkable by the same disputer who checks the tree.
 *
 * It is the moment the ATTESTOR LOOKED, not the moment the event occurred, so
 * it is an upper bound on the true T\* — conservative in the safe direction:
 * it voids less than a perfectly-chosen T\* would, never more.
 *
 * `null` when the market was attested manually, which is the signal for the
 * operator to supply T\* themselves.
 */
export async function readZkAttestationTs({ connection, program, marketPk, limit = 200 }) {
  const marketBase58 = marketPk.toBase58();
  const sigs = await connection.getSignaturesForAddress(marketPk, { limit });
  // Newest first: the attestation is near the end of a market's life.
  for (const sig of sigs) {
    if (sig.err) continue;
    const tx = await connection.getTransaction(sig.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx?.meta) continue;
    for (const line of tx.meta.logMessages ?? []) {
      const m = line.match(/^Program data: (.+)$/);
      if (!m) continue;
      let decoded = null;
      try {
        decoded = program.coder.events.decode(m[1]);
      } catch {
        continue;
      }
      if (!decoded || !/^zkOutcomeAttested$/i.test(decoded.name)) continue;
      if (decoded.data.market.toBase58() !== marketBase58) continue;
      return {
        tStar: Number(decoded.data.attestationTs.toString()),
        signature: sig.signature,
        winningOutcome: Number(decoded.data.winningOutcome),
      };
    }
  }
  return null;
}
