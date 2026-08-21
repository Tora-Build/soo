// The ATA pre-instruction must name the mint the main instruction moves.
//
// Every payout path constrains its destination with BOTH `token::authority =
// user` and `token::mint = <venue mint>`, so a wallet that has never held that
// venue's token needs its ATA created first. The SDK ships that create as a
// `meta.preIxs` entry.
//
// Creating the WRONG venue's ATA is silent: the transaction still carries a
// well-formed ATA-create, `submit` still replays it, and the account the main
// instruction actually needs is still missing. It fails as
// AccountNotInitialized (3012) on an account nobody prepared.
//
// It is silent for a second reason too, which is why this file exists at all:
// this deployment fills both venue roles with the same mock USDC mint
// (`AMM_TOKEN_MINT` aliases `USDC_MINT_DEVNET` in `constants.rs`), so on
// devnet today the two ATAs are the same account and the bug cannot be
// observed. The adapter takes `ammMint` and `bookMint` separately, so a
// two-mint deployment is one config change away — and these builders were
// wrong for it.
//
// So every assertion here names the MINT. Asserting only that an
// associated-token instruction is present is what let the mismatch through.

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import { encodePubkeyRef } from "../src/refs.js";
import { WAD } from "../src/math/lmsr.js";

import { bootSmoke, type SmokeContext } from "./fixtures/setup.js";
import { LiteSvmConnection } from "./fixtures/svm.js";

const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// Two mints that are definitely NOT each other. The builders only DERIVE from
// these — no account of either is ever read — so they can be arbitrary keys
// while the market underneath stays the real one LiteSVM booted. That is the
// whole point: it makes a two-mint deployment observable from a single-mint
// fixture.
const AMM_MINT = new PublicKey("Amm11111111111111111111111111111111111111111");
const BOOK_MINT = new PublicKey("Book1111111111111111111111111111111111111111");

interface SerializedIx {
  programId: string;
  keys: Array<{ pubkey: string }>;
}

/** The mint an ATA-create instruction names. Layout: payer, ata, owner, mint. */
function ataMintOf(ix: SerializedIx): string {
  expect(ix.programId, "pre-ix is not an ATA create").toBe(
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return ix.keys[3]!.pubkey;
}

function preIxsOf(req: { meta?: unknown }): SerializedIx[] {
  return ((req.meta as { preIxs?: SerializedIx[] }).preIxs ?? []).filter(
    (ix) => ix.programId === ASSOCIATED_TOKEN_PROGRAM,
  );
}

/** An adapter whose two venue mints are distinct, over the real fixture chain. */
function twoMintAdapter(smoke: SmokeContext): SolanaChainAdapter {
  return new SolanaChainAdapter({
    node: {
      id: "venue-ata-preix",
      chainKind: "solana",
      chainId: "test",
      rpcUrl: "http://localhost:8899",
    },
    programIds: smoke.programs,
    bookMint: BOOK_MINT,
    ammMint: AMM_MINT,
    connection: new LiteSvmConnection(smoke.ctx),
  } as never);
}

describe("ATA pre-instructions name the right venue's mint", () => {
  it("AMM payout paths prepare the AMM mint's ATA", async () => {
    const smoke = await bootSmoke({ bWad: WAD, userUsdcBaseUnits: 10_000_000n });
    const adapter = twoMintAdapter(smoke);
    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);
    const creatorRef = encodePubkeyRef(smoke.creator.publicKey);

    const paths: Array<[string, () => Promise<{ meta?: unknown }>]> = [
      [
        "redeemAmmPosition",
        () => adapter.buildRedeemAmmPosition(marketRef, { user: userRef }),
      ],
      [
        "reclaimSubsidy",
        () => adapter.buildReclaimSubsidy(marketRef, { creator: creatorRef }),
      ],
      [
        "claimRefund",
        () => adapter.buildClaimRefund(marketRef, { user: userRef }),
      ],
    ];

    for (const [name, build] of paths) {
      const pre = preIxsOf(await build());
      // Missing entirely is the third shape of this bug — `claimRefund` had
      // no ATA pre-instruction at all.
      expect(pre.length, `${name} has no ATA pre-instruction`).toBe(1);
      expect(ataMintOf(pre[0]!), `${name} prepares the wrong venue's ATA`).toBe(
        AMM_MINT.toBase58(),
      );
    }
  }, 90_000);

  it("book paths prepare the book mint's ATA", async () => {
    // The other half of the rule. Without it, "always use ammMint" would pass
    // the test above and break every book path.
    const smoke = await bootSmoke({ bWad: WAD, userUsdcBaseUnits: 10_000_000n });
    const adapter = twoMintAdapter(smoke);
    const marketRef = encodePubkeyRef(smoke.marketPda);
    const userRef = encodePubkeyRef(smoke.user.publicKey);

    const paths: Array<[string, () => Promise<{ meta?: unknown }>]> = [
      [
        "bookPlace",
        () =>
          adapter.buildBookPlace(marketRef, {
            user: userRef,
            side: 0,
            limitTick: 400,
            amount: 1_000_000n,
            matchLimit: 8,
            postRemainder: true,
          }),
      ],
      [
        "bookWithdraw",
        () => adapter.buildBookWithdraw(marketRef, { user: userRef }),
      ],
      [
        "redeemBookSeat",
        () => adapter.buildRedeemBookSeat(marketRef, { user: userRef }),
      ],
    ];

    for (const [name, build] of paths) {
      const pre = preIxsOf(await build());
      expect(pre.length, `${name} has no ATA pre-instruction`).toBe(1);
      expect(ataMintOf(pre[0]!), `${name} prepares the wrong venue's ATA`).toBe(
        BOOK_MINT.toBase58(),
      );
    }
  }, 90_000);

  it("redeemLp prepares one ATA per venue", async () => {
    // `redeem_lp` burns once and pays BOTH venues' yield, so it is the one
    // path that legitimately needs two ATAs — and the one where getting the
    // mints right matters most, since the LP may have held neither token.
    const smoke = await bootSmoke({ bWad: WAD, userUsdcBaseUnits: 10_000_000n });
    const adapter = twoMintAdapter(smoke);
    const req = await adapter.buildRedeemLp(encodePubkeyRef(smoke.marketPda), {
      user: encodePubkeyRef(smoke.creator.publicKey),
      lpAmount: 1n,
    } as never);
    const mints = preIxsOf(req).map(ataMintOf).sort();
    expect(mints).toEqual([AMM_MINT.toBase58(), BOOK_MINT.toBase58()].sort());
  }, 90_000);

  it("a prepared AMM ATA is the account the redeem instruction reads", async () => {
    // Deriving the right mint is only half of it — the pre-instruction has to
    // create the SAME address the main instruction names. Pinning them to each
    // other means a future change to either derivation cannot drift alone.
    const smoke = await bootSmoke({ bWad: WAD, userUsdcBaseUnits: 10_000_000n });
    const adapter = twoMintAdapter(smoke);
    const req = await adapter.buildRedeemAmmPosition(
      encodePubkeyRef(smoke.marketPda),
      { user: encodePubkeyRef(smoke.user.publicKey) },
    );
    const created = preIxsOf(req)[0]!.keys[1]!.pubkey;
    const named = (req.accounts ?? []).map((a: { pubkey: string }) => a.pubkey);
    expect(named).toContain(created);
  }, 90_000);
});
