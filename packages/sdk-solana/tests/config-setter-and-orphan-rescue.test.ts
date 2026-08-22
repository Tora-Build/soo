// The two halves of the "funds permanently locked" fix, on LiteSVM.
//
// The bug: `ProtocolConfig.permissionless_adjudicators` was written once by
// `initialize_protocol` and no instruction could change it. Devnet had it
// false, the UI's create flow never called `register_adjudicator`, and the
// markets that resulted had no `AdjudicatorEntry` at all — so nothing could
// attest, nothing could settle, and every position, LP stake and escrow in
// them was immobile. The escape hatch could not help, because it too required
// an entry to already exist.
//
// This file covers, end to end against the built program:
//
//   - `update_protocol_config` changes the flag, and only the authority may
//     call it;
//   - once flipped, a creator self-registers on a market that is ALREADY
//     TRADING — the retroactive rescue for markets already on chain;
//   - `force_invalid_attestation` rescues a market with NO entry at all,
//     creating one, on exactly the same timeout it always enforced;
//   - the entry the hatch creates grants nobody the right to resolve.
//
// The two-step authority handover is here too: a lost authority key with no
// transfer path is the same permanent lock in a different field.

import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  deriveAdjudicatorEntryPda,
  deriveProtocolConfigPda,
} from "../src/pdas.js";
import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/index.js";
import { bootSmoke, warpClockTo, type SmokeContext } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";
import { anchorProgram, sendTx } from "./fixtures/orderbook.js";

const OUTCOME_YES = 1;
const OUTCOME_INVALID = 2;
const VETO_PERIOD_SECS = 24n * 60n * 60n;
/// Mirrors `settle::ABANDONED_MARKET_TIMEOUT_SECS`.
const ABANDONED_TIMEOUT_SECS = 14n * 24n * 60n * 60n;

/// Every field of `UpdateProtocolConfigArgs` as `None`. Anchor encodes a
/// missing key as `undefined`, not as the Option's `None` byte, so the whole
/// shape has to be present on every call.
interface ConfigChanges {
  permissionlessAdjudicators: boolean | null;
  treasury: PublicKey | null;
  ammFeeBps: number | null;
  bookFeeBps: number | null;
  graduationBps: number | null;
  bBaseShareBps: number | null;
  lpYieldShareBps: number | null;
  adjudicatorShareBps: number | null;
  protocolShareBps: number | null;
  defaultTrialPeriod: unknown | null;
  vetoPeriodSecs: unknown | null;
}

const NO_CHANGES: ConfigChanges = {
  permissionlessAdjudicators: null,
  treasury: null,
  ammFeeBps: null,
  bookFeeBps: null,
  graduationBps: null,
  bBaseShareBps: null,
  lpYieldShareBps: null,
  adjudicatorShareBps: null,
  protocolShareBps: null,
  defaultTrialPeriod: null,
  vetoPeriodSecs: null,
};

function configPda(smoke: SmokeContext) {
  return deriveProtocolConfigPda(smoke.programs)[0];
}

function entryPda(smoke: SmokeContext) {
  return deriveAdjudicatorEntryPda(smoke.marketPda, smoke.programs)[0];
}

async function updateConfig(
  smoke: SmokeContext,
  signer: Keypair,
  changes: Partial<ConfigChanges>,
) {
  const program = anchorProgram(smoke.ctx, signer);
  await sendTx(
    smoke.ctx,
    [signer],
    new Transaction().add(
      await program.methods
        .updateProtocolConfig({ ...NO_CHANGES, ...changes })
        .accounts({ config: configPda(smoke), authority: signer.publicKey })
        .instruction(),
    ),
  );
}

async function readConfig(smoke: SmokeContext) {
  const program = anchorProgram(smoke.ctx, smoke.creator);
  return await (program.account as any).protocolConfig.fetch(configPda(smoke));
}

async function registerAdjudicator(
  smoke: SmokeContext,
  signer: Keypair,
  authority: PublicKey,
) {
  const program = anchorProgram(smoke.ctx, signer);
  await sendTx(
    smoke.ctx,
    [signer],
    new Transaction().add(
      await program.methods
        .registerAdjudicator(authority)
        .accounts({
          adjudicatorEntry: entryPda(smoke),
          market: smoke.marketPda,
          protocolConfig: configPda(smoke),
          signer: signer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ),
  );
}

async function requestLock(smoke: SmokeContext) {
  const program = anchorProgram(smoke.ctx, smoke.user);
  await sendTx(
    smoke.ctx,
    [smoke.user],
    new Transaction().add(
      await program.methods
        .requestLock()
        .accounts({
          adjudicatorEntry: entryPda(smoke),
          market: smoke.marketPda,
          authority: smoke.user.publicKey,
        })
        .instruction(),
    ),
  );
}

async function forceInvalid(smoke: SmokeContext) {
  const program = anchorProgram(smoke.ctx, smoke.user);
  await sendTx(
    smoke.ctx,
    [smoke.user],
    new Transaction().add(
      await program.methods
        .forceInvalidAttestation()
        .accounts({
          market: smoke.marketPda,
          adjudicatorEntry: entryPda(smoke),
          cranker: smoke.user.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ),
  );
}

async function settle(smoke: SmokeContext) {
  const program = anchorProgram(smoke.ctx, smoke.user);
  await sendTx(
    smoke.ctx,
    [smoke.user],
    new Transaction().add(
      await program.methods
        .settle()
        .accounts({
          market: smoke.marketPda,
          adjudicatorEntry: entryPda(smoke),
          protocolConfig: configPda(smoke),
          cranker: smoke.user.publicKey,
        })
        .instruction(),
    ),
  );
}

/// The devnet shape exactly: permissioned adjudicators, and a market that
/// reached the chain without one.
async function orphaned() {
  const smoke = await bootSmoke({
    permissionlessAdjudicators: false,
    skipRegisterAdjudicator: true,
  });
  const program = anchorProgram(smoke.ctx, smoke.creator);
  const market = await (program.account as any).market.fetch(smoke.marketPda);
  return { smoke, program, deadline: BigInt(market.deadline.toString()) };
}

describe("update_protocol_config", () => {
  it("flips the flag that bricked devnet", async () => {
    const { smoke } = await orphaned();
    expect((await readConfig(smoke)).permissionlessAdjudicators).toBe(false);

    // `creator` is the protocol authority in this fixture.
    await updateConfig(smoke, smoke.creator, {
      permissionlessAdjudicators: true,
    });
    expect((await readConfig(smoke)).permissionlessAdjudicators).toBe(true);
  });

  it("is refused to anyone but the config authority", async () => {
    const { smoke } = await orphaned();
    await expect(
      updateConfig(smoke, smoke.user, { permissionlessAdjudicators: true }),
    ).rejects.toThrow();
    expect((await readConfig(smoke)).permissionlessAdjudicators).toBe(false);
  });

  it("leaves every field the caller did not name", async () => {
    // The sparse shape's whole point: a one-field change must not clobber the
    // other nine with a stale read.
    const { smoke } = await orphaned();
    const before = await readConfig(smoke);
    await updateConfig(smoke, smoke.creator, {
      permissionlessAdjudicators: true,
    });
    const after = await readConfig(smoke);
    expect(after.ammFeeBps).toBe(before.ammFeeBps);
    expect(after.bookFeeBps).toBe(before.bookFeeBps);
    expect(after.treasury.toBase58()).toBe(before.treasury.toBase58());
    expect(after.vetoPeriodSecs.toString()).toBe(
      before.vetoPeriodSecs.toString(),
    );
    expect(after.authority.toBase58()).toBe(before.authority.toBase58());
  });

  it("will not let the authority raise a taker fee to a rug", async () => {
    // `initialize_protocol` accepts up to 10 000 bps. The setter runs against
    // live collateral and stops at MAX_UPDATABLE_FEE_BPS = 1 000.
    const { smoke } = await orphaned();
    await expect(
      updateConfig(smoke, smoke.creator, { ammFeeBps: 5_000 }),
    ).rejects.toThrow();
    await updateConfig(smoke, smoke.creator, { ammFeeBps: 1_000 });
    expect((await readConfig(smoke)).ammFeeBps).toBe(1_000);
  });

  it("refuses a fee split that stops summing to 10 000", async () => {
    const { smoke } = await orphaned();
    await expect(
      updateConfig(smoke, smoke.creator, { protocolShareBps: 2_000 }),
    ).rejects.toThrow();
    await updateConfig(smoke, smoke.creator, {
      bBaseShareBps: 4_000,
      lpYieldShareBps: 4_000,
      adjudicatorShareBps: 1_000,
      protocolShareBps: 1_000,
    });
    expect((await readConfig(smoke)).lpYieldShareBps).toBe(4_000);
  });
});

async function transferAuthority(
  smoke: SmokeContext,
  signer: Keypair,
  newAuthority: PublicKey,
) {
  const program = anchorProgram(smoke.ctx, signer);
  await sendTx(
    smoke.ctx,
    [signer],
    new Transaction().add(
      await program.methods
        .transferAuthority(newAuthority)
        .accounts({ config: configPda(smoke), authority: signer.publicKey })
        .instruction(),
    ),
  );
}

async function acceptAuthority(smoke: SmokeContext, nominee: Keypair) {
  const program = anchorProgram(smoke.ctx, nominee);
  await sendTx(
    smoke.ctx,
    [nominee],
    new Transaction().add(
      await program.methods
        .acceptAuthority()
        .accounts({ config: configPda(smoke), newAuthority: nominee.publicKey })
        .instruction(),
    ),
  );
}

describe("protocol authority handover", () => {
  it("is refused when no nomination is in flight", async () => {
    const { smoke } = await orphaned();
    await expect(acceptAuthority(smoke, smoke.user)).rejects.toThrow();
  });

  it("moves nothing until the nominee signs", async () => {
    const { smoke } = await orphaned();
    await transferAuthority(smoke, smoke.creator, smoke.user.publicKey);

    const cfg = await readConfig(smoke);
    expect(cfg.pendingAuthority.toBase58()).toBe(
      smoke.user.publicKey.toBase58(),
    );
    expect(cfg.authority.toBase58()).toBe(smoke.creator.publicKey.toBase58());
    // The outgoing key still governs, which is the point of the second step:
    // a nomination to a typo'd address is withdrawable rather than fatal.
    await updateConfig(smoke, smoke.creator, {
      permissionlessAdjudicators: true,
    });
    await expect(
      updateConfig(smoke, smoke.user, { ammFeeBps: 7 }),
    ).rejects.toThrow();
  });

  it("hands the seat over once the nominee accepts, and only to the nominee", async () => {
    const { smoke } = await orphaned();
    await transferAuthority(smoke, smoke.creator, smoke.user.publicKey);
    // Not even the OUTGOING authority can accept on the nominee's behalf.
    await expect(acceptAuthority(smoke, smoke.creator)).rejects.toThrow();

    await acceptAuthority(smoke, smoke.user);
    const cfg = await readConfig(smoke);
    expect(cfg.authority.toBase58()).toBe(smoke.user.publicKey.toBase58());
    // One-shot: the nomination is spent, not left armed for a replay after a
    // later handover moves the seat somewhere else.
    expect(cfg.pendingAuthority.toBase58()).toBe(PublicKey.default.toBase58());

    // The setter moved with it.
    await expect(
      updateConfig(smoke, smoke.creator, { ammFeeBps: 7 }),
    ).rejects.toThrow();
    await updateConfig(smoke, smoke.user, { ammFeeBps: 7 });
    expect((await readConfig(smoke)).ammFeeBps).toBe(7);
  });

  it("withdraws a nomination when handed the default pubkey", async () => {
    const { smoke } = await orphaned();
    await transferAuthority(smoke, smoke.creator, smoke.user.publicKey);
    await transferAuthority(smoke, smoke.creator, PublicKey.default);
    expect((await readConfig(smoke)).pendingAuthority.toBase58()).toBe(
      PublicKey.default.toBase58(),
    );
    await expect(acceptAuthority(smoke, smoke.user)).rejects.toThrow();
  });
});

describe("retroactive registration", () => {
  it("works on a market that is already trading, once the flag is flipped", async () => {
    // The un-brick path for the markets already on devnet:
    // `register_adjudicator` carries no lifecycle gate, so the creator may
    // register on a live `Open` market the moment the flag allows it.
    const { smoke } = await orphaned();
    // In permissioned mode only `config.authority` may register — the fixture
    // happens to seat that on `creator`, so the stranger is what shows the
    // gate. Devnet's authority is a different key from every market creator,
    // which is exactly why nothing ever registered there.
    await expect(
      registerAdjudicator(smoke, smoke.user, smoke.user.publicKey),
    ).rejects.toThrow();

    await updateConfig(smoke, smoke.creator, {
      permissionlessAdjudicators: true,
    });
    await registerAdjudicator(smoke, smoke.creator, smoke.creator.publicKey);

    const program = anchorProgram(smoke.ctx, smoke.creator);
    const entry = await (program.account as any).adjudicatorEntry.fetch(
      entryPda(smoke),
    );
    expect(entry.authority.toBase58()).toBe(smoke.creator.publicKey.toBase58());
    const market = await (program.account as any).market.fetch(smoke.marketPda);
    expect(market.lifecycle).toEqual({ open: {} });
  });

  it("works on a market that is already locked, and that market then settles", async () => {
    // The harder half of the same rescue: a market whose deadline has passed
    // and which is sitting in `Locked` still accepts a late registration, and
    // the ordinary attest → veto → settle runs from there.
    const { smoke, deadline } = await orphaned();
    await updateConfig(smoke, smoke.creator, {
      permissionlessAdjudicators: true,
    });
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);
    await registerAdjudicator(smoke, smoke.creator, smoke.creator.publicKey);

    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await program.methods
          .attestOutcome(OUTCOME_YES)
          .accounts({
            adjudicatorEntry: entryPda(smoke),
            market: smoke.marketPda,
            authority: smoke.creator.publicKey,
          })
          .instruction(),
      ),
    );
    warpClockTo(smoke.ctx, deadline + VETO_PERIOD_SECS + 1n);
    await settle(smoke);
    const market = await (program.account as any).market.fetch(smoke.marketPda);
    expect(market.winningOutcome).toBe(OUTCOME_YES);
  });

  it("is still refused to a stranger in permissionless mode", async () => {
    // Permissionless means "the market's CREATOR", not "anyone".
    const { smoke } = await orphaned();
    await updateConfig(smoke, smoke.creator, {
      permissionlessAdjudicators: true,
    });
    await expect(
      registerAdjudicator(smoke, smoke.user, smoke.user.publicKey),
    ).rejects.toThrow();
  });
});

describe("the escape hatch on a market with no adjudicator entry", () => {
  it("locks without one, and refuses to force before the timeout", async () => {
    const { smoke, deadline } = await orphaned();
    // `request_lock` no longer requires the entry — it is the first step of
    // the rescue, and demanding an entry it does not have was the last thing
    // keeping this market's funds immobile.
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);

    // Everything is in place except the wait. An orphaned market gets exactly
    // the same fourteen days as an abandoned one.
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS - 1n);
    await expect(forceInvalid(smoke)).rejects.toThrow();
    // And nothing was created on the way to the refusal: the whole
    // transaction reverts, so the rescue cannot be used to conjure an entry
    // one timeout early.
    expect(
      (smoke.ctx.svm.getAccount(entryPda(smoke).toBase58() as any) as any)
        ?.exists,
    ).toBe(false);
  });

  it("creates the entry and forces INVALID the second the timeout lands", async () => {
    const { smoke, program, deadline } = await orphaned();
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS);
    await forceInvalid(smoke);

    const entry = await (program.account as any).adjudicatorEntry.fetch(
      entryPda(smoke),
    );
    expect(entry.attestedOutcome).toBe(OUTCOME_INVALID);
    expect(entry.forcedInvalid).toBe(true);
    expect(entry.market.toBase58()).toBe(smoke.marketPda.toBase58());
    // The entry names NOBODY. That is the whole abuse answer: creating it
    // hands out no resolution right, to the cranker or to anyone else.
    expect(entry.authority.toBase58()).toBe(PublicKey.default.toBase58());
    expect(entry.disputeAuthority.toBase58()).toBe(
      PublicKey.default.toBase58(),
    );
    expect(entry.zkComparator).toBe(0);

    // Forcing is not settling: the veto window still has to run.
    await expect(settle(smoke)).rejects.toThrow();
    const attestedAt = BigInt(entry.attestedAt.toString());
    warpClockTo(smoke.ctx, attestedAt + VETO_PERIOD_SECS);
    await settle(smoke);
    const market = await (program.account as any).market.fetch(smoke.marketPda);
    expect(market.winningOutcome).toBe(OUTCOME_INVALID);
  });

  it("does not let the created entry be used to attest an arbitrary outcome", async () => {
    // The attack the default-pubkey sentinel exists to stop: a creator who
    // never registers an adjudicator, waits out the timeout, cranks the hatch
    // and then attests YES over the forced INVALID would be paying themselves
    // out of the losing side. Nobody can attest here, so INVALID stands and
    // every holder takes the split.
    const { smoke, deadline } = await orphaned();
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS);
    await forceInvalid(smoke);

    for (const signer of [smoke.creator, smoke.user]) {
      const program = anchorProgram(smoke.ctx, signer);
      await expect(
        (async () => {
          const ix = await program.methods
            .attestOutcome(OUTCOME_YES)
            .accounts({
              adjudicatorEntry: entryPda(smoke),
              market: smoke.marketPda,
              authority: signer.publicKey,
            })
            .instruction();
          await sendTx(smoke.ctx, [signer], new Transaction().add(ix));
        })(),
      ).rejects.toThrow();
    }

    // Registration cannot reclaim it either: the PDA now holds an account, so
    // `register_adjudicator`'s `init` fails.
    await updateConfig(smoke, smoke.creator, {
      permissionlessAdjudicators: true,
    });
    await expect(
      registerAdjudicator(smoke, smoke.creator, smoke.creator.publicKey),
    ).rejects.toThrow();
  });

  it("cannot be fired twice on the market it already rescued", async () => {
    const { smoke, deadline } = await orphaned();
    warpClockTo(smoke.ctx, deadline);
    await requestLock(smoke);
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS);
    await forceInvalid(smoke);
    // A second call sees an attested entry — no way to keep restarting the
    // veto window.
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS + 100n);
    await expect(forceInvalid(smoke)).rejects.toThrow();
  });

  it("still refuses a market that is only Open", async () => {
    const { smoke, deadline } = await orphaned();
    warpClockTo(smoke.ctx, deadline + ABANDONED_TIMEOUT_SECS);
    // No `request_lock`: the market is past every clock but still Open, and
    // writing an outcome onto a market that has not stopped trading is the
    // same fault whether or not it has an entry.
    await expect(forceInvalid(smoke)).rejects.toThrow();
  });
});

describe("the SDK builders for the new instructions", () => {
  // Shapes only. A builder can typecheck, look wired, and name an
  // instruction the bundled IDL does not have — the failure then arrives at
  // the moment somebody clicks the button.
  function adapterFor(smoke: SmokeContext) {
    return new SolanaChainAdapter({
      node: {
        id: "config-setter-shape",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://localhost:8899",
      },
      programIds: smoke.programs,
      bookMint: smoke.usdcMint,
      ammMint: smoke.ammMint,
      connection: new LiteSvmConnection(smoke.ctx),
    });
  }

  const meta = (req: { meta?: unknown }) =>
    req.meta as { operation?: string; ixKeys?: Array<{ pubkey: string }> };

  it("build the four instructions this fix adds", async () => {
    const { smoke } = await orphaned();
    const adapter = adapterFor(smoke);
    const authority = encodePubkeyRef(smoke.creator.publicKey);
    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);

    const update = await adapter.buildUpdateProtocolConfig({
      authority,
      permissionlessAdjudicators: true,
    });
    expect(meta(update).operation).toBe("updateProtocolConfig");
    expect(meta(update).ixKeys?.map((k) => k.pubkey)).toContain(
      configPda(smoke).toBase58(),
    );

    const transfer = await adapter.buildTransferAuthority({
      authority,
      newAuthority: userRef,
    });
    expect(meta(transfer).operation).toBe("transferAuthority");

    const accept = await adapter.buildAcceptAuthority({
      newAuthority: userRef,
    });
    expect(meta(accept).operation).toBe("acceptAuthority");

    const register = await adapter.buildRegisterAdjudicator(marketRef, {
      user: authority,
      authority,
    });
    expect(meta(register).operation).toBe("registerAdjudicator");
    expect(meta(register).ixKeys?.map((k) => k.pubkey)).toContain(
      entryPda(smoke).toBase58(),
    );

    const force = await adapter.buildForceInvalidAttestation(marketRef, {
      user: userRef,
    });
    expect(meta(force).operation).toBe("forceInvalidAttestation");
    const forceKeys = meta(force).ixKeys ?? [];
    expect(forceKeys.map((k) => k.pubkey)).toContain(
      SystemProgram.programId.toBase58(),
    );
    // The cranker funds the entry when the market never had one, so it has to
    // be writable — a read-only signer would fail on exactly the markets the
    // hatch exists to rescue.
    const cranker = forceKeys.find(
      (k) => k.pubkey === smoke.user.publicKey.toBase58(),
    ) as { isWritable?: boolean } | undefined;
    expect(cranker?.isWritable).toBe(true);
  });

  it("build an update the program actually accepts", async () => {
    // The builder's encoding, executed. A sparse Option encoded wrong is not
    // a shape error — it is a silently different config.
    const { smoke } = await orphaned();
    const adapter = adapterFor(smoke);
    const req = await adapter.buildUpdateProtocolConfig({
      authority: encodePubkeyRef(smoke.creator.publicKey),
      permissionlessAdjudicators: true,
      ammFeeBps: 250,
    });
    const m = req.meta as { ixData: string; ixKeys: Array<any>; ixProgramId: string };
    const ix = new TransactionInstruction({
      programId: new PublicKey(m.ixProgramId),
      keys: m.ixKeys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: !!k.isSigner,
        isWritable: !!k.isWritable,
      })),
      data: Buffer.from(m.ixData, "base64"),
    });
    await sendTx(smoke.ctx, [smoke.creator], new Transaction().add(ix));

    const cfg = await readConfig(smoke);
    expect(cfg.permissionlessAdjudicators).toBe(true);
    expect(cfg.ammFeeBps).toBe(250);
    // The field the caller did not name is untouched, through the builder as
    // well as through the program.
    expect(cfg.bookFeeBps).toBe(100);
  });
});
