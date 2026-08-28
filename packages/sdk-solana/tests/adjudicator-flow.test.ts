// Resolution authority: register → lock → attest → (dispute).
//
// Exercised against the actual instructions on LiteSVM, not against inline
// copies of the handler bodies: a test that re-implements the handler passes
// whether or not the real handler exists, so it is worth nothing as a
// regression. State-shape assertions (SPACE, is_attested) live in Rust, in
// `state/adjudicator.rs`.
//
// Attest and settle are separate phases either side of a VETO_PERIOD_SECS
// window (docs/spec/sooth_adjudicator.md §6, matching the EVM contract).
// Keeping them separate is what makes the dispute path reachable at all: if
// `attest_outcome` settled inline, no market would ever be
// attested-and-not-yet-settled, and every dispute would fail with
// MarketAlreadySettled or NotYetAttested. The final two describe blocks cover
// the veto window from both sides.
//
// `AdjudicatorEntry` has no `kind` field — there is one attestation path, so
// there is nothing to dispatch on.
import { describe, expect, it } from "vitest";
import { PublicKey, Transaction } from "@solana/web3.js";
import { Keypair, SystemProgram } from "@solana/web3.js";

import {
  deriveAdjudicatorEntryPda,
  deriveProtocolConfigPda,
} from "../src/pdas.js";
import { bootSmoke, warpClockTo, type SmokeContext } from "./fixtures/setup.js";
import { anchorProgram, customError, sendTx } from "./fixtures/orderbook.js";

const OUTCOME_NO = 0;
const OUTCOME_YES = 1;
const OUTCOME_INVALID = 2;

/** bootSmoke's ProtocolConfig.veto_period_secs default. */
const VETO_PERIOD_SECS = 24n * 60n * 60n;

const ERR = {
  MarketNotOpen: 6000,
  InvalidLifecycleTransition: 6002,
  InvalidOutcome: 6003,
  AdjudicatorIsDefault: 6009,
  Unauthorized: 6019,
  NotAuthority: 6037,
  AlreadyAttested: 6038,
  AlreadyDisputed: 6040,
  TooManyDisputes: 6110,
  GuardianNotFound: 6112,
  MarketAlreadySettled: 6041,
  NotYetAttested: 6055,
  TradingNotClosed: 6056,
  VetoWindowOpen: 6058,
  VetoWindowClosed: 6059,
  InvalidVetoPeriod: 6060,
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
        protocolConfig: deriveProtocolConfigPda(smoke.programs)[0],
        guardianSet: null,
        disputer,
      })
      .instruction(),
  );
}

async function settleTx(
  program: any,
  smoke: SmokeContext,
  cranker: PublicKey,
) {
  return new Transaction().add(
    await program.methods
      .settle()
      .accounts({
        market: smoke.marketPda,
        adjudicatorEntry: entryPda(smoke),
        protocolConfig: deriveProtocolConfigPda(smoke.programs)[0],
        cranker,
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
    // v1 collapses the two roles: dispute_authority defaults to authority.
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

  it("records the outcome but leaves the market Locked", async () => {
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

    // The ATTESTED state: outcome recorded, lifecycle untouched. This is the
    // window dispute needs.
    const market = await fetchMarket(program, smoke);
    expect(market.lifecycle).toHaveProperty("locked");
    expect(market.lifecycle).not.toHaveProperty("settled");
  }, 60_000);

  it("accepts INVALID as a legitimate outcome", async () => {
    const { smoke, program } = await locked();
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_INVALID),
    );
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

describe("settle — permissionless, after the veto window", () => {
  async function attested(outcome = OUTCOME_YES) {
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
      await attestTx(program, smoke, smoke.creator.publicKey, outcome),
    );
    const entry = await fetchEntry(program, smoke);
    const vetoEndsAt =
      BigInt(entry.attestedAt.toString()) + VETO_PERIOD_SECS;
    return { smoke, program, vetoEndsAt };
  }

  it("refuses while the veto window is open", async () => {
    const { smoke, program } = await attested();
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await settleTx(program, smoke, smoke.creator.publicKey),
      ),
    ).rejects.toThrow(customError(ERR.VetoWindowOpen));
  }, 60_000);

  it("still refuses one second early", async () => {
    const { smoke, program, vetoEndsAt } = await attested();
    warpClockTo(smoke.ctx, vetoEndsAt - 1n);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await settleTx(program, smoke, smoke.creator.publicKey),
      ),
    ).rejects.toThrow(customError(ERR.VetoWindowOpen));
  }, 60_000);

  it("anyone may crank it once the window closes", async () => {
    // Permissionless on purpose: if settle required the adjudicator, a lost
    // or unresponsive key would strand every redemption on the market.
    const { smoke, program, vetoEndsAt } = await attested();
    warpClockTo(smoke.ctx, vetoEndsAt);

    const stranger = smoke.user; // neither authority nor dispute_authority
    const asStranger = anchorProgram(smoke.ctx, stranger);
    await sendTx(
      smoke.ctx,
      [stranger],
      await settleTx(asStranger, smoke, stranger.publicKey),
    );

    const market = await fetchMarket(program, smoke);
    expect(market.lifecycle).toHaveProperty("settled");
    expect(market.winningOutcome).toBe(OUTCOME_YES);
  }, 60_000);

  it("cannot settle a market that was never attested", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );
    warpClockTo(smoke.ctx, BigInt(DEADLINE + 1));
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await settleTx(program, smoke, smoke.creator.publicKey),
      ),
    ).rejects.toThrow(customError(ERR.NotYetAttested));
  }, 60_000);

  it("is one-shot", async () => {
    const { smoke, program, vetoEndsAt } = await attested();
    warpClockTo(smoke.ctx, vetoEndsAt);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await settleTx(program, smoke, smoke.creator.publicKey),
    );
    // Settled → Settled is not a legal transition.
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await settleTx(program, smoke, smoke.creator.publicKey),
      ),
    ).rejects.toThrow(customError(ERR.InvalidLifecycleTransition));
  }, 60_000);
});

describe("veto_period_secs is configuration, not a build flag", () => {
  // The window has to be tunable per deployment: localnet e2e resolves and
  // redeems inside one test run, devnet wants the real 24h. Doing that with a
  // cargo feature would mean the binary under test is not the binary deployed
  // — so it lives in ProtocolConfig and the same artifact ships everywhere.

  it("rejects zero — a missing arg must not silently disable the veto", async () => {
    // The Anchor client encodes an OMITTED i64 as 0. Before this guard,
    // forgetting `vetoPeriodSecs` produced a protocol with no veto window at
    // all: dispute permanently closed, settle immediate — the exact collapsed
    // behaviour this split removes, reintroduced by a typo. Deployments that
    // want no delay pass 1 second and say so.
    //
    // This is not hypothetical: tests/create-market.test.ts and both seed
    // scripts were all omitting the field, and every one of them was silently
    // getting a zero window until this guard turned it into a hard failure.
    await expect(bootSmoke({ vetoPeriodSecs: 0 })).rejects.toThrow(
      customError(ERR.InvalidVetoPeriod),
    );
  }, 60_000);

  it("one second is legal — the escape hatch for localnet", async () => {
    const smoke = await bootSmoke({ vetoPeriodSecs: 1 });
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
    const entry = await fetchEntry(program, smoke);
    warpClockTo(smoke.ctx, BigInt(entry.attestedAt.toString()) + 1n);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await settleTx(program, smoke, smoke.creator.publicKey),
    );
    expect((await fetchMarket(program, smoke)).lifecycle).toHaveProperty(
      "settled",
    );
  }, 60_000);

  it("rejects a negative window at initialize_protocol", async () => {
    // Negative would put veto_ends_at before attested_at, making settle
    // callable before the attestation it finalizes.
    await expect(bootSmoke({ vetoPeriodSecs: -1 })).rejects.toThrow(
      customError(ERR.InvalidVetoPeriod),
    );
  }, 60_000);

  it("rejects a window beyond the 30-day bound", async () => {
    // An unbounded window strands every redemption behind a settle that can
    // never be called.
    await expect(
      bootSmoke({ vetoPeriodSecs: 30 * 24 * 60 * 60 + 1 }),
    ).rejects.toThrow(customError(ERR.InvalidVetoPeriod));
  }, 60_000);
});

describe("dispute — the veto branch, now reachable", () => {
  // Every test in this block was impossible to write before the attest/settle
  // split: dispute could only ever return MarketAlreadySettled (after attest)
  // or NotYetAttested (before it).
  async function attested(outcome = OUTCOME_YES) {
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
      await attestTx(program, smoke, smoke.creator.publicKey, outcome),
    );
    const entry = await fetchEntry(program, smoke);
    const attestedAt = BigInt(entry.attestedAt.toString());
    return { smoke, program, vetoEndsAt: attestedAt + VETO_PERIOD_SECS };
  }

  it("REJECTS the ruling: attestation cleared, market handed back", async () => {
    // The veto is a court of appeal, not a court: it can throw a ruling out,
    // never write its own. The guardian's claim rides the event only.
    const { smoke, program } = await attested(OUTCOME_YES);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await disputeTx(program, smoke, smoke.creator.publicKey, OUTCOME_INVALID),
    );

    const entry = await fetchEntry(program, smoke);
    expect(entry.attestedOutcome).toBeNull();
    expect(entry.attestedAt).toBeNull();
    expect(entry.disputed).toBe(true);
    expect(entry.disputedAt).not.toBeNull();
    expect(entry.disputeCount).toBe(1);

    // A veto changes the outcome, not the lifecycle.
    expect((await fetchMarket(program, smoke)).lifecycle).toHaveProperty(
      "locked",
    );
  }, 60_000);

  it("after a veto, settle waits for a fresh ruling — and finalizes THAT", async () => {
    // The whole re-resolution loop: rule YES, veto, rule NO, settle NO. The
    // second ruling gets its own veto window, measured from itself.
    const { smoke, program } = await attested(OUTCOME_YES);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await disputeTx(program, smoke, smoke.creator.publicKey, OUTCOME_NO),
    );
    // Cleared: settle must refuse right now.
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await settleTx(
          anchorProgram(smoke.ctx, smoke.user),
          smoke,
          smoke.user.publicKey,
        ),
      ),
    ).rejects.toThrow(customError(ERR.NotYetAttested));
    // Re-rule NO.
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_NO),
    );
    const entry = await fetchEntry(program, smoke);
    const reAttestedAt = BigInt(entry.attestedAt.toString());
    warpClockTo(smoke.ctx, reAttestedAt + VETO_PERIOD_SECS);
    await sendTx(
      smoke.ctx,
      [smoke.user],
      await settleTx(
        anchorProgram(smoke.ctx, smoke.user),
        smoke,
        smoke.user.publicKey,
      ),
    );
    expect((await fetchMarket(program, smoke)).winningOutcome).toBe(OUTCOME_NO);
  }, 60_000);

  it("refuses once the window has closed", async () => {
    const { smoke, program, vetoEndsAt } = await attested();
    warpClockTo(smoke.ctx, vetoEndsAt);
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
    ).rejects.toThrow(customError(ERR.VetoWindowClosed));
  }, 60_000);

  it("is still open one second before the deadline", async () => {
    // Boundary from the other side, so the window is pinned closed-open
    // rather than approximately right.
    const { smoke, program, vetoEndsAt } = await attested();
    warpClockTo(smoke.ctx, vetoEndsAt - 1n);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await disputeTx(program, smoke, smoke.creator.publicKey, OUTCOME_INVALID),
    );
    expect((await fetchEntry(program, smoke)).disputed).toBe(true);
  }, 60_000);

  it("caps at MAX_DISPUTES — the guardian cannot filibuster forever", async () => {
    const { smoke, program } = await attested();
    for (let round = 0; round < 3; round += 1) {
      await sendTx(
        smoke.ctx,
        [smoke.creator],
        await disputeTx(program, smoke, smoke.creator.publicKey, OUTCOME_INVALID),
      );
      await sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestTx(program, smoke, smoke.creator.publicKey, OUTCOME_YES),
      );
    }
    expect((await fetchEntry(program, smoke)).disputeCount).toBe(3);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await disputeTx(program, smoke, smoke.creator.publicKey, OUTCOME_NO),
      ),
    ).rejects.toThrow(customError(ERR.TooManyDisputes));
  }, 60_000);

  it("rejects a signer that is not the dispute_authority", async () => {
    const { smoke } = await attested();
    const asUser = anchorProgram(smoke.ctx, smoke.user);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        await disputeTx(asUser, smoke, smoke.user.publicKey, OUTCOME_INVALID),
      ),
    ).rejects.toThrow(customError(ERR.Unauthorized));
  }, 60_000);

  it("still refuses after settlement", async () => {
    // Once settled, MarketAlreadySettled is the guard a dispute hits.
    const { smoke, program, vetoEndsAt } = await attested();
    warpClockTo(smoke.ctx, vetoEndsAt);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await settleTx(program, smoke, smoke.creator.publicKey),
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
    ).rejects.toThrow(customError(ERR.MarketAlreadySettled));
  }, 60_000);

  it("refuses before any attestation", async () => {
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
});

describe("attest_vote — M-of-N committee ruling", () => {
  it("two of three agreeing ballots write the attestation; the market settles on it", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );

    // Convene the committee: creator (entry authority) + user + a third key.
    const third = Keypair.generate();
    smoke.ctx.setAccount(third.publicKey, {
      lamports: 1_000_000_000,
      data: new Uint8Array(0),
      owner: SystemProgram.programId,
      executable: false,
    });
    const attestorSetPda = PublicKey.findProgramAddressSync(
      [Buffer.from("attestors"), smoke.marketPda.toBuffer()],
      smoke.programs.soothCore,
    )[0];
    const update = async (action: number, key: PublicKey, value = 0) =>
      sendTx(
        smoke.ctx,
        [smoke.creator],
        new Transaction().add(
          await program.methods
            .attestorUpdate(action, key, value)
            .accounts({
              adjudicatorEntry: entryPda(smoke),
              attestorSet: attestorSetPda,
              authority: smoke.creator.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ),
      );
    await update(0, smoke.creator.publicKey);
    await update(0, smoke.user.publicKey);
    await update(0, third.publicKey);
    await update(2, PublicKey.default, 2); // threshold 2-of-3

    const vote = async (signer: Keypair, outcome: number) =>
      sendTx(
        smoke.ctx,
        [signer],
        new Transaction().add(
          await anchorProgram(smoke.ctx, signer)
            .methods.attestVote(outcome)
            .accounts({
              market: smoke.marketPda,
              adjudicatorEntry: entryPda(smoke),
              attestorSet: attestorSetPda,
              voter: signer.publicKey,
            })
            .instruction(),
        ),
      );

    // One ballot: not attested yet.
    await vote(smoke.creator, OUTCOME_YES);
    expect((await fetchEntry(program, smoke)).attestedOutcome).toBeNull();
    // A disagreeing ballot doesn't help.
    await vote(smoke.user, OUTCOME_NO);
    expect((await fetchEntry(program, smoke)).attestedOutcome).toBeNull();
    // The second agreeing ballot writes the attestation.
    await vote(third, OUTCOME_YES);
    const entry = await fetchEntry(program, smoke);
    expect(entry.attestedOutcome).toBe(OUTCOME_YES);
    expect(entry.attestedAt).not.toBeNull();

    // Downstream is indistinguishable from a single-key ruling: settle works.
    const attestedAt = BigInt(entry.attestedAt.toString());
    warpClockTo(smoke.ctx, attestedAt + VETO_PERIOD_SECS);
    await sendTx(
      smoke.ctx,
      [smoke.user],
      await settleTx(
        anchorProgram(smoke.ctx, smoke.user),
        smoke,
        smoke.user.publicKey,
      ),
    );
    expect((await fetchMarket(program, smoke)).winningOutcome).toBe(OUTCOME_YES);
  }, 60_000);

  it("a non-member ballot is refused", async () => {
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );
    const attestorSetPda = PublicKey.findProgramAddressSync(
      [Buffer.from("attestors"), smoke.marketPda.toBuffer()],
      smoke.programs.soothCore,
    )[0];
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await program.methods
          .attestorUpdate(0, smoke.creator.publicKey, 0)
          .accounts({
            adjudicatorEntry: entryPda(smoke),
            attestorSet: attestorSetPda,
            authority: smoke.creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ),
    );
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await program.methods
          .attestorUpdate(2, PublicKey.default, 1)
          .accounts({
            adjudicatorEntry: entryPda(smoke),
            attestorSet: attestorSetPda,
            authority: smoke.creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ),
    );
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.user],
        new Transaction().add(
          await anchorProgram(smoke.ctx, smoke.user)
            .methods.attestVote(OUTCOME_YES)
            .accounts({
              market: smoke.marketPda,
              adjudicatorEntry: entryPda(smoke),
              attestorSet: attestorSetPda,
              voter: smoke.user.publicKey,
            })
            .instruction(),
        ),
      ),
    ).rejects.toThrow(customError(ERR.GuardianNotFound));
  }, 60_000);
});
