// The question a market asked must be recoverable — and must be true.
//
// `Market` stores `question_hash: [u8; 32]` and nothing else, so the text
// exists on chain in exactly one place: the `MarketCreated` event. That makes
// the event the sole source of a market's title for any client without an
// indexer, which in turn makes it worth attacking: if a creator could store
// the hash of one question and emit the text of another, every reader would
// render a title the market does not actually resolve on.
//
// `create_market` closes that by proving `sha256(question) == question_hash`
// before emitting. These tests pin both halves — the check rejects a
// mismatch, and the bound rejects an oversized question — because a
// constraint nobody exercises is a constraint that quietly stops holding.
//
// The round trip itself (emit -> read back off the creation transaction) is
// NOT tested here: LiteSVM has no `getSignaturesForAddress` / `getTransaction`,
// so `readMarketQuestion` cannot run against it. It is verified on a live
// cluster instead — see the deploy notes in docs/develop-vs-main.md §8.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";

const { BN } = anchorPkg;

import { bootSmoke } from "./fixtures/setup.js";
import { anchorProgram, sendTx } from "./fixtures/orderbook.js";
import {
  deriveAmmStatePda,
  deriveLockAuthorityPda,
  deriveLockVaultAta,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
} from "../src/pdas.js";
import { WAD } from "../src/math/lmsr.js";

const sha256 = (t: string) =>
  Array.from(createHash("sha256").update(t, "utf8").digest());

/** Our `#[msg]` errors. Surfaced as `custom program error: 0x…`, not by name. */
const ERR = { InvalidQuestion: 6065, QuestionHashMismatch: 6066 } as const;

/** The Anchor error code a rejected transaction carried, if any. */
function codeOf(err: unknown): number | undefined {
  const m = String((err as Error)?.message ?? err).match(
    /custom program error: 0x([0-9a-f]+)/i,
  );
  return m ? parseInt(m[1], 16) : undefined;
}

/**
 * Drive `create_market` directly with a chosen (question, hash) pair — the
 * SDK builder derives the hash from the text and so cannot express a
 * mismatch, which is exactly the case the program must reject.
 */
async function createWith(question: string, questionHash: number[]) {
  const smoke = await bootSmoke({ bWad: 1_000n * WAD });
  const program = anchorProgram(smoke.ctx, smoke.creator);
  const marketId = new Uint8Array(16).fill(7);
  const { programs, usdcMint, ammMint } = smoke;
  const [marketPda] = deriveMarketPda(marketId, programs);
  const now = Math.floor(Date.now() / 1000);

  const ix = await (program.methods as any)
    .createMarket({
      marketId: Array.from(marketId),
      question,
      questionHash,
      startTime: new BN(now),
      deadline: new BN(now + 86_400),
      adjudicator: smoke.creator.publicKey,
      initialB: new BN((1_000n * WAD).toString()),
    })
    .accounts({
      config: deriveProtocolConfigPda(programs)[0],
      market: marketPda,
      ammState: deriveAmmStatePda(marketId, programs)[0],
      vaultAuthority: deriveVaultAuthorityPda(marketId, programs)[0],
      lockAuthority: deriveLockAuthorityPda(marketId, programs)[0],
      vaultBook: deriveMarketVaultAta(marketId, usdcMint, programs),
      vaultAmm: deriveMarketVaultAta(marketId, ammMint, programs),
      lockVault: deriveLockVaultAta(marketId, ammMint, programs),
      bookMint: usdcMint,
      ammMint,
      creator: smoke.creator.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  return sendTx(smoke.ctx, [smoke.creator], new Transaction().add(ix));
}

describe("create_market binds the question to its hash", () => {
  it("refuses a hash that is not the hash of the question", async () => {
    // The attack: store the hash of a boring question, broadcast an
    // attention-grabbing one. Every client renders the lie.
    const err = await createWith(
      "Will this market pay out to the creator?",
      sha256("Will BTC exceed 200k by 2027?"),
    ).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.QuestionHashMismatch);
  }, 60_000);

  it("refuses an empty question", async () => {
    // A market with no title is the state this whole change exists to end.
    const err = await createWith("", sha256("")).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.InvalidQuestion);
  }, 60_000);

  it("refuses a question past the length bound", async () => {
    // The text rides in the instruction AND in the event, so it is bounded
    // twice over: transaction size, and a log a client can read back.
    const long = "q".repeat(301);
    const err = await createWith(long, sha256(long)).catch((e) => e);
    expect(codeOf(err)).toBe(ERR.InvalidQuestion);
  }, 60_000);

  it("accepts a question that matches its hash", async () => {
    // The control. Without it the three rejections above would pass just as
    // well against a create_market that rejected everything.
    // `sendTx` resolves with no value, so the assertion is that it does not
    // throw — a rejection here would make the three above vacuous.
    const q = "Will BTC exceed 200k by 2027?";
    await expect(createWith(q, sha256(q))).resolves.not.toThrow();
  }, 60_000);
});

describe("the SDK will not build a market without a question", () => {
  it("rejects a missing question rather than emitting an untitled market", async () => {
    // `buildCreateMarket` used to accept a bare `questionHash`. That now
    // produces a market whose title nothing can ever recover, so it is a
    // client-side error with a message naming why.
    const { SolanaChainAdapter } = await import("../src/adapter.js");
    const { encodePubkeyRef } = await import("../src/refs.js");
    const adapter = new SolanaChainAdapter({
      node: {
        id: "q",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://127.0.0.1:8899",
      },
    } as never);
    await expect(
      adapter.buildCreateMarket({
        question: "",
        user: encodePubkeyRef(Keypair.generate().publicKey),
      } as never),
    ).rejects.toThrow(/question text is required/i);
  });

  it("rejects a question past the byte bound", async () => {
    const { SolanaChainAdapter } = await import("../src/adapter.js");
    const { encodePubkeyRef } = await import("../src/refs.js");
    const adapter = new SolanaChainAdapter({
      node: {
        id: "q",
        chainKind: "solana",
        chainId: "test",
        rpcUrl: "http://127.0.0.1:8899",
      },
    } as never);
    await expect(
      adapter.buildCreateMarket({
        question: "q".repeat(301),
        user: encodePubkeyRef(Keypair.generate().publicKey),
      } as never),
    ).rejects.toThrow(/max 300/i);
  });
});

void PublicKey;
