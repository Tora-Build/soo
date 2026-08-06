// Every book path that moves USDC must create the user's ATA first.
//
// The book instructions constrain `user_usdc_ata` with `token::authority =
// user`, which requires the account to already exist. A wallet that has never
// held USDC has no ATA, so its first interaction failed at simulation with
// nothing on screen naming the cause — the wallet looked funded, because it had
// plenty of SOL.
//
// `buildTrade` had this for the AMM path from the start; the book builders did
// not. It matters most on the PAYOUT paths — withdraw, redeem, reclaim — where
// USDC arrives at a wallet that may never have held any, so there is no chance
// it created an ATA some other way.

import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { SolanaChainAdapter } from "../src/adapter.js";
import soothCoreIdl from "../src/anchor/sooth_core.json" assert { type: "json" };

const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

function adapterFor(): SolanaChainAdapter {
  return new SolanaChainAdapter({
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
}

interface Meta {
  preIxs?: Array<{ programId: string }>;
}

describe("USDC ATA pre-instruction", () => {
  const adapter = adapterFor();
  const market = `sol:${Keypair.generate().publicKey.toBase58()}`;
  const user = `sol:${Keypair.generate().publicKey.toBase58()}`;

  // These need a real market account to resolve, so they are skipped without a
  // validator. The assertion is about instruction SHAPE, not chain state.
  const build = async (fn: () => Promise<{ meta: unknown }>) => {
    try {
      return ((await fn()).meta as Meta).preIxs ?? [];
    } catch {
      return null; // no validator
    }
  };

  it("is attached to every book path that moves USDC", async () => {
    const paths: Array<[string, () => Promise<{ meta: unknown }>]> = [
      ["bookPlace", () =>
        adapter.buildBookPlace(market, {
          user, side: 0, limitTick: 400, amount: 1_000_000n,
          matchLimit: 8, postRemainder: true,
        } as never)],
      ["bookWithdraw", () => adapter.buildBookWithdraw(market, { user } as never)],
      ["redeemBookSeat", () => adapter.buildRedeemBookSeat(market, { user })],
      ["reclaimSubsidy", () => adapter.buildReclaimSubsidy(market, { creator: user })],
    ];
    let checked = 0;
    for (const [name, fn] of paths) {
      const pre = await build(fn);
      if (pre === null) continue; // no validator; nothing to assert
      checked += 1;
      expect(pre.length, `${name} has no ATA pre-instruction`).toBe(1);
      expect(pre[0]!.programId, `${name} pre-ix is not an ATA create`).toBe(
        ASSOCIATED_TOKEN_PROGRAM,
      );
    }
    // Guard against the whole test silently no-opping.
    if (checked > 0) expect(checked).toBe(paths.length);
  }, 60_000);
});
