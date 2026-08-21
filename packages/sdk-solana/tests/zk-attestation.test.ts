// Trustless adjudication: register a zk attestor → lock → submit a signed
// Primus attestation → outcome recorded, market still unsettled.
//
// Exercised against the real instructions on LiteSVM. The attestation is
// signed here with a locally generated secp256k1 key — no Primus network is
// involved, and the program recovers the signer from the bytes it re-encodes
// itself.
//
// `encodeAttestation` is duplicated below rather than imported because that
// is the point: if the SDK and the program shared an encoder, a bug in it
// would cancel out and the test would pass. This copy is written from
// `PrimusZKTLS.sol`, and Rust's copy is checked against an ethers-generated
// golden vector in `zk/primus.rs`.
//
// Attest still does NOT settle — the veto window and permissionless `settle`
// remain the only finalization path, so `dispute` stays the recourse against
// a bad attestation. The last block pins that.
import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import { SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";

import {
  deriveAdjudicatorEntryPda,
  deriveProtocolConfigPda,
} from "../src/pdas.js";
import { SolanaChainAdapter } from "../src/adapter.js";
import soothCoreIdl from "../src/anchor/sooth_core.json" assert { type: "json" };
import { computeRuleHash, ZK_COMPARATOR } from "../src/zk.js";
import {
  bootSmoke,
  warpClockTo,
  type SmokeContext,
} from "./fixtures/setup.js";
import { anchorProgram, customError, sendTx } from "./fixtures/orderbook.js";

const OUTCOME_NO = 0;
const OUTCOME_YES = 1;
const OUTCOME_INVALID = 2;

/** bootSmoke's ProtocolConfig.veto_period_secs default. */
const VETO_PERIOD_SECS = 24 * 60 * 60;

const ERR = {
  ZkNotEnabled: 6072,
  ZkAttestationFieldTooLong: 6073,
  ZkInvalidSignatureV: 6074,
  ZkAttestorMismatch: 6077,
  ZkRuleHashMismatch: 6078,
  ZkResponseResolveCountInvalid: 6079,
  ZkDataUnparseable: 6080,
  ZkValuePrecisionTooHigh: 6081,
  ZkInvalidComparator: 6083,
  ZkAttestationTimestampInvalid: 6085,
} as const;

/** bootSmoke's market: created at 1_000_000, deadline +7d. */
const DEADLINE = 1_000_000 + 7 * 24 * 60 * 60;

const URL = "https://api.example.com/v1/price?symbol=BTCUSDT";
const PARSE_PATH = "$.data.price";
const KEY_NAME = "price";
const VALUE_SCALE = 6;
/** 64000.0 in 1e6 units. */
const THRESHOLD = 64_000_000_000n;

/** Locally generated attestor key, and one the market never registers. */
const ATTESTOR_KEY = new Uint8Array(32).fill(0x11);
const IMPOSTOR_KEY = new Uint8Array(32).fill(0x22);

// ── Primus encoding, from PrimusZKTLS.sol ────────────────────────────────────

interface Attestation {
  recipient: Uint8Array;
  request: { url: string; header: string; method: string; body: string };
  responseResolve: Array<{
    keyName: string;
    parseType: string;
    parsePath: string;
  }>;
  data: string;
  attConditions: string;
  timestamp: bigint;
  additionParams: string;
  attestorAddr: Uint8Array;
  attestorUrl: string;
  signature: Uint8Array;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u64be(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, false);
  return out;
}

/** `keccak256(url ‖ header ‖ method ‖ body)` — abi.encodePacked, so raw
 *  UTF-8 with no length prefixes and no padding. */
function encodeRequest(r: Attestation["request"]): Uint8Array {
  return keccak_256(
    concat(utf8(r.url), utf8(r.header), utf8(r.method), utf8(r.body)),
  );
}

function encodeResponse(rs: Attestation["responseResolve"]): Uint8Array {
  return keccak_256(
    concat(
      ...rs.flatMap((r) => [utf8(r.keyName), utf8(r.parseType), utf8(r.parsePath)]),
    ),
  );
}

/** The 32 bytes the attestor signs. Note the `Attestor[]` and `signatures[]`
 *  members of the Solidity struct are NOT covered. */
function encodeAttestation(a: Attestation): Uint8Array {
  return keccak_256(
    concat(
      a.recipient,
      encodeRequest(a.request),
      encodeResponse(a.responseResolve),
      utf8(a.data),
      utf8(a.attConditions),
      u64be(a.timestamp),
      utf8(a.additionParams),
    ),
  );
}

/** The low 20 bytes of keccak256 over the 64-byte uncompressed pubkey. */
function evmAddress(privKey: Uint8Array): Uint8Array {
  const pub = secp256k1.getPublicKey(privKey, false).slice(1);
  return keccak_256(pub).slice(12);
}

/** Signs the digest RAW — no EIP-191 prefix, matching
 *  `PrimusZKTLS.verifyAttestation`'s direct ecrecover. */
function signDigest(privKey: Uint8Array, digest: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(digest, privKey);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = sig.recovery + 27;
  return out;
}

function sign(att: Attestation, privKey: Uint8Array): Attestation {
  return {
    ...att,
    signature: signDigest(privKey, encodeAttestation(att)),
    attestorAddr: evmAddress(privKey),
  };
}

function attestation(price: string, opts: Partial<Attestation> = {}): Attestation {
  return {
    recipient: new Uint8Array(20).fill(0xaa),
    request: {
      url: URL,
      header: '{"accept":"application/json"}',
      method: "GET",
      body: "",
    },
    responseResolve: [
      { keyName: KEY_NAME, parseType: "string", parsePath: PARSE_PATH },
    ],
    data: `{"${KEY_NAME}":"${price}"}`,
    attConditions: "",
    // Seconds. The program also accepts the millisecond clock Primus mints
    // with — the two are separated by magnitude — but this fixture's deadline
    // is toy-scale (~1.6e6), far below the 1e12 point where a value can only
    // be milliseconds. `zk/verify.rs` covers the millisecond reading against
    // a realistic deadline.
    timestamp: BigInt(DEADLINE + 60),
    additionParams: "",
    attestorAddr: new Uint8Array(20),
    attestorUrl: "https://attestor.primus.test",
    signature: new Uint8Array(65),
    ...opts,
  };
}

/** The Anchor argument shape. */
function toArg(a: Attestation) {
  return {
    recipient: Array.from(a.recipient),
    request: a.request,
    responseResolve: a.responseResolve,
    data: a.data,
    attConditions: a.attConditions,
    // Anchor's Borsh coder wants a BN for `u64`, not a bigint.
    timestamp: new BN(a.timestamp.toString()),
    additionParams: a.additionParams,
    attestorAddr: Array.from(a.attestorAddr),
    attestorUrl: a.attestorUrl,
    signature: Array.from(a.signature),
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

function entryPda(smoke: SmokeContext): PublicKey {
  return deriveAdjudicatorEntryPda(smoke.marketPda, smoke.programs)[0];
}

async function fetchEntry(program: any, smoke: SmokeContext): Promise<any> {
  return (program.account as any).adjudicatorEntry.fetch(entryPda(smoke));
}

async function fetchMarket(program: any, smoke: SmokeContext): Promise<any> {
  return (program.account as any).market.fetch(smoke.marketPda);
}

async function registerZkTx(
  program: any,
  smoke: SmokeContext,
  signer: PublicKey,
  overrides: {
    attestorEvm?: Uint8Array;
    ruleHash?: Uint8Array;
    comparator?: number;
    threshold?: bigint;
    valueScale?: number;
  } = {},
) {
  const ruleHash = overrides.ruleHash ?? (await computeRuleHash(URL, PARSE_PATH));
  return new Transaction().add(
    await program.methods
      .registerZkAdjudicator({
        authority: signer,
        attestorEvm: Array.from(overrides.attestorEvm ?? evmAddress(ATTESTOR_KEY)),
        ruleHash: Array.from(ruleHash),
        comparator: overrides.comparator ?? ZK_COMPARATOR.Gt,
        threshold: new BN((overrides.threshold ?? THRESHOLD).toString()),
        valueScale: overrides.valueScale ?? VALUE_SCALE,
      })
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

async function attestZkTx(
  program: any,
  smoke: SmokeContext,
  submitter: PublicKey,
  att: Attestation,
) {
  return new Transaction().add(
    await program.methods
      .attestOutcomeZk(toArg(att))
      .accounts({
        adjudicatorEntry: entryPda(smoke),
        market: smoke.marketPda,
        submitter,
      })
      .instruction(),
  );
}

/** boot → register zk → lock. Leaves the market Locked and unattested. */
async function bootLocked(
  overrides: Parameters<typeof registerZkTx>[3] = {},
): Promise<{ smoke: SmokeContext; program: any }> {
  const smoke = await bootSmoke({ skipRegisterAdjudicator: true });
  const program = anchorProgram(smoke.ctx, smoke.creator);
  await sendTx(
    smoke.ctx,
    [smoke.creator],
    await registerZkTx(program, smoke, smoke.creator.publicKey, overrides),
  );
  await sendTx(
    smoke.ctx,
    [smoke.creator],
    await lockTx(program, smoke, smoke.creator.publicKey),
  );
  return { smoke, program };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("computeRuleHash", () => {
  // Pinned against `sooth_core::zk::value::cross_language_parity`. The two
  // implementations must agree exactly: a mismatch makes every attestation
  // for the market fail with ZkRuleHashMismatch, and nothing else would
  // catch it.
  it("matches the value the program derives", async () => {
    const hash = await computeRuleHash(URL, PARSE_PATH);
    const hex = Buffer.from(hash).toString("hex");
    expect(hex).toBe(
      "722ef544c226c7bf48ce02a0d30020e487cd784b0e1da4989d477310779b8c50",
    );
  });

  it("is length-prefixed, so the url/path boundary cannot be re-cut", async () => {
    const a = await computeRuleHash("https://x.test/ab", "c");
    const b = await computeRuleHash("https://x.test/a", "bc");
    expect(Buffer.from(a).toString("hex")).not.toBe(
      Buffer.from(b).toString("hex"),
    );
  });
});

describe("register_zk_adjudicator", () => {
  it("writes the zk config into the reserved region without resizing", async () => {
    const smoke = await bootSmoke({ skipRegisterAdjudicator: true });
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await registerZkTx(program, smoke, smoke.creator.publicKey),
    );

    const entry = await fetchEntry(program, smoke);
    expect(entry.zkComparator).toBe(ZK_COMPARATOR.Gt);
    expect(entry.zkValueScale).toBe(VALUE_SCALE);
    expect(BigInt(entry.zkThreshold.toString())).toBe(THRESHOLD);
    expect(Buffer.from(entry.zkAttestorEvm).toString("hex")).toBe(
      Buffer.from(evmAddress(ATTESTOR_KEY)).toString("hex"),
    );
    // The veto path survives: nothing human attests, but someone can still
    // override a bad attestation.
    expect(entry.disputeAuthority.toBase58()).toBe(
      smoke.creator.publicKey.toBase58(),
    );
    expect(entry.attestedOutcome).toBeNull();

    // Account length is unchanged — the zk block is carved from _reserved,
    // so no migration is needed for entries already on chain.
    const raw = await smoke.ctx.banksClient.getAccount(entryPda(smoke));
    expect(raw!.data.length).toBe(190);
  });

  it("rejects the None comparator, which would never resolve", async () => {
    const smoke = await bootSmoke({ skipRegisterAdjudicator: true });
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await registerZkTx(program, smoke, smoke.creator.publicKey, {
          comparator: ZK_COMPARATOR.None,
        }),
      ),
    ).rejects.toThrow(customError(ERR.ZkInvalidComparator));
  });
});

describe("attest_outcome_zk", () => {
  it("resolves YES when the attested value clears the threshold", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);

    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestZkTx(program, smoke, smoke.creator.publicKey, att),
    );

    const entry = await fetchEntry(program, smoke);
    expect(entry.attestedOutcome).toBe(OUTCOME_YES);
    expect(entry.attestedAt).not.toBeNull();
  });

  it("resolves NO when it does not", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("63999.5"), ATTESTOR_KEY);

    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestZkTx(program, smoke, smoke.creator.publicKey, att),
    );

    expect((await fetchEntry(program, smoke)).attestedOutcome).toBe(OUTCOME_NO);
  });

  it("is permissionless — any fee payer may submit a valid attestation", async () => {
    const { smoke, program } = await bootLocked();
    const stranger = Keypair.generate();
    smoke.ctx.svm.airdrop(
      stranger.publicKey.toBase58() as any,
      1_000_000_000n as never,
    );
    const strangerProgram = anchorProgram(smoke.ctx, stranger);
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);

    await sendTx(
      smoke.ctx,
      [stranger],
      await attestZkTx(strangerProgram, smoke, stranger.publicKey, att),
    );

    expect((await fetchEntry(program, smoke)).attestedOutcome).toBe(OUTCOME_YES);
  });

  it("rejects a signature from a key the market never registered", async () => {
    const { smoke, program } = await bootLocked();
    // A perfectly valid signature — just not the registered attestor's.
    const att = sign(attestation("64000.5"), IMPOSTOR_KEY);

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(ERR.ZkAttestorMismatch));
  });

  it("rejects a genuine signature presented beside tampered data", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("63999.5"), ATTESTOR_KEY);
    // Keep the signature, swap the value it covers for a winning one. This is
    // what re-encoding on chain defends against.
    const tampered = { ...att, data: `{"${KEY_NAME}":"99999"}` };

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, tampered),
      ),
    ).rejects.toThrow(customError(ERR.ZkAttestorMismatch));
  });

  it("rejects an attestation for a different url", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(
      attestation("64000.5", {
        request: {
          url: "https://evil.example.com/v1/price",
          header: '{"accept":"application/json"}',
          method: "GET",
          body: "",
        },
      }),
      ATTESTOR_KEY,
    );

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(ERR.ZkRuleHashMismatch));
  });

  it("rejects an attestation for a different parsePath", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(
      attestation("64000.5", {
        responseResolve: [
          { keyName: KEY_NAME, parseType: "string", parsePath: "$.data.volume" },
        ],
      }),
      ATTESTOR_KEY,
    );

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(ERR.ZkRuleHashMismatch));
  });

  it("rejects unparseable data with its own error", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(
      attestation("0", { data: `{"${KEY_NAME}":"not-a-number"}` }),
      ATTESTOR_KEY,
    );

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(ERR.ZkDataUnparseable));
  });

  it("rejects excess precision rather than truncating it", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("64000.1234567"), ATTESTOR_KEY);

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(ERR.ZkValuePrecisionTooHigh));
  });

  it("rejects an observation from before the market's deadline", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(
      attestation("64000.5", { timestamp: BigInt(DEADLINE - 1) }),
      ATTESTOR_KEY,
    );

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(ERR.ZkAttestationTimestampInvalid));
  });

  it("rejects a v byte outside {27, 28}", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);
    const bad = { ...att, signature: Uint8Array.from(att.signature) };
    bad.signature[64] = 1;

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, bad),
      ),
    ).rejects.toThrow(customError(ERR.ZkInvalidSignatureV));
  });

  it("rejects more than one responseResolve entry", async () => {
    const { smoke, program } = await bootLocked();
    const resolve = {
      keyName: KEY_NAME,
      parseType: "string",
      parsePath: PARSE_PATH,
    };
    const att = sign(
      attestation("64000.5", { responseResolve: [resolve, resolve] }),
      ATTESTOR_KEY,
    );

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(ERR.ZkResponseResolveCountInvalid));
  });

  it("cannot attest twice", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestZkTx(program, smoke, smoke.creator.publicKey, att),
    );

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(6038)); // AlreadyAttested
  });

  // Compute + transaction size are the two budgets this instruction can
  // realistically hit: the whole attestation travels as instruction data, and
  // keccak + secp256k1_recover are syscalls with real cost. Recorded rather
  // than tightly bounded — the ceiling is generous so a small encoding change
  // does not fail the suite, but a runaway one does.
  it("fits the compute and transaction budgets", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      )
      .add(
        (await attestZkTx(program, smoke, smoke.creator.publicKey, att))
          .instructions[0]!,
      );
    const bh = await smoke.ctx.banksClient.getLatestBlockhash();
    if (!bh) throw new Error("no blockhash");
    tx.recentBlockhash = bh[0];
    tx.feePayer = smoke.creator.publicKey;
    tx.sign(smoke.creator);

    const res = await smoke.ctx.banksClient.tryProcessTransaction(tx);
    expect(res.result).toBeNull();

    const cu = Number(res.meta?.computeUnitsConsumed ?? 0);
    const bytes = tx.serialize({ verifySignatures: false }).length;
    // eslint-disable-next-line no-console
    console.log(`attest_outcome_zk: cu=${cu} txBytes=${bytes}`);
    expect(cu).toBeLessThan(120_000);
    expect(bytes).toBeLessThan(1232);
  });

  // The whole safety argument rests on this: verification records an outcome
  // and stops. If it settled inline, a wrong attestation would be final and
  // `dispute` would have nothing to act on.
  it("records the outcome without settling the market", async () => {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestZkTx(program, smoke, smoke.creator.publicKey, att),
    );

    const market = await fetchMarket(program, smoke);
    expect(Object.keys(market.lifecycle)[0]).toBe("locked");
    expect((await fetchEntry(program, smoke)).disputed).toBe(false);
  });
});

// The safety net, end to end. `attest_outcome_zk` removes the attester's
// trust, not the guardian's: a wrong verdict is still catchable for the whole
// veto window, and `settle` still reads the entry rather than the caller. If
// this block ever fails, verification has become final and there is no
// recourse against a compromised attestor.
describe("the veto window still governs a zk-attested market", () => {
  async function attested(): Promise<{ smoke: SmokeContext; program: any }> {
    const { smoke, program } = await bootLocked();
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await attestZkTx(program, smoke, smoke.creator.publicKey, att),
    );
    return { smoke, program };
  }

  it("dispute can override a zk verdict inside the window", async () => {
    const { smoke, program } = await attested();
    expect((await fetchEntry(program, smoke)).attestedOutcome).toBe(OUTCOME_YES);

    await sendTx(
      smoke.ctx,
      [smoke.creator],
      new Transaction().add(
        await program.methods
          .dispute(OUTCOME_INVALID)
          .accounts({
            adjudicatorEntry: entryPda(smoke),
            market: smoke.marketPda,
            protocolConfig: deriveProtocolConfigPda(smoke.programs)[0],
            disputer: smoke.creator.publicKey,
          })
          .instruction(),
      ),
    );

    const entry = await fetchEntry(program, smoke);
    expect(entry.attestedOutcome).toBe(OUTCOME_INVALID);
    expect(entry.disputed).toBe(true);
  });

  it("settle is blocked until the window closes, then finalizes the zk verdict", async () => {
    const { smoke, program } = await attested();
    const settleTx = async () =>
      new Transaction().add(
        await program.methods
          .settle()
          .accounts({
            market: smoke.marketPda,
            adjudicatorEntry: entryPda(smoke),
            protocolConfig: deriveProtocolConfigPda(smoke.programs)[0],
            cranker: smoke.creator.publicKey,
          })
          .instruction(),
      );

    await expect(
      sendTx(smoke.ctx, [smoke.creator], await settleTx()),
    ).rejects.toThrow(customError(6058)); // VetoWindowOpen

    const entry = await fetchEntry(program, smoke);
    warpClockTo(
      smoke.ctx,
      BigInt(entry.attestedAt.toString()) + BigInt(VETO_PERIOD_SECS) + 1n,
    );
    await sendTx(smoke.ctx, [smoke.creator], await settleTx());

    const market = await fetchMarket(program, smoke);
    expect(Object.keys(market.lifecycle)[0]).toBe("settled");
    // The outcome comes from the entry, not from whoever cranked settle.
    expect(market.winningOutcome).toBe(OUTCOME_YES);
  });
});

describe("the manual path stays separate", () => {
  it("a zk-registered entry rejects manual attest_outcome from a non-authority", async () => {
    const { smoke, program } = await bootLocked();
    const stranger = Keypair.generate();
    smoke.ctx.svm.airdrop(
      stranger.publicKey.toBase58() as any,
      1_000_000_000n as never,
    );
    const strangerProgram = anchorProgram(smoke.ctx, stranger);

    await expect(
      sendTx(
        smoke.ctx,
        [stranger],
        new Transaction().add(
          await strangerProgram.methods
            .attestOutcome(OUTCOME_YES)
            .accounts({
              adjudicatorEntry: entryPda(smoke),
              market: smoke.marketPda,
              authority: stranger.publicKey,
            })
            .instruction(),
        ),
      ),
    ).rejects.toThrow(customError(6019)); // Unauthorized
  });

  it("a manually registered entry cannot be resolved through the zk path", async () => {
    // bootSmoke's default registration leaves the zk region zeroed, which is
    // what every entry already on chain looks like.
    const smoke = await bootSmoke();
    const program = anchorProgram(smoke.ctx, smoke.creator);
    await sendTx(
      smoke.ctx,
      [smoke.creator],
      await lockTx(program, smoke, smoke.creator.publicKey),
    );
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);

    await expect(
      sendTx(
        smoke.ctx,
        [smoke.creator],
        await attestZkTx(program, smoke, smoke.creator.publicKey, att),
      ),
    ).rejects.toThrow(customError(ERR.ZkNotEnabled));
  });
});

// ── SDK builders ─────────────────────────────────────────────────────────────
//
// These need no validator: both builders derive every account from the market
// ref and the program id, so nothing is read from chain. What they catch is
// the drift the LiteSVM tests above cannot — a builder naming an account or
// argument the IDL does not have fails here at build time, rather than as a
// `TypeError: ... is not a function` inside a user's click handler.

describe("zk instruction builders", () => {
  const adapter = new SolanaChainAdapter({
    node: {
      id: "t",
      chainKind: "solana",
      chainId: "solana:localnet",
      cluster: "localnet",
      rpcUrl: "http://127.0.0.1:8899",
      programs: {
        soothCore: (soothCoreIdl as { address: string }).address,
        usdcMint: new PublicKey(
          "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX",
        ).toBase58(),
      },
    },
    connection: new Connection("http://127.0.0.1:8899", "confirmed"),
  } as never);

  const market = `sol:${Keypair.generate().publicKey.toBase58()}`;
  const user = `sol:${Keypair.generate().publicKey.toBase58()}`;

  it("buildRegisterZkAdjudicator builds against the bundled IDL", async () => {
    const req = await adapter.buildRegisterZkAdjudicator(market, {
      user,
      authority: user,
      attestorEvm: `0x${Buffer.from(evmAddress(ATTESTOR_KEY)).toString("hex")}`,
      ruleHash: await computeRuleHash(URL, PARSE_PATH),
      comparator: ZK_COMPARATOR.Gt,
      threshold: THRESHOLD,
      valueScale: VALUE_SCALE,
    });
    expect((req.meta as any).operation).toBe("registerZkAdjudicator");
    expect(req.accounts?.length).toBeGreaterThan(0);
  });

  it("buildAttestOutcomeZk builds against the bundled IDL", async () => {
    const att = sign(attestation("64000.5"), ATTESTOR_KEY);
    const req = await adapter.buildAttestOutcomeZk(market, {
      user,
      attestation: {
        ...toArg(att),
        // The builder converts to BN itself, so it takes the bigint.
        timestamp: att.timestamp,
      } as never,
    });
    expect((req.meta as any).operation).toBe("attestOutcomeZk");
    expect(req.accounts?.length).toBe(3);
  });

  it("rejects a comparator that would never resolve", async () => {
    await expect(
      adapter.buildRegisterZkAdjudicator(market, {
        user,
        authority: user,
        attestorEvm: evmAddress(ATTESTOR_KEY),
        ruleHash: await computeRuleHash(URL, PARSE_PATH),
        comparator: ZK_COMPARATOR.None as never,
        threshold: THRESHOLD,
        valueScale: VALUE_SCALE,
      }),
    ).rejects.toThrow(/comparator must be one of/);
  });

  it("rejects a mis-sized attestor address or rule hash", async () => {
    const base = {
      user,
      authority: user,
      attestorEvm: evmAddress(ATTESTOR_KEY),
      ruleHash: await computeRuleHash(URL, PARSE_PATH),
      comparator: ZK_COMPARATOR.Gt,
      threshold: THRESHOLD,
      valueScale: VALUE_SCALE,
    } as const;

    await expect(
      adapter.buildRegisterZkAdjudicator(market, {
        ...base,
        attestorEvm: new Uint8Array(19),
      }),
    ).rejects.toThrow(/attestorEvm must be 20 bytes/);

    await expect(
      adapter.buildRegisterZkAdjudicator(market, {
        ...base,
        ruleHash: new Uint8Array(31),
      }),
    ).rejects.toThrow(/ruleHash must be 32 bytes/);
  });

  it("rejects a value scale the program would refuse", async () => {
    await expect(
      adapter.buildRegisterZkAdjudicator(market, {
        user,
        authority: user,
        attestorEvm: evmAddress(ATTESTOR_KEY),
        ruleHash: await computeRuleHash(URL, PARSE_PATH),
        comparator: ZK_COMPARATOR.Gt,
        threshold: THRESHOLD,
        valueScale: 19,
      }),
    ).rejects.toThrow(/valueScale must be an integer/);
  });
});
