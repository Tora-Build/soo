// `SolanaChainAdapter` — implements the vendored `ChainAdapter` interface
// against `@coral-xyz/anchor` 0.30.x and `@solana/web3.js` 1.x.
//
// Scope of this implementation (per scaffolding plan):
//
//   - Real: readSnapshot, readQuote, readPosition, buildTrade (buy), submit
//   - NotImplemented: readPortfolio, buildClaim, buildOrderbook*,
//     buildCreateMarket, preflight, subscribe*, getCollateralBalance,
//     buildApprove
//
// The buy path is wired end-to-end. Sell path on `buildTrade` throws
// `NotImplemented` because the on-chain sell branch in `trade_positions.rs`
// is itself stubbed (no USDC outflow yet — see the file's module comment).

import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";

import { soothAmmIdl, soothMarketIdl } from "./anchor/index.js";
import { costDelta, wadToUsdcCeil, yesPriceWad, WAD } from "./math/lmsr.js";
import {
  deriveAmmStatePda,
  deriveMarketPda,
  deriveMarketVaultAta,
  derivePositionPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  type ProgramIds,
} from "./pdas.js";
import {
  decodePubkeyRef,
  encodePubkeyRef,
  encodeSignatureRef,
} from "./refs.js";
import { SoothError, notImplemented } from "./errors.js";
import type {
  AddressRef,
  BuyArgs,
  ChainAdapter,
  ClaimArgs,
  ClaimRequest,
  CreateMarketArgs,
  CreateMarketRequest,
  MarketEvent,
  MarketRef,
  OrderbookRequest,
  Portfolio,
  Position,
  PositionEvent,
  PreflightResult,
  SellArgs,
  SignerRef,
  SoothCoreSnapshot,
  SoothNode,
  SoothRequest,
  SubmitReceipt,
  TradeArgs,
  TradeQuote,
  TradeRequest,
  Unsubscribe,
} from "./types.js";

export interface SolanaAdapterOptions {
  node: SoothNode;
  // Override programs and USDC mint for tests / non-default deployments. The
  // node already exposes `programs.*` strings; an explicit `programIds`
  // bypasses string parsing in hot paths.
  programIds?: ProgramIds;
  usdcMint?: PublicKey;
  // Pre-built `Connection` to reuse (e.g. when running under bankrun where
  // the connection is replaced by a custom client).
  connection?: Connection;
}

// Resolved-once cache key — `Market` PDA layout is invariant across reads.
interface ResolvedMarket {
  marketPda: PublicKey;
  marketId: Uint8Array; // 16 bytes
  questionHash: Uint8Array; // 32 bytes (raw — we don't have the original question on-chain)
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  startTime: bigint;
  deadline: bigint;
  lifecycle: "Initializing" | "Open" | "Locked" | "Settled";
  winningOutcome: number;
}

// Anchor's IDL types are loose; we re-narrow at the boundary.
type AnyProgram = Program<Idl>;

export class SolanaChainAdapter implements ChainAdapter {
  readonly node: SoothNode;
  readonly chainKind = "solana" as const;

  // Program IDs and connection are resolved once at construction.
  readonly programIds: ProgramIds;
  readonly usdcMint: PublicKey;
  readonly connection: Connection;

  // Anchor `Program` wrappers; built lazily because Anchor needs a Provider.
  private readonly soothAmm: AnyProgram;
  private readonly soothMarket: AnyProgram;

  constructor(opts: SolanaAdapterOptions) {
    this.node = opts.node;

    // Resolve program IDs. Explicit override wins; otherwise read from the
    // node descriptor; otherwise fall back to the IDL `address` field
    // (placeholder IDs from the on-chain `declare_id!` macros).
    if (opts.programIds) {
      this.programIds = opts.programIds;
    } else {
      const ammStr = opts.node.programs?.soothAmm ?? soothAmmIdl.address;
      const mktStr = opts.node.programs?.soothMarket ?? soothMarketIdl.address;
      this.programIds = {
        soothAmm: new PublicKey(ammStr),
        soothMarket: new PublicKey(mktStr),
      };
    }

    if (opts.usdcMint) {
      this.usdcMint = opts.usdcMint;
    } else if (opts.node.programs?.usdcMint) {
      this.usdcMint = new PublicKey(opts.node.programs.usdcMint);
    } else {
      // Default to the on-chain devnet constant (`USDC_MINT_DEVNET` in
      // `programs/sooth_amm/src/lib.rs`). Tests can override via
      // `opts.usdcMint`.
      this.usdcMint = new PublicKey(
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      );
    }

    this.connection =
      opts.connection ?? new Connection(opts.node.rpcUrl, "confirmed");

    // Build a read-only provider. Anchor's `Program` constructor requires
    // *some* wallet; we pass a stub that fails on attempts to sign so any
    // accidental sign-via-program code path errors clearly.
    const stubWallet: Wallet = {
      publicKey: PublicKey.default,
      signTransaction: async () => {
        throw new Error("SolanaChainAdapter: read-only provider has no signer");
      },
      signAllTransactions: async () => {
        throw new Error("SolanaChainAdapter: read-only provider has no signer");
      },
      payer: Keypair.generate(),
    };
    const provider = new AnchorProvider(this.connection, stubWallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    // Inject the resolved program IDs into the IDL clones so `program.programId`
    // matches the active deployment regardless of the placeholder.
    const ammIdl = {
      ...soothAmmIdl,
      address: this.programIds.soothAmm.toBase58(),
    };
    const marketIdl = {
      ...soothMarketIdl,
      address: this.programIds.soothMarket.toBase58(),
    };
    this.soothAmm = new Program(ammIdl as Idl, provider);
    this.soothMarket = new Program(marketIdl as Idl, provider);
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  async readSnapshot(
    market: MarketRef,
    user?: AddressRef,
  ): Promise<SoothCoreSnapshot> {
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);

    // Read AmmState by deriving from market_id.
    const [ammPda] = deriveAmmStatePda(resolved.marketId, this.programIds);
    const ammRaw = await (this.soothAmm.account as any).ammState.fetchNullable(
      ammPda,
    );
    if (!ammRaw) {
      throw new SoothError({
        kind: "AccountNotFound",
        msg: `AmmState PDA not found at ${ammPda.toBase58()} (was the market initialized for AMM?)`,
      });
    }
    const qYes = bnToBigInt(ammRaw.qYes);
    const qNo = bnToBigInt(ammRaw.qNo);
    const b = bnToBigInt(ammRaw.b);

    const marketInfo = {
      market,
      // The on-chain `Market` stores `question_hash`, not the raw question
      // text (parity with EVM `TruthMarket`). We surface a hex string until
      // an off-chain question registry is wired.
      question: `0x${Buffer.from(resolved.questionHash).toString("hex")}`,
      deadline: resolved.deadline,
      isLive: resolved.lifecycle === "Open",
      isSettled: resolved.lifecycle === "Settled",
      outcome:
        resolved.lifecycle === "Settled"
          ? ((resolved.winningOutcome as 0 | 1 | 2) ?? undefined)
          : undefined,
      qYes,
      qNo,
      b,
      isGraduated: Boolean(ammRaw.isGraduated),
    };

    let position: Position | undefined;
    if (user) {
      const userPk = decodePubkeyRef(user);
      position = await this.readPositionInner(resolved.marketId, userPk);
    }

    return { market: marketInfo, position };
  }

  async readSnapshots(
    markets: MarketRef[],
    user?: AddressRef,
  ): Promise<SoothCoreSnapshot[]> {
    // Sequential for now; the umbrella SDK can batch this with
    // `getMultipleAccounts` once the call sites firm up.
    return Promise.all(markets.map((m) => this.readSnapshot(m, user)));
  }

  async readQuote(
    market: MarketRef,
    outcome: 0 | 1,
    deltaShares: bigint,
  ): Promise<TradeQuote> {
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [ammPda] = deriveAmmStatePda(resolved.marketId, this.programIds);
    const ammRaw = await (this.soothAmm.account as any).ammState.fetchNullable(
      ammPda,
    );
    if (!ammRaw) {
      throw new SoothError({
        kind: "AccountNotFound",
        msg: `AmmState PDA not found at ${ammPda.toBase58()}`,
      });
    }
    const qYes = bnToBigInt(ammRaw.qYes);
    const qNo = bnToBigInt(ammRaw.qNo);
    const b = bnToBigInt(ammRaw.b);

    const dYes = outcome === 1 ? deltaShares : 0n;
    const dNo = outcome === 0 ? deltaShares : 0n;
    const cost = costDelta(qYes, qNo, b, dYes, dNo);
    const fee = 0n; // Fee router is stubbed on-chain — see `trade_positions.rs §3`.
    const netCost = cost + fee;
    const oldPrice = yesPriceWad(qYes, qNo, b);
    const newPrice = yesPriceWad(qYes + dYes, qNo + dNo, b);
    const priceImpact = newPrice - oldPrice;

    return {
      cost,
      fee,
      netCost,
      newYesPrice: newPrice,
      priceImpact,
    };
  }

  async readPosition(market: MarketRef, user: AddressRef): Promise<Position> {
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const userPk = decodePubkeyRef(user);
    const pos = await this.readPositionInner(resolved.marketId, userPk);
    return pos;
  }

  private async readPositionInner(
    marketId: Uint8Array,
    user: PublicKey,
  ): Promise<Position> {
    const [posPda] = derivePositionPda(marketId, user, this.programIds);
    const raw = await (this.soothAmm.account as any).position.fetchNullable(
      posPda,
    );
    if (!raw) {
      // Position lazily exists on first trade; absence is "no shares".
      return { yesShares: 0n, noShares: 0n };
    }
    return {
      yesShares: bnToBigInt(raw.yesShares),
      noShares: bnToBigInt(raw.noShares),
    };
  }

  async readPortfolio(_user: AddressRef): Promise<Portfolio> {
    notImplemented("readPortfolio");
  }

  // ─── Writes ──────────────────────────────────────────────────────────────

  async buildTrade(market: MarketRef, args: TradeArgs): Promise<TradeRequest> {
    if (args.side === "sell") {
      // The on-chain sell branch in `trade_positions.rs §6` does NOT yet
      // transfer USDC out (lock_authority/lock_vault/LockEntry plumbing is
      // stubbed). Building a sell request would mint state diverging from
      // the EVM contract — refuse it.
      throw new SoothError({
        kind: "NotImplemented",
        method: "buildTrade(sell)",
      });
    }

    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);

    // Determine the user from the `args` is unfortunate — TradeArgs doesn't
    // carry it. The umbrella SDK plumbs the user through the request build
    // path via the active wallet. For a Solana adapter that means we need
    // the user public key at build time so we can derive the Position PDA
    // and the user's USDC ATA. We accept this through a meta channel.
    const user = (args as TradeArgs & { user?: string }).user;
    if (!user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildTrade — TradeArgs.user (Solana-only meta) is required at build time",
      });
    }
    const userPk = decodePubkeyRef(user);

    const [ammPda] = deriveAmmStatePda(resolved.marketId, this.programIds);
    const [positionPda] = derivePositionPda(
      resolved.marketId,
      userPk,
      this.programIds,
    );
    const [vaultAuthority] = deriveVaultAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const userUsdcAta = deriveUserUsdcAta(userPk, this.usdcMint);
    const marketVault = deriveMarketVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );

    // Build the `trade_positions` instruction. Anchor's coder takes `BN`
    // for `i128` / `u128` args; we widen at the boundary.
    const ix: TransactionInstruction = await (this.soothAmm.methods as any)
      .tradePositions(
        args.outcome,
        bigIntToBn(args.deltaShares),
        bigIntToBn(args.maxCostWad),
      )
      .accounts({
        market: marketPda,
        ammState: ammPda,
        position: positionPda,
        vaultAuthority,
        userUsdcAta,
        marketVault,
        usdcMint: this.usdcMint,
        user: userPk,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const tx = new Transaction();
    // Generous CU bump — `trade_positions` benched ~75-80k per the spike but
    // `init_if_needed` on the first Position adds rent payer overhead.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ix as TransactionInstruction);
    tx.feePayer = userPk;
    // The latest blockhash is fetched at submit time (so the request remains
    // serializable across processes / RPCs). Build-time we leave it unset.

    // Cost estimate via the same off-chain LMSR port the program runs.
    const cost = await this.readQuote(market, args.outcome, args.deltaShares);

    const accounts: AddressRef[] = [
      encodePubkeyRef(marketPda),
      encodePubkeyRef(ammPda),
      encodePubkeyRef(positionPda),
      encodePubkeyRef(userUsdcAta),
      encodePubkeyRef(marketVault),
    ];

    return {
      kind: "trade",
      // Re-serialized at submit time once the blockhash is set; we ship the
      // unsigned instruction through `meta.txInstructions` so submit can
      // re-attach a fresh blockhash without round-tripping through the
      // borsh layer.
      serializedTx: undefined,
      costEstimateWad: cost.cost,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        userPk: userPk.toBase58(),
        ixData: Buffer.from(ix.data).toString("base64"),
        ixKeys: ix.keys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        ixProgramId: ix.programId.toBase58(),
        deltaSharesStr: args.deltaShares.toString(),
        maxCostWadStr: args.maxCostWad.toString(),
        outcome: args.outcome,
      },
    };
  }

  async buildClaim(
    _market: MarketRef,
    _args: ClaimArgs,
  ): Promise<ClaimRequest> {
    notImplemented("buildClaim");
  }
  async buildOrderbookBuy(
    _market: MarketRef,
    _args: BuyArgs,
  ): Promise<OrderbookRequest> {
    notImplemented("buildOrderbookBuy");
  }
  async buildOrderbookSell(
    _market: MarketRef,
    _args: SellArgs,
  ): Promise<OrderbookRequest> {
    notImplemented("buildOrderbookSell");
  }
  async buildOrderbookCancel(
    _market: MarketRef,
    _orderId: string,
  ): Promise<OrderbookRequest> {
    notImplemented("buildOrderbookCancel");
  }
  async buildCreateMarket(
    _args: CreateMarketArgs,
  ): Promise<CreateMarketRequest> {
    notImplemented("buildCreateMarket");
  }

  async submit(req: SoothRequest, signer: SignerRef): Promise<SubmitReceipt> {
    // Reconstruct the transaction from the meta payload, attach a fresh
    // blockhash, sign, send, confirm.
    const meta = req.meta as
      | undefined
      | {
          ixData: string;
          ixKeys: Array<{
            pubkey: string;
            isSigner: boolean;
            isWritable: boolean;
          }>;
          ixProgramId: string;
          userPk: string;
        };
    if (!meta?.ixData) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "submit: request missing meta.ixData",
      });
    }

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    const ix = new TransactionInstruction({
      programId: new PublicKey(meta.ixProgramId),
      keys: meta.ixKeys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(meta.ixData, "base64"),
    });
    tx.add(ix);

    const userPk = new PublicKey(meta.userPk);
    tx.feePayer = userPk;

    // Hot path: the umbrella SDK's `client.submit` resolves on finality. We
    // mirror the EVM behavior of "block until confirmed".
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    if (!signer.signTransaction) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "submit: signer lacks signTransaction",
      });
    }

    const serialized = tx.serialize({
      verifySignatures: false,
      requireAllSignatures: false,
    });
    const signedBytes = await signer.signTransaction(serialized);
    // `sendRawTransaction` already throws on preflight rejection; that path
    // surfaces as a thrown SendTransactionError with `transactionLogs` —
    // wrap it so the caller gets a `SoothError` shape regardless of where
    // the failure originated. We don't have the signature yet at this
    // point, so the wrapped error carries `signature: undefined`.
    let sig: string;
    try {
      sig = await this.connection.sendRawTransaction(signedBytes, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
    } catch (e) {
      throw decodeSubmitError(e, undefined);
    }
    const confirmation = await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    // H5 (Codex): inspect confirmation.value.err. `confirmTransaction`
    // resolves successfully even for transactions whose execution reverted —
    // the failure surface is the `value.err` field, not a thrown exception.
    // Without this branch failed trades returned a "success" SubmitReceipt.
    if (
      confirmation.value.err !== null &&
      confirmation.value.err !== undefined
    ) {
      throw decodeSubmitError(confirmation.value.err, sig);
    }

    return {
      txId: encodeSignatureRef(sig),
      confirmedAt: BigInt(Date.now()),
      fills: [], // AMM trades emit `PositionTraded` not orderbook fills.
      attempts: 1,
    };
  }

  async preflight(_req: SoothRequest): Promise<PreflightResult> {
    notImplemented("preflight");
  }

  // ─── Subscriptions (intentionally not wired) ────────────────────────────

  subscribeMarketEvents(
    _market: MarketRef,
    _handler: (e: MarketEvent) => void,
  ): Unsubscribe {
    notImplemented("subscribeMarketEvents");
  }
  subscribePositionEvents(
    _user: AddressRef,
    _handler: (e: PositionEvent) => void,
  ): Unsubscribe {
    notImplemented("subscribePositionEvents");
  }

  // ─── Wallet / collateral ────────────────────────────────────────────────

  async getCollateralBalance(_user: AddressRef): Promise<bigint> {
    notImplemented("getCollateralBalance");
  }
  async buildApprove(
    _spender: AddressRef,
    _amount: bigint,
  ): Promise<SoothRequest> {
    notImplemented("buildApprove");
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async fetchMarket(marketPda: PublicKey): Promise<ResolvedMarket> {
    const raw = await (this.soothMarket.account as any).market.fetchNullable(
      marketPda,
    );
    if (!raw) {
      throw new SoothError({
        kind: "AccountNotFound",
        msg: `Market PDA not found at ${marketPda.toBase58()}`,
      });
    }
    return {
      marketPda,
      marketId: new Uint8Array(raw.marketId),
      questionHash: new Uint8Array(raw.questionHash),
      yesMint: raw.yesMint,
      noMint: raw.noMint,
      vault: raw.vault,
      startTime: BigInt(raw.startTime.toString()),
      deadline: BigInt(raw.deadline.toString()),
      lifecycle: lifecycleName(raw.lifecycle),
      winningOutcome: Number(raw.winningOutcome ?? 0),
    };
  }

  // Convenience for the smoke test: look up vault USDC balance directly.
  // Not part of the ChainAdapter contract; the umbrella `getCollateralBalance`
  // surfaces user balances, not vault balances.
  async getMarketVaultUsdcRaw(market: MarketRef): Promise<bigint> {
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const acc = await getAccount(
      this.connection,
      deriveMarketVaultAta(resolved.marketId, this.usdcMint, this.programIds),
    );
    return acc.amount;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function bnToBigInt(v: BN | number | bigint | { toString(): string }): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  // BN exposes `toString` returning a decimal string regardless of internal
  // representation; bigint's parser accepts that.
  return BigInt((v as { toString(): string }).toString());
}

function bigIntToBn(v: bigint): BN {
  // Anchor's BN type accepts a decimal/hex string. bigint's stringification
  // is guaranteed decimal.
  return new BN(v.toString());
}

function lifecycleName(v: unknown): ResolvedMarket["lifecycle"] {
  // Anchor decodes Borsh enums as `{ open: {} }` / `{ locked: {} }` etc.
  if (v && typeof v === "object") {
    const k = Object.keys(v as object)[0];
    if (k) {
      const cap = k.charAt(0).toUpperCase() + k.slice(1);
      if (
        cap === "Initializing" ||
        cap === "Open" ||
        cap === "Locked" ||
        cap === "Settled"
      ) {
        return cap;
      }
    }
  }
  // Defensive default — anything we don't understand is "Initializing"
  // (most-conservative interpretation; trades won't be allowed).
  return "Initializing";
}

// H5 (Codex): map a Solana RPC error (thrown by sendRawTransaction or
// surfaced via confirmation.value.err) to a SoothError. Anchor returns
// program errors as `{ InstructionError: [ixIndex, { Custom: code }] }`.
// We match that exact shape and look up the code against the sooth_amm
// error table inlined here (the IDL ships these but importing for the
// lookup would tie the helper to a specific program — keep it cheap and
// local).
//
// Codes mirror `programs/sooth_amm/src/error.rs`. Anchor numbers user
// errors starting at 6000 in declaration order; reorder the enum and these
// have to be updated.
const SOOTH_AMM_ERROR_TABLE: Record<number, { kind: string; msg: string }> = {
  6000: {
    kind: "SlippageExceeded",
    msg: "Slippage: cost exceeded max_cost_wad",
  },
  6001: {
    kind: "ProgramError",
    msg: "Invalid outcome (must be NO=0 or YES=1)",
  },
  6002: { kind: "ProgramError", msg: "delta_shares must be non-zero" },
  6003: { kind: "InsufficientShares", msg: "Insufficient shares to sell" },
  6004: {
    kind: "MarketNotActive",
    msg: "Market is not in the Open lifecycle state",
  },
  6005: { kind: "MarketNotActive", msg: "Market is dismissed" },
  6006: { kind: "ProgramError", msg: "LMSR math overflow or domain error" },
  6007: { kind: "ProgramError", msg: "Liquidity parameter b must be > 0" },
  6008: {
    kind: "ProgramError",
    msg: "Caller is not authorized for this action",
  },
  6009: {
    kind: "TradingNotStarted",
    msg: "Trading window has not started yet",
  },
  6010: { kind: "TradingClosed", msg: "Trading window has closed" },
  6011: {
    kind: "SellNotImplemented",
    msg: "Sell path is not implemented yet — see trade_positions.rs §6 / architecture §4.3",
  },
};

function decodeSubmitError(
  raw: unknown,
  signature: string | undefined,
): SoothError {
  const code = extractCustomCode(raw);
  if (code !== undefined) {
    const entry = SOOTH_AMM_ERROR_TABLE[code];
    if (entry) {
      return new SoothError({
        kind: entry.kind as SoothError["kind"],
        code,
        msg: entry.msg,
        signature,
      });
    }
    return new SoothError({
      kind: "ProgramError",
      code,
      msg: `Unknown program error code ${code}`,
      signature,
    });
  }

  // Fall through — surface whatever string representation we have.
  let msg: string;
  if (raw instanceof Error) {
    msg = raw.message;
  } else if (typeof raw === "string") {
    msg = raw;
  } else {
    try {
      msg = JSON.stringify(raw);
    } catch {
      msg = String(raw);
    }
  }
  return new SoothError({ kind: "ProgramError", msg, signature });
}

function extractCustomCode(raw: unknown): number | undefined {
  // Shape A — confirmation.value.err: `{ InstructionError: [n, { Custom: code }] }`
  if (raw && typeof raw === "object") {
    const ix = (raw as { InstructionError?: unknown }).InstructionError;
    if (Array.isArray(ix) && ix.length >= 2) {
      const inner = ix[1];
      if (inner && typeof inner === "object") {
        const custom = (inner as { Custom?: unknown }).Custom;
        if (typeof custom === "number") return custom;
      }
    }
  }
  // Shape B — SendTransactionError surfaces the failure as a string with
  // "custom program error: 0x.." somewhere in `.message`. Parse the hex
  // tail off whatever string-shaped representation we got.
  const text =
    raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  if (text) {
    const m = /custom program error:\s*0x([0-9a-f]+)/i.exec(text);
    if (m && m[1]) {
      const code = Number.parseInt(m[1], 16);
      if (Number.isFinite(code)) return code;
    }
  }
  return undefined;
}
