// From tape to tree: the clamps, the leaf-per-account rule, and the ceilings.
//
// `buildCommitment` is where a computed entitlement meets the accounts the
// program will check it against, and the three things it must get right are
// all things a wrong answer makes UNREDEEMABLE rather than merely wrong:
//
//   - a leaf that claims more shares than the position holds, or more cash
//     than it paid in, verifies against the root and then fails the payout;
//   - a position with NO leaf cannot redeem at all, because a live commitment
//     makes the claim argument mandatory;
//   - a ceiling below the sum of the tree's refunds strands whoever redeems
//     last.
//
// The tape is injected here so the accounting is exercised without a validator.
// The end-to-end proof that these leaves verify against the Rust verifier is
// `packages/sdk-solana/tests/t-star-voiding-resolver.test.ts`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";

import { buildCommitment, proofArtifact } from "../src/void/commitment.mjs";
import { verifyProof } from "../src/void/merkle.mjs";

const WAD = 10n ** 18n;
const T_STAR = 1_000;
const MARKET = new PublicKey("11111111111111111111111111111112");
const ALICE = new PublicKey("11111111111111111111111111111113");
const BOB = new PublicKey("11111111111111111111111111111114");

const bn = (v) => ({ toString: () => String(v) });

/** A chain stub: only the four reads `buildCommitment` performs. */
function fakeChain({ positions = [], seats = null }) {
  return {
    programId: new PublicKey("11111111111111111111111111111111"),
    connection: null,
    program: null,
    async readMarketAccount() {
      return {
        startTime: 0,
        deadline: 10_000,
        lifecycle: "locked",
        book: new PublicKey("11111111111111111111111111111115"),
        ammState: MARKET,
        protocolConfig: MARKET,
        resolutionCommitment: MARKET,
        vaultAmm: MARKET,
        vaultBook: MARKET,
      };
    },
    async readPositions() {
      return { positions, source: "getProgramAccounts" };
    },
    async readBookSeats() {
      return seats;
    },
  };
}

const position = (user, yes, no, lockedCost) => ({
  account: {
    user,
    yesShares: bn(yes),
    noShares: bn(no),
    lockedCostUsdc: bn(lockedCost),
  },
});

const emptyTape = (over = {}) => ({
  ammTrades: [],
  bookLegs: [],
  anomalies: [],
  signatureCount: 0,
  scanned: 0,
  ...over,
});

const buy = (user, outcome, shares, costUsdc, ts) => ({
  wallet: user.toBase58(),
  outcome,
  deltaSharesWad: shares * WAD,
  costWad: costUsdc * 10n ** 12n,
  ts,
});

test("every position gets a leaf, even one the tape never mentions", async () => {
  // A live commitment makes the claim argument MANDATORY on
  // `redeem_amm_position`. A position with no leaf could never redeem, so an
  // all-zero leaf is the floor, not an omission — and the gap is reported.
  const plan = await buildCommitment({
    chain: fakeChain({ positions: [position(ALICE, 5n * WAD, 0n, 4_000_000n)] }),
    marketPk: MARKET,
    tStar: T_STAR,
    tStarSource: "operator",
    tape: emptyTape(),
  });
  assert.equal(plan.leafCount, 1);
  assert.equal(plan.ammRows[0].validYesWad, 0n);
  assert.match(plan.anomalies.join("\n"), /appears nowhere in the tape/);
});

test("pre-T*, post-T* and mixed wallets land in the tree as computed", async () => {
  const plan = await buildCommitment({
    chain: fakeChain({
      positions: [
        position(ALICE, 10n * WAD, 0n, 4_000_000n),
        position(BOB, 6n * WAD, 0n, 6_000_000n),
      ],
    }),
    marketPk: MARKET,
    tStar: T_STAR,
    tStarSource: "operator",
    tape: emptyTape({
      ammTrades: [
        buy(ALICE, 1, 10n, 4_000_000n, T_STAR - 10), // wholly honest
        buy(BOB, 1, 2n, 600_000n, T_STAR - 10), // mixed
        buy(BOB, 1, 4n, 3_800_000n, T_STAR + 10),
      ],
    }),
  });

  const alice = plan.ammRows.find((r) => r.wallet === ALICE.toBase58());
  assert.equal(alice.validYesWad, 10n * WAD);
  assert.equal(alice.voidRefundUsdc, 0n);

  const bob = plan.ammRows.find((r) => r.wallet === BOB.toBase58());
  assert.equal(bob.validYesWad, 2n * WAD);
  assert.equal(bob.voidRefundUsdc, 3_800_000n);

  // The ceiling IS the sum of the tree's refunds — the program checks the
  // vault against it, and every redemption accumulates against it.
  assert.equal(plan.totalVoidRefundUsdc, 3_800_000n);
  assert.equal(
    plan.totalVoidRefundUsdc,
    plan.ammRows.reduce((s, r) => s + r.voidRefundUsdc, 0n),
  );
});

test("an entitlement larger than the position is clamped and reported", async () => {
  // The program enforces `valid_* <= held` and `refund <= locked_cost`. A tree
  // that violates either verifies and then fails to pay, so the clamp happens
  // here — and the only honest reason for it to bite is an incomplete tape.
  const plan = await buildCommitment({
    chain: fakeChain({ positions: [position(ALICE, 3n * WAD, 0n, 1_000_000n)] }),
    marketPk: MARKET,
    tStar: T_STAR,
    tStarSource: "operator",
    tape: emptyTape({
      ammTrades: [
        buy(ALICE, 1, 9n, 2_500_000n, T_STAR - 10),
        buy(ALICE, 1, 1n, 900_000n, T_STAR + 10),
      ],
    }),
  });
  const alice = plan.ammRows[0];
  assert.equal(alice.validYesWad, 3n * WAD, "clamped to the shares actually held");
  assert.equal(alice.voidRefundUsdc, 900_000n);
  assert.match(plan.anomalies.join("\n"), /clamped to the position/);
});

test("a refund above locked_cost_usdc is clamped to it", async () => {
  // `locked_cost_usdc` shrinks on a sell by the PROCEEDS, not by the cost
  // basis, so a wallet that sold at a profit can carry a cost basis the field
  // no longer covers. `claim_refund` pays from that same field, and the void
  // path is bounded by it.
  const plan = await buildCommitment({
    chain: fakeChain({ positions: [position(ALICE, 5n * WAD, 0n, 1_200_000n)] }),
    marketPk: MARKET,
    tStar: T_STAR,
    tStarSource: "operator",
    tape: emptyTape({ ammTrades: [buy(ALICE, 1, 5n, 4_000_000n, T_STAR + 10)] }),
  });
  assert.equal(plan.ammRows[0].voidRefundUsdc, 1_200_000n);
  assert.equal(plan.totalVoidRefundUsdc, 1_200_000n);
});

test("book seats get their own leaf kind, with their own ceiling", async () => {
  // Two venues, two vaults, two ceilings — one over both would let an AMM
  // refund consume the allowance a book refund was sized against.
  const plan = await buildCommitment({
    chain: fakeChain({
      positions: [position(ALICE, 2n * WAD, 0n, 800_000n)],
      seats: [{ trader: BOB.toBase58(), net: -4_000_000n, credit: 0n }],
    }),
    marketPk: MARKET,
    tStar: T_STAR,
    tStarSource: "operator",
    tape: emptyTape({
      ammTrades: [buy(ALICE, 1, 2n, 800_000n, T_STAR - 5)],
      bookLegs: [
        { wallet: BOB.toBase58(), deltaShares: -4_000_000n, costUsdc: 1_200_000n, ts: T_STAR + 5 },
      ],
    }),
  });
  assert.equal(plan.leafCount, 2);
  assert.equal(plan.totalVoidRefundUsdc, 0n);
  assert.equal(plan.totalBookVoidRefundUsdc, 1_200_000n);
  assert.equal(plan.bookRows[0].validNet, 0n);
  // AMM leaves sort ahead of book leaves, always.
  assert.deepEqual(plan.rows.map((r) => r.kind), ["amm", "book"]);
});

test("a T* at or before the market's start is refused, not published", async () => {
  // The program refuses it (`InvalidTStar`) precisely because it would void
  // every trade the market ever saw.
  await assert.rejects(
    buildCommitment({
      chain: fakeChain({ positions: [position(ALICE, 1n, 0n, 1n)] }),
      marketPk: MARKET,
      tStar: 0,
      tStarSource: "operator",
      tape: emptyTape(),
    }),
    /not after the market's start_time/,
  );
});

test("a market with no positions and no seats is refused", async () => {
  // `leaf_count` must be > 0 — the program rejects an empty commitment, and a
  // zero root is not verifiable by anything.
  await assert.rejects(
    buildCommitment({
      chain: fakeChain({}),
      marketPk: MARKET,
      tStar: T_STAR,
      tStarSource: "operator",
      tape: emptyTape(),
    }),
    /nothing to commit to/,
  );
});

test("the artifact indexes proofs by wallet and every one of them verifies", async () => {
  // This is the shape a client fetches: one lookup by address gives exactly
  // the argument `redeem_amm_position` takes.
  const plan = await buildCommitment({
    chain: fakeChain({
      positions: [
        position(ALICE, 10n * WAD, 0n, 4_000_000n),
        position(BOB, 6n * WAD, 0n, 6_000_000n),
      ],
      seats: [{ trader: BOB.toBase58(), net: 3_000_000n, credit: 5n }],
    }),
    marketPk: MARKET,
    tStar: T_STAR,
    tStarSource: "operator",
    tape: emptyTape({ ammTrades: [buy(ALICE, 1, 10n, 4_000_000n, T_STAR - 1)] }),
  });

  const artifact = proofArtifact(plan);
  assert.equal(artifact.leafCount, 3);
  assert.equal(artifact.convention, "sooth-tstar/fifo-v1");
  assert.ok(artifact.byWallet[ALICE.toBase58()].amm);
  assert.ok(artifact.byWallet[BOB.toBase58()].amm);
  assert.ok(artifact.byWallet[BOB.toBase58()].book);

  for (const row of plan.rows) {
    assert.ok(verifyProof(row.leaf, row.proof, plan.root), `leaf ${row.index} does not verify`);
  }
  // Serializable as written — every bigint is already a string.
  JSON.parse(JSON.stringify(artifact));
});
