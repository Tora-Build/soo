// The accounting convention, which is the part that decides real money.
//
// The chain bounds a wrong tree (a leaf can never pay more shares than the
// position holds, nor more cash than it paid in) but it cannot tell a wrong
// tree from a right one — it does not know the event tape. What makes the
// resolver accountable rather than trusted is that this function is stated,
// deterministic and reproducible from public events. These tests are the
// statement.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeAmmEntitlements,
  computeBookEntitlements,
  legCosts,
  orderLeaves,
} from "../src/void/entitlements.mjs";

const WAD = 10n ** 18n;
const T_STAR = 1_000;
const YES = 1;
const NO = 0;

const buy = (wallet, outcome, shares, costUsdc, ts) => ({
  wallet,
  outcome,
  deltaSharesWad: shares * WAD,
  costWad: costUsdc * 10n ** 12n,
  ts,
});
const sell = (wallet, outcome, shares, ts) => ({
  wallet,
  outcome,
  deltaSharesWad: -shares * WAD,
  costWad: 0n,
  ts,
});

const amm = (trades) => computeAmmEntitlements({ trades, tStar: T_STAR }).entitlements;

// ── AMM ─────────────────────────────────────────────────────────────────────

test("a wallet with only pre-T* trades settles in full and is refunded nothing", () => {
  const e = amm([buy("alice", YES, 10n, 4_000_000n, T_STAR - 100)]).get("alice");
  assert.equal(e.validYesWad, 10n * WAD);
  assert.equal(e.validNoWad, 0n);
  assert.equal(e.refundUsdc, 0n);
  assert.equal(e.voidedYesWad, 0n);
});

test("a trade exactly AT T* is honest — the boundary is inclusive", () => {
  // `t <= T*` settles: T* is the moment the answer became public, and a trade
  // stamped at that second is not yet a trade on public knowledge.
  const e = amm([buy("alice", YES, 5n, 2_000_000n, T_STAR)]).get("alice");
  assert.equal(e.validYesWad, 5n * WAD);
  assert.equal(e.refundUsdc, 0n);
});

test("a wallet with only post-T* trades settles nothing and is refunded in full", () => {
  const e = amm([buy("bob", YES, 10n, 9_500_000n, T_STAR + 1)]).get("bob");
  assert.equal(e.validYesWad, 0n);
  assert.equal(e.voidedYesWad, 10n * WAD);
  assert.equal(e.refundUsdc, 9_500_000n);
});

test("a mixed wallet splits at T*, and only the post-T* lot's cost comes back", () => {
  const e = amm([
    buy("carol", YES, 4n, 1_200_000n, T_STAR - 500),
    buy("carol", YES, 6n, 5_700_000n, T_STAR + 500),
  ]).get("carol");
  assert.equal(e.validYesWad, 4n * WAD);
  assert.equal(e.voidedYesWad, 6n * WAD);
  assert.equal(e.refundUsdc, 5_700_000n);
});

test("the two outcomes are accounted separately but share one refund number", () => {
  // The leaf carries `valid_yes_wad`, `valid_no_wad` and ONE `void_refund_usdc`.
  const e = amm([
    buy("dave", YES, 3n, 900_000n, T_STAR - 10),
    buy("dave", NO, 2n, 800_000n, T_STAR - 10),
    buy("dave", YES, 1n, 950_000n, T_STAR + 10),
    buy("dave", NO, 4n, 200_000n, T_STAR + 10),
  ]).get("dave");
  assert.equal(e.validYesWad, 3n * WAD);
  assert.equal(e.validNoWad, 2n * WAD);
  assert.equal(e.refundUsdc, 950_000n + 200_000n);
});

test("a sell retires the EARLIEST lots first, even when the sell is post-T*", () => {
  // The convention, and the case the design doc left open. A post-T* sale does
  // NOT return shares to the pre-T* pool: lots are consumed in acquisition
  // order, so what survives a round trip is the post-T* holding.
  const e = amm([
    buy("eve", YES, 10n, 3_000_000n, T_STAR - 100),
    buy("eve", YES, 5n, 4_800_000n, T_STAR + 100),
    sell("eve", YES, 10n, T_STAR + 200),
  ]).get("eve");
  assert.equal(e.validYesWad, 0n, "the pre-T* lot was the one retired");
  assert.equal(e.voidedYesWad, 5n * WAD);
  assert.equal(e.refundUsdc, 4_800_000n);
});

test("the alternative — refunding AND settling the same round trip — is what FIFO refuses", () => {
  // Retiring post-T* lots first would leave the informed wallet its pre-T*
  // settlement AND the sale proceeds: a free unwind. FIFO cannot be gamed by
  // adding trades, which is the property that matters.
  const e = amm([
    buy("mallory", YES, 8n, 2_400_000n, T_STAR - 100),
    buy("mallory", YES, 8n, 7_800_000n, T_STAR + 100),
    sell("mallory", YES, 8n, T_STAR + 150),
  ]).get("mallory");
  assert.equal(e.validYesWad, 0n);
  assert.equal(e.refundUsdc, 7_800_000n);
});

test("a partial sell shrinks the surviving lot's cost basis pro rata, floored", () => {
  const e = amm([
    buy("frank", YES, 10n, 10_000_001n, T_STAR + 10),
    sell("frank", YES, 3n, T_STAR + 20),
  ]).get("frank");
  assert.equal(e.voidedYesWad, 7n * WAD);
  // 10_000_001 * 7 / 10, floored, in WAD then floored again into USDC.
  assert.equal(e.refundUsdc, 7_000_000n);
});

test("a wallet that sold everything is owed nothing and refunded nothing", () => {
  const e = amm([
    buy("grace", YES, 5n, 5_000_000n, T_STAR + 10),
    sell("grace", YES, 5n, T_STAR + 20),
  ]).get("grace");
  assert.equal(e.validYesWad, 0n);
  assert.equal(e.refundUsdc, 0n);
});

test("a sell the tape cannot account for is reported, not swallowed", () => {
  // Almost always a truncated signature walk, and an entitlement computed from
  // a partial tape is not the entitlement.
  const { anomalies } = computeAmmEntitlements({
    trades: [sell("heidi", YES, 4n, T_STAR + 1)],
    tStar: T_STAR,
  });
  assert.equal(anomalies.length, 1);
  assert.match(anomalies[0], /tape is incomplete/);
});

// ── Book ────────────────────────────────────────────────────────────────────

const leg = (wallet, shares, costUsdc, ts) => ({
  wallet,
  deltaShares: shares,
  costUsdc,
  ts,
});
const bookOf = (legs) => computeBookEntitlements({ legs, tStar: T_STAR }).entitlements;

test("a seat filled only before T* keeps its whole net and gets no refund", () => {
  const e = bookOf([leg("alice", 5_000_000n, 3_000_000n, T_STAR - 10)]).get("alice");
  assert.equal(e.validNet, 5_000_000n);
  assert.equal(e.refundUsdc, 0n);
});

test("a seat filled only after T* keeps nothing and is refunded what it paid", () => {
  const e = bookOf([leg("bob", -4_000_000n, 1_200_000n, T_STAR + 10)]).get("bob");
  assert.equal(e.validNet, 0n);
  assert.equal(e.voidedShares, 4_000_000n);
  assert.equal(e.refundUsdc, 1_200_000n);
});

test("the sign of the entitlement follows the seat's side", () => {
  const e = bookOf([leg("bob", -4_000_000n, 1_200_000n, T_STAR - 10)]).get("bob");
  assert.equal(e.validNet, -4_000_000n, "long NO is a negative net");
});

test("a closing fill consumes the earliest opposite lot before opening anything", () => {
  // `split_delta`, mirrored: a seat holds ONE signed net, so its lots are
  // always same-signed and a crossing fill closes before it opens.
  const e = bookOf([
    leg("carol", 6_000_000n, 3_600_000n, T_STAR - 10),
    leg("carol", -10_000_000n, 4_000_000n, T_STAR + 10),
  ]).get("carol");
  assert.equal(e.validNet, 0n, "the pre-T* long was closed out");
  assert.equal(e.voidedShares, 4_000_000n, "and 4 shares of the new short opened post-T*");
  // The leg cost covers 10 shares; only the 4 that OPENED carry basis.
  assert.equal(e.refundUsdc, (4_000_000n * 4_000_000n) / 10_000_000n);
});

test("a book refund can never exceed the voided shares' face value", () => {
  // `assert_book_claim_within_seat` refuses more than one unit per voided
  // share, so a refund at a tick price is always inside it.
  const { bidCost } = legCosts(999, 1_000_000n, 0);
  const e = bookOf([leg("dave", 1_000_000n, bidCost, T_STAR + 1)]).get("dave");
  assert.ok(e.refundUsdc <= e.voidedShares, `${e.refundUsdc} > ${e.voidedShares}`);
});

test("leg costs sum to the fill amount, with the taker taking the remainder", () => {
  // Flooring both legs independently would leave the vault one base unit short
  // per fill, so the program floors the MAKER and gives the taker the rest.
  for (const tick of [1, 137, 500, 999]) {
    for (const takerSide of [0, 1]) {
      const amount = 1_000_003n;
      const { bidCost, askCost } = legCosts(tick, amount, takerSide);
      assert.equal(bidCost + askCost, amount, `tick ${tick} side ${takerSide}`);
      const makerCost = takerSide === 0 ? askCost : bidCost;
      const makerTicks = takerSide === 0 ? 1000n - BigInt(tick) : BigInt(tick);
      assert.equal(makerCost, (amount * makerTicks) / 1000n);
    }
  }
});

test("a tick outside (0, 1000) is refused rather than priced", () => {
  assert.throws(() => legCosts(0, 1n, 0), /invalid price tick/);
  assert.throws(() => legCosts(1000, 1n, 0), /invalid price tick/);
});

// ── Leaf order ──────────────────────────────────────────────────────────────

test("leaves order AMM first, then book, each by raw pubkey bytes", () => {
  // The order is part of the commitment: `leaf_count` is published so a third
  // party can reproduce the promotion rule at every level, which needs the
  // same order this produced.
  const rows = [
    { kind: "book", userBytes: Buffer.alloc(32, 1) },
    { kind: "amm", userBytes: Buffer.alloc(32, 9) },
    { kind: "book", userBytes: Buffer.alloc(32, 0) },
    { kind: "amm", userBytes: Buffer.alloc(32, 2) },
  ];
  const ordered = orderLeaves(rows);
  assert.deepEqual(
    ordered.map((r) => `${r.kind}:${r.userBytes[0]}`),
    ["amm:2", "amm:9", "book:0", "book:1"],
  );
  // Stable under a reshuffle of the input — anyone replaying gets this order.
  assert.deepEqual(orderLeaves([...rows].reverse()), ordered);
});
