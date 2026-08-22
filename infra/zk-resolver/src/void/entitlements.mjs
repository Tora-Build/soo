// Per-wallet entitlements from a replayed trade tape.
//
// Pure: in, a normalized tape and a T*; out, one entitlement record per
// wallet. No chain access, no I/O — so the accounting convention that decides
// real money is unit-testable without a validator, which is the whole reason
// it lives apart from `tape.mjs`.
//
// ## The convention, stated exactly (this is what a disputer reproduces)
//
// **Lots.** Every acquisition is a LOT carrying `{shares, cost, ts}`. `ts` is
// the acquisition's own timestamp, never the timestamp of anything that
// happens to it later.
//
// **Sells retire the EARLIEST lots first (FIFO).** This is the convention
// `docs/design/t-star-voiding.md` states ("FIFO over acquisitions, sells
// retiring the earliest lots first"), and it settles the one thing the design
// doc left open — whether a sale after T* returns shares to the pre-T* pool.
// It does NOT. A sell consumes lots in acquisition order regardless of when
// the sell happened, so a wallet that bought pre-T*, bought again post-T*, and
// then sold, is left holding its POST-T* lots. Nothing is reclassified: a lot's
// ts is fixed at acquisition and a sell only removes shares.
//
// The alternative — retire post-T* lots first, so a post-T* round trip leaves
// the honest pre-T* holding intact — was rejected because it hands the
// informed trader a free unwind: buy after T*, sell after T*, keep the
// pre-T* settlement AND the proceeds. FIFO is the rule that cannot be gamed
// by adding trades, which matters more here than being kind to the wallet
// that traded on both sides of the line.
//
// **Entitlement.** Of the lots still held at the end of the tape:
//   - `ts <= T*`  ->  settle normally  (`valid_yes_wad` / `valid_no_wad`, or
//                     the book's signed `valid_net`)
//   - `ts >  T*`  ->  voided: they pay nothing, and their COST comes back
//                     instead (`void_refund_usdc`)
//
// **Partial lots.** A sell that eats part of a lot removes shares and cost
// pro rata, floored, so the surviving cost basis is never overstated.
//
// **What this does not reach.** Proceeds of a post-T* SELL are already out of
// the position — in a `LockEntry` on the AMM, in the seat's `credit` on the
// book — and no leaf can claw them back. That is gap (1) in the design doc,
// unchanged by anything here.

/** USDC base units per WAD unit of cost. */
export const WAD_PER_USDC = 10n ** 12n;

const abs = (v) => (v < 0n ? -v : v);

/**
 * A FIFO queue of same-signed lots.
 *
 * `push` opens exposure; `retire` closes it oldest-first, returning what it
 * could not find (which should always be zero on a well-formed tape, and is
 * surfaced rather than swallowed when it is not).
 */
class Lots {
  constructor() {
    this.queue = [];
  }

  push(shares, cost, ts) {
    if (shares <= 0n) return;
    this.queue.push({ shares, cost: cost < 0n ? 0n : cost, ts });
  }

  /** Remove `shares` from the front. Returns the shortfall (0 when satisfied). */
  retire(shares) {
    let left = shares;
    while (left > 0n && this.queue.length > 0) {
      const lot = this.queue[0];
      if (lot.shares <= left) {
        left -= lot.shares;
        this.queue.shift();
        continue;
      }
      // Partial: shares and cost both shrink, cost floored so the surviving
      // basis is never larger than the fraction actually still held.
      const remaining = lot.shares - left;
      lot.cost = (lot.cost * remaining) / lot.shares;
      lot.shares = remaining;
      left = 0n;
    }
    return left;
  }

  get total() {
    return this.queue.reduce((s, l) => s + l.shares, 0n);
  }

  /** `{valid, voided, voidedCost}` against a T*. */
  split(tStar) {
    let valid = 0n;
    let voided = 0n;
    let voidedCost = 0n;
    for (const lot of this.queue) {
      if (lot.ts <= tStar) {
        valid += lot.shares;
      } else {
        voided += lot.shares;
        voidedCost += lot.cost;
      }
    }
    return { valid, voided, voidedCost };
  }
}

/**
 * AMM entitlements.
 *
 * `trades` are in CHAIN order (not sorted by ts — the chain's order is the
 * order the position actually moved through), each:
 *
 *     { wallet, outcome: 0|1, deltaSharesWad: bigint signed, costWad: bigint signed, ts }
 *
 * A buy has `deltaSharesWad > 0` and `costWad > 0`; a sell has both negative
 * (`tape.mjs` normalizes `PositionSold` into that shape). The two sides are
 * accounted separately — they are separate share balances on chain — but the
 * refund is ONE number per wallet, because the leaf carries one.
 */
export function computeAmmEntitlements({ trades, tStar }) {
  const books = new Map(); // wallet -> { 0: Lots, 1: Lots }
  const anomalies = [];

  const lotsFor = (wallet, outcome) => {
    let entry = books.get(wallet);
    if (!entry) {
      entry = { 0: new Lots(), 1: new Lots() };
      books.set(wallet, entry);
    }
    return entry[outcome];
  };

  for (const t of trades) {
    if (t.outcome !== 0 && t.outcome !== 1) {
      anomalies.push(`${t.wallet}: unknown outcome ${t.outcome} at ts ${t.ts}, ignored`);
      continue;
    }
    const lots = lotsFor(t.wallet, t.outcome);
    if (t.deltaSharesWad > 0n) {
      lots.push(t.deltaSharesWad, abs(t.costWad), t.ts);
    } else if (t.deltaSharesWad < 0n) {
      const shortfall = lots.retire(-t.deltaSharesWad);
      if (shortfall > 0n) {
        // The tape is incomplete — almost always a truncated signature walk.
        // Reported, never papered over: an entitlement computed from a partial
        // tape is not the entitlement.
        anomalies.push(
          `${t.wallet}: sold ${-t.deltaSharesWad} of outcome ${t.outcome} at ts ${t.ts} ` +
            `but the tape only accounts for ${-t.deltaSharesWad - shortfall} — tape is incomplete`,
        );
      }
    }
  }

  const out = new Map();
  for (const [wallet, sides] of books) {
    const yes = sides[1].split(tStar);
    const no = sides[0].split(tStar);
    const refundWad = yes.voidedCost + no.voidedCost;
    out.set(wallet, {
      wallet,
      validYesWad: yes.valid,
      validNoWad: no.valid,
      voidedYesWad: yes.voided,
      voidedNoWad: no.voided,
      heldYesWad: sides[1].total,
      heldNoWad: sides[0].total,
      refundWad,
      // Floor: the position paid `wad_to_usdc_ceil` per trade, so flooring the
      // sum can only ever under-refund, which is the safe direction against
      // `void_refund_usdc <= position.locked_cost_usdc`.
      refundUsdc: refundWad / WAD_PER_USDC,
    });
  }
  return { entitlements: out, anomalies };
}

/**
 * Book entitlements.
 *
 * `legs` are in CHAIN order, one per party per fill:
 *
 *     { wallet, deltaShares: bigint signed base units, costUsdc: bigint >= 0, ts }
 *
 * `deltaShares > 0` is long YES, `< 0` is long NO — the book's single signed
 * axis (`book/settlement.rs`). A leg that CLOSES existing exposure consumes
 * lots from the other side first and only the remainder opens a new lot, which
 * is `split_delta` mirrored: a seat holds one signed net, so its lots are
 * always same-signed.
 *
 * `costUsdc` covers the whole leg; the opening portion inherits it pro rata,
 * floored — so a voided lot's refund is always at most `ticks/1000 < 1` per
 * share, which is exactly the ceiling `assert_book_claim_within_seat` enforces.
 */
export function computeBookEntitlements({ legs, tStar }) {
  const books = new Map(); // wallet -> { sign, lots: Lots }
  const anomalies = [];

  for (const leg of legs) {
    if (leg.deltaShares === 0n) continue;
    let seat = books.get(leg.wallet);
    if (!seat) {
      seat = { sign: 0, lots: new Lots() };
      books.set(leg.wallet, seat);
    }
    const magnitude = abs(leg.deltaShares);
    const sign = leg.deltaShares > 0n ? 1 : -1;

    let opening = magnitude;
    if (seat.sign !== 0 && seat.sign !== sign) {
      const held = seat.lots.total;
      const closing = held < magnitude ? held : magnitude;
      seat.lots.retire(closing);
      opening = magnitude - closing;
      if (seat.lots.total === 0n) seat.sign = 0;
    }
    if (opening > 0n) {
      if (seat.sign === 0) seat.sign = sign;
      seat.lots.push(
        opening,
        (leg.costUsdc * opening) / magnitude,
        leg.ts,
      );
    }
  }

  const out = new Map();
  for (const [wallet, seat] of books) {
    const { valid, voided, voidedCost } = seat.lots.split(tStar);
    const sign = BigInt(seat.sign);
    out.set(wallet, {
      wallet,
      validNet: sign * valid,
      voidedShares: voided,
      heldNet: sign * seat.lots.total,
      refundUsdc: voidedCost,
    });
  }
  return { entitlements: out, anomalies };
}

/**
 * `leg_costs` from `book/settlement.rs`, mirrored exactly.
 *
 * The MAKER's leg floors and the TAKER's takes the remainder, so the two sum
 * to `amount` and the vault's "1.00 per unit of open interest" invariant does
 * not bleed a base unit per fill. Returns `{ bidCost, askCost }`.
 */
export function legCosts(priceTick, amount, takerSide) {
  const tick = BigInt(priceTick);
  if (tick <= 0n || tick >= 1000n) throw new Error(`invalid price tick ${priceTick}`);
  const takerIsBid = takerSide === 0;
  const makerTicks = takerIsBid ? 1000n - tick : tick;
  const makerCost = (amount * makerTicks) / 1000n;
  const takerCost = amount - makerCost;
  return takerIsBid
    ? { bidCost: takerCost, askCost: makerCost }
    : { bidCost: makerCost, askCost: takerCost };
}

/**
 * A deterministic leaf ORDER, so the tree is reproducible byte for byte.
 *
 * AMM leaves first, then book leaves, each sorted by the user's raw pubkey
 * bytes ascending. Any total order would do; what matters is that it is
 * stated, mechanical, and independent of the tape's order (which depends on
 * how deep a walk the reproducer ran).
 */
export function orderLeaves(records) {
  const rank = { amm: 0, book: 1 };
  return [...records].sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return Buffer.compare(a.userBytes, b.userBytes);
  });
}
