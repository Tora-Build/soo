// Resolution authority: register → lock → attest → (dispute).
//
// Replaces main's sooth_adjudicator/tests/adjudicator_flow.rs (23 tests),
// which the 5→1 merge deleted. It is NOT a transcription, because 18 of
// main's 23 tests do not test the program.
//
// Main's file defines its own `register()`, `attest()` and `dispute()`
// functions at the top — inline copies of the handler bodies — and then
// tests those copies. Its own comment is explicit: "We replicate the handler
// bodies inline … The on-chain handlers must stay in lock-step with these
// helpers — if/when this drifts, the integration suite will catch the gap."
// There is no such integration suite. Delete the real handler and every one
// of those tests still passes, which makes them worth ~nothing as
// regressions. Only the state-shape tests (SPACE, is_attested) test real
// code; those are ported to Rust in `state/adjudicator.rs`.
//
// So the flow is re-tested here against the actual instructions on LiteSVM.
// Doing that immediately surfaced something the mock could not:
//
//   ⚠️ THE DISPUTE PATH IS UNREACHABLE. See the final describe block.
//
// Note main's `AdjudicatorKind` (Manual / ZkTLS / Other) is gone in develop —
// the entry has no `kind` field — so main's four kind-dispatch tests
// (attest_rejects_zk_tls_in_v1, attest_rejects_other_variant_in_v1, the
// discriminant table, the kind SPACE constant) describe a type that no longer
// exists and are dropped rather than faked.

import { describe, expect, it } from "vitest";
import { PublicKey, Transaction } from "@solana/web3.js";
import { SystemProgram } from "@solana/web3.js";

import {
  deriveAdjudicatorEntryPda,
  deriveProtocolConfigPda,
} from "../src/pdas.js";
import { bootSmoke, warpClockTo, type SmokeContext } from "./fixtures/setup.js";
import { anchorProgram, customError, sendTx } from "./fixtures/orderbook.js";

const OUTCOME_NO = 0;
const OUTCOME_YES = 1;
const OUTCOME_INVALID = 2;

const ERR = {
  MarketNotOpen: 6000,
  InvalidLifecycleTransition: 6002,
  InvalidOutcome: 6003,
  AdjudicatorIsDefault: 6009,
  Unauthorized: 6019,
  NotAuthority: 6037,
  AlreadyAttested: 6038,
  AlreadyDisputed: 6040,
  MarketAlreadySettled: 6041,
  NotYetAttested: 6055,
  TradingNotClosed: 6056,
} as const;

/** bootSmoke's market: created at 1_000_000, deadline +7d. */
const DEADLINE = 1_000_000 + 7 * 24 * 60 * 60;

function entryPda(smoke: SmokeContext): PublicKey {
  return deriveAdjudicatorEntryPda(smoke.marketPda, smoke.programs)[0];
}

async function fetchEntry(program: any, smoke: SmokeContext): Promise<any> {
  return (program.account as any).adjudicatorEntry.fetch(entryPda(smoke));
}

async function fetchMarket(program: any, smoke: SmokeContext): Promise<any> {
  return (program.account as any).market.fetch(smoke.marketPda);
}

/** `lock_for_resolution` — Open → Locked. Unlike `request_lock` this has no
 *  deadline gate, so it works inside the trading window. */
async function lockTx(program: any, smoke: SmokeContext, authority: PublicKey) {
  return new Transaction().add(
    await program.methods
      .lockForResolution()
      .accounts({
        market: smoke.marketPda,
        adjudicatorEntry: entryPda(smoke),
        authority,
      })
      .instruction(),
  );
}

async function attestTx(
  program: any,
  smoke: SmokeContext,
  authority: PublicKey,
  outcome: number,
) {
  return new Transaction().add(
    await program.methods
      .attestOutcome(outcome)
      .accounts({
        adjudicatorEntry: entryPda(smoke),
        market: smoke.marketPda,
        authority,
      })
      .instruction(),
  );
}

async function disputeTx(
  program: any,
  smoke: SmokeContext,
  disputer: PublicKey,
  outcome: number,
) {
  return new Transaction().add(
    await program.methods
      .dispute(outcome)
      .accounts({
        adjudicatorEntry: entryPda(smoke),
        market: smoke.marketPda,
        disputer,
      })
      .instruction(),
  );
}

async function registerTx(
  program: any,
  smoke: SmokeContext,
  signer: PublicKey,
  authority: PublicKey,
) {
  return new Transaction().add(
    await program.methods
      .registerAdjudicator(authority)
      .accounts({
        adjudicatorEntry: entryPda(smoke),
        market: smoke.marketPda,
        protocolConfig: deriveProtocolConfigPda(smoke.programs)[0],
        signer,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );
}

describe("register_adjudicator", () => {
  it("creates an unattested entry with dispute_authority defaulted to authority", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    const entry = await fetchEntry(program, smoke);

    expect(entry.market.toBase58()).toBe(smoke.marketPda.toBase58());
    expect(entry.authority.toBase58()).toBe(smoke.creator.publicKey.toBase58());
    // v1 collapses the two roles. This is deliberate and matches main —
    // it is not a develop regression.
    expect(entry.disputeAuthority.toBase58()).toBe(
      smoke.creator.publicKey.toBase58(),
    );
    expect(entry.attestedOutcome).toBeNull();
    expect(entry.attestedAt).toBeNull();
    expect(entry.disputed).toBe(false);
    expect(entry.disputedAt).toBeNull();
  }, 60_000);

  it("rejects the all-zero pubkey as authority", async () => {
    // An unset authority would make the market permanently unresolvable while
    // still looking registered.
    const smoke = await bootSmoke({ skipRegisterAdjudicator: true });
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await registerTx(
          program,
          smoke,
          smoke.creator.publicKey,
          PublicKey.default,
        ),
      ),
    ).rejects.toThrow(customError(ERR.AdjudicatorIsDefault));
  }, 60_000);

  it("in permissionless mode, only the market creator may register", async () => {
    const smoke = await bootSmoke({ skipRegisterAdjudicator: true });
    const program = anchorProgram(smoke.ctx, smoke.user);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user], // not the creator
        await registerTx(
          program,
          smoke,
          smoke.user.publicKey,
          smoke.user.publicKey,
        ),
      ),
    ).rejects.toThrow(customError(ERR.Unauthorized));
  }, 60_000);

  it("in permissioned mode, the creator is NOT enough — config.authority gates it", async () => {
    // The branch main's host-side tests never touched: `register` there took
    // no config at all. Here the creator is rejected even though they own the
    // market, because permissionless_adjudicators is false.
    const smoke = await bootSmoke({
      skipRegisterAdjudicator: true,
      permissionlessAdjudicators: false,
    });
    const program = anchorProgram(smoke.ctx, smoke.user);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await registerTx(
          program,
          smoke,
          smoke.user.publicKey,
          smoke.user.publicKey,
        ),
      ),
    ).rejects.toThrow(customError(ERR.Unauthorized));

    // config.authority is the creator in this fixture, so it still succeeds
    // for them — proving the failure above is about the signer, not a
    // blanket rejection.
    const asCreator = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await registerTx(
        asCreator,
        smoke,
        smoke.creator.publicKey,
        smoke.creator.publicKey,
      ),
    );
    expect((await fetchEntry(asCreator, smoke)).authority.toBase58()).toBe(
      smoke.creator.publicKey.toBase58(),
    );
  }, 60_000);
});

describe("locking a market for resolution", () => {
  it("request_lock refuses before the trading deadline", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        new Transaction().add(
          await program.methods
            .requestLock()
            .accounts({
              adjudicatorEntry: entryPda(smoke),
              market: smoke.marketPda,
              authority: smoke.creator.publicKey,
            })
            .instruction(),
        ),
      ),
    ).rejects.toThrow(customError(ERR.TradingNotClosed));
  }, 60_000);

  it("request_lock succeeds once the deadline has passed", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    warpClockTo(smoke.ctx, BigInt(DEADLINE + 1));
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await program.methods
          .requestLock()
          .accounts({
            adjudicatorEntry: entryPda(smoke),
            market: smoke.marketPda,
            authority: smoke.creator.publicKey,
          })
          .instruction(),
      ),
    );
    expect((await fetchMarket(program, smoke)).lifecycle).toHaveProperty(
      "locked",
    );
  }, 60_000);

  it("lock_for_resolution has NO deadline gate — it locks mid-window", async () => {
    // Two instructions reach the same Open → Locked transition with different
    // preconditions. `request_lock` enforces `now >= deadline`;
    // `lock_for_resolution` does not, so the adjudicator authority can halt
    // trading at any time. Pinned as a known asymmetry, not endorsed: if the
    // deadline gate is meant to be a real guarantee to traders, this is the
    // way around it.
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );
    expect((await fetchMarket(program, smoke)).lifecycle).toHaveProperty(
      "locked",
    );
  }, 60_000);

  it("a non-authority cannot lock", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.user);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await lockTx(program, smoke, smoke.user.publicKey),
      ),
    ).rejects.toThrow(customError(ERR.NotAuthority));
  }, 60_000);
});

describe("attest_outcome", () => {
  async function locked() {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );
    return { smoke, program };
  }

  it("records the outcome and settles the market in one instruction", async () => {
    const { smoke, program } = await locked();
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_YES),
    );

    const entry = await fetchEntry(program, smoke);
    expect(entry.attestedOutcome).toBe(OUTCOME_YES);
    expect(entry.attestedAt).not.toBeNull();
    expect(entry.disputed).toBe(false);

    // attest_outcome CPIs straight through settle_internal — there is no
    // intermediate "attested but not settled" state. This is the fact that
    // makes dispute unreachable; see the last block.
    const market = await fetchMarket(program, smoke);
    expect(market.lifecycle).toHaveProperty("settled");
    expect(market.winningOutcome).toBe(OUTCOME_YES);
  }, 60_000);

  it("accepts INVALID as a legitimate outcome", async () => {
    const { smoke, program } = await locked();
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_INVALID),
    );
    const market = await fetchMarket(program, smoke);
    expect(market.winningOutcome).toBe(OUTCOME_INVALID);
    expect((await fetchEntry(program, smoke)).attestedOutcome).toBe(
      OUTCOME_INVALID,
    );
  }, 60_000);

  it("rejects an out-of-range outcome", async () => {
    const { smoke, program } = await locked();
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestTx(program, smoke, smoke.creator.publicKey, 3),
      ),
    ).rejects.toThrow(customError(ERR.InvalidOutcome));
  }, 60_000);

  it("rejects a signer that is not the registered authority", async () => {
    const { smoke, program } = await locked();
    const asUser = anchorProgram(smoke.ctx, smoke.user);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await attestTx(asUser, smoke, smoke.user.publicKey, OUTCOME_YES),
      ),
    ).rejects.toThrow(customError(ERR.Unauthorized));
  }, 60_000);

  it("is one-shot", async () => {
    const { smoke, program } = await locked();
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_YES),
    );
    // The second attempt trips AlreadyAttested — which is checked BEFORE the
    // lifecycle transition, so this is the adjudicator's own guard rather
    // than settle_internal's.
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_NO),
      ),
    ).rejects.toThrow(customError(ERR.AlreadyAttested));
  }, 60_000);

  it("cannot attest an Open market — it must be Locked first", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_YES),
      ),
    ).rejects.toThrow(customError(ERR.InvalidLifecycleTransition));
  }, 60_000);
});

describe("dispute — UNREACHABLE in develop and main alike", () => {
  // dispute() has four guards, and two of them are mutually exclusive:
  //
  //     require!(market.lifecycle != Settled, MarketAlreadySettled)
  //     require!(entry.is_attested(),         NotYetAttested)
  //
  // `attested_outcome` is only ever set by attest_outcome, and attest_outcome
  // ends by calling settle_internal, which sets lifecycle = Settled in the
  // same transaction. There is no failure mode in between: if settle_internal
  // errors the whole instruction reverts and nothing is attested.
  //
  // So every market is in exactly one of two states, and dispute rejects both.
  // The two tests below walk both sides of the fork; together they are a
  // proof, not a sample.
  //
  // Main has the identical structure and documents it as a design choice
  // ("a window of 'between attest and settle' doesn't exist in v1's calling
  // pattern") — but its tests drive a `dispute(adj, market_settled: bool, …)`
  // mock where `market_settled` is a free parameter, so main's suite happily
  // shows dispute "working" on an attested-but-unsettled market that the
  // program can never produce. That is exactly the gap a mock leaves.
  //
  // This matters for the guardian-veto question: today the veto is not merely
  // limited to a single collapsed authority, it is available to nobody. A
  // guardian allowlist grafted onto this handler would still be dead code.
  // Fixing it needs a real ATTESTED state — attest stops calling
  // settle_internal, and settle becomes a separate call after a veto window.

  it("after attestation: the market is already Settled", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_YES),
    );

    // Signed by dispute_authority itself — the most privileged caller that
    // exists. It still fails.
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await disputeTx(
          program,
          smoke,
          smoke.creator.publicKey,
          OUTCOME_INVALID,
        ),
      ),
    ).rejects.toThrow(customError(ERR.MarketAlreadySettled));

    // And the outcome is untouched: no partial application.
    const entry = await fetchEntry(program, smoke);
    expect(entry.attestedOutcome).toBe(OUTCOME_YES);
    expect(entry.disputed).toBe(false);
  }, 60_000);

  it("before attestation: there is nothing attested to dispute", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await disputeTx(
          program,
          smoke,
          smoke.creator.publicKey,
          OUTCOME_INVALID,
        ),
      ),
    ).rejects.toThrow(customError(ERR.NotYetAttested));
  }, 60_000);

  it("AlreadyDisputed is therefore dead code too", async () => {
    // `disputed` can only be set by a successful dispute, and no dispute can
    // succeed — so the flag is permanently false and its guard unreachable.
    // Asserted rather than left implicit: if someone later makes dispute
    // reachable, this test should be revisited alongside it.
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_YES),
    );
    expect((await fetchEntry(program, smoke)).disputed).toBe(false);
    expect((await fetchEntry(program, smoke)).disputedAt).toBeNull();
  }, 60_000);
});
