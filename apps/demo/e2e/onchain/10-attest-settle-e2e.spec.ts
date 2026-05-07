// attest-settle-e2e — adapter-direct (operator + adjudicator path).
//
// Why adapter-direct:
//   The demo's UI does not surface a "Settle" or "Attest" button on
//   Solana — operator/adjudicator flows ship as off-chain tooling on
//   the EVM stack and the chain-shim has no Solana branch for them. We
//   drive `sooth_adjudicator::request_lock` and `attest_outcome` (which
//   CPIs into `sooth_market::lock_for_resolution` and `settle`
//   respectively) directly via Anchor handles loaded from the SDK IDLs,
//   the same pattern global-setup.ts uses for `seed_lp`.
//
// Pre-condition (adapter-direct, NOT under test): buy 10 YES so the
// settled market has a non-trivial position to redeem from in the
// downstream 11-redeem-yes-wins-e2e spec. The buy itself isn't asserted
// here — that's covered by 00-buy-amm-e2e.
//
// Action under test:
//   1. request_lock(authority=creator) → Market.lifecycle: Open → Locked.
//      Parent-ix introspection on `sooth_market::lock_for_resolution`
//      pins the caller program to sooth_adjudicator::ID.
//   2. attest_outcome(authority=creator, winning_outcome=1)
//      → Adjudicator.attested_outcome = Some(1)
//      → CPI into sooth_market::settle
//      → Market.lifecycle: Locked → Settled
//      → Market.winning_outcome = 1.
//
// Verifications:
//   - Market.lifecycle == 3 (Settled).
//   - Market.winning_outcome == 1 (YES).
//   - Adjudicator.attested_outcome == 1 (Option::Some).

import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { makeConnection, waitForOnChainChange } from "../helpers/onchain";
import { loadFixture, testPubkey, marketIdBytes } from "../helpers/fixture";
import {
  buyViaAdapter,
  loadTestKeypair,
  loadCreatorKeypair,
  derivePositionPda,
  deriveAdjudicatorPda,
  fetchMarket,
  fetchPosition,
  fetchAdjudicator,
  requestLockViaAdapter,
  attestOutcomeViaAdapter,
} from "../helpers/sdk-helpers";

const TEN_SHARES_WAD = 10n * 10n ** 18n;
const LIFECYCLE_LOCKED = 2;
const LIFECYCLE_SETTLED = 3;
const WINNING_YES = 1;

test.describe("attest + settle (adapter-direct, creator-authority path)", () => {
  test("request_lock → attest_outcome(YES): Market settled with winning=YES; Adjudicator attested=Some(1)", async () => {
    test.setTimeout(120_000);

    const fixture = loadFixture();
    const conn = makeConnection();
    const TEST_PUBKEY = testPubkey();
    const idBytes = marketIdBytes(fixture);
    const usdcMint = new PublicKey(fixture.usdcMint);
    const marketPda = new PublicKey(fixture.marketPda);

    const positionPda = derivePositionPda(idBytes, TEST_PUBKEY);
    const adjudicatorPda = deriveAdjudicatorPda(marketPda);

    // 1. Pre-condition: ensure the user has at least 10 YES so the
    //    redeem spec downstream has a position to burn. Idempotent — if
    //    a previous run already filled this position we skip the buy.
    const signer = loadTestKeypair();
    const posBefore = await fetchPosition(conn, positionPda);
    const yesBeforeBuy = posBefore?.yesShares ?? 0n;
    if (yesBeforeBuy < TEN_SHARES_WAD) {
      await buyViaAdapter({
        conn,
        signer,
        marketPda,
        marketId: idBytes,
        usdcMint,
        outcome: 1,
        deltaShares: TEN_SHARES_WAD - yesBeforeBuy,
        // Generous max-cost ceiling — same shape as 07-sell setup.
        maxCostWad: 6n * 10n ** 18n,
      });
      await waitForOnChainChange(
        async () => fetchPosition(conn, positionPda),
        (p) => (p?.yesShares ?? 0n) >= TEN_SHARES_WAD,
        30_000,
        500,
      );
    }

    // 2. Snapshot Market lifecycle. If a previous (failed/partial) run
    //    already settled this market, this spec is a no-op against the
    //    live state — assert the terminal-state invariants and exit.
    const marketBefore = await fetchMarket(conn, marketPda);
    if (!marketBefore) throw new Error("market PDA missing on-chain");

    if (marketBefore.lifecycle === LIFECYCLE_SETTLED) {
      // eslint-disable-next-line no-console
      console.log(
        `[spec-10] market already Settled (winning=${marketBefore.winningOutcome}); ` +
          `idempotent terminal-state check`,
      );
      expect(marketBefore.winningOutcome).toBe(WINNING_YES);
      const adj = await fetchAdjudicator(conn, adjudicatorPda);
      expect(adj?.attestedOutcome).toBe(WINNING_YES);
      return;
    }

    // 3. request_lock (Open → Locked) using the creator authority. The
    //    ix CPIs into sooth_market::lock_for_resolution; success leaves
    //    Market.lifecycle == Locked. Skip if already locked from a
    //    previous partial run.
    const creator = loadCreatorKeypair();
    if (marketBefore.lifecycle !== LIFECYCLE_LOCKED) {
      await requestLockViaAdapter({ conn, authority: creator, marketPda });
      await waitForOnChainChange(
        async () => fetchMarket(conn, marketPda),
        (m) => m?.lifecycle === LIFECYCLE_LOCKED,
        30_000,
        500,
      );
    }

    // 4. attest_outcome(YES). CPIs into sooth_market::settle which gates
    //    on parent-ix == sooth_adjudicator::attest_outcome. On success
    //    Adjudicator.attested_outcome = Some(1) AND Market.lifecycle
    //    becomes Settled with winning_outcome = 1.
    const sig = await attestOutcomeViaAdapter({
      conn,
      authority: creator,
      marketPda,
      winningOutcome: WINNING_YES,
    });
    expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,88}$/);

    // 5. Assert Market is Settled with winning=YES.
    const marketAfter = await waitForOnChainChange(
      async () => fetchMarket(conn, marketPda),
      (m) => m?.lifecycle === LIFECYCLE_SETTLED,
      30_000,
      500,
    );
    expect(marketAfter!.lifecycle).toBe(LIFECYCLE_SETTLED);
    expect(marketAfter!.winningOutcome).toBe(WINNING_YES);

    // 6. Assert Adjudicator.attested_outcome = Some(1).
    const adjAfter = await fetchAdjudicator(conn, adjudicatorPda);
    expect(adjAfter).not.toBeNull();
    expect(adjAfter!.attestedOutcome).toBe(WINNING_YES);

    // eslint-disable-next-line no-console
    console.log(
      `[spec-10] settled market=${marketPda.toBase58()} winning=${marketAfter!.winningOutcome} sig=${sig}`,
    );
  });
});
