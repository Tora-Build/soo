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
  deriveLockAuthorityPda,
  deriveLockEntryPda,
  deriveLockVaultAta,
  deriveMarketPda,
  deriveMarketVaultAta,
  derivePositionPda,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  type ProgramIds,
} from "./pdas.js";
import { decodePubkeyRef, encodeSignatureRef } from "./refs.js";
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
  SubmitOptions,
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
      // Wave 1A landed `sell_positions` as a separate on-chain ix from
      // `trade_positions`; the SDK split mirrors that. Sell callers must use
      // `buildSell()` so the EVM-parity wire shape on this method stays
      // buy-only and the demo's chain-shim router can dispatch on the
      // operation type rather than `delta_shares` sign.
      throw new SoothError({
        kind: "NotImplemented",
        method: "buildTrade(sell) — use buildSell() instead",
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

    // Codex 2nd-pass review: derive `accounts` from the instruction's `keys`
    // directly rather than a hand-curated subset. Anchor's instruction builder
    // emits the exact list the on-chain program expects (vault authority,
    // USDC mint, system/token/rent — everything), so this is the source of
    // truth for ALT building and inspection. See `types.ts §AccountMeta`.
    const accounts = ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }));

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

  // ─── Sell path (Wave 1A `sell_positions` ix) ───────────────────────────
  //
  // Returns the same `TradeRequest` shape as `buildTrade` so call-sites that
  // submit through `adapter.submit()` are unchanged. The split at this
  // surface mirrors the on-chain ix split (separate `sell_positions` from
  // `trade_positions`) and lets the demo's chain-shim dispatch on operation
  // type rather than the sign of `delta_shares`.
  //
  // Wire shape: `delta_shares < 0` is mandated by the program; the SDK
  // validates the caller passed a positive bigint and negates at the
  // boundary. `min_proceeds_wad = 0` disables on-chain slippage checking.
  //
  // Account derivation: the `LockEntry` PDA seeds depend on the *current*
  // `Position::lock_nonce` — we read the Position before deriving so the
  // address matches what `init` will produce on-chain. The handler bumps
  // `lock_nonce` after init, so each in-flight sell needs its own snapshot
  // of the chain state to compute a fresh PDA.
  async buildSell(
    market: MarketRef,
    args: {
      outcome: 0 | 1;
      deltaShares: bigint;
      minProceedsWad?: bigint;
      user: AddressRef;
    },
  ): Promise<TradeRequest> {
    if (args.outcome !== 0 && args.outcome !== 1) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `buildSell: outcome must be 0 (NO) or 1 (YES), got ${args.outcome}`,
      });
    }
    if (args.deltaShares <= 0n) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `buildSell: deltaShares must be > 0 (the sign is applied at the wire boundary), got ${args.deltaShares.toString()}`,
      });
    }

    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const userPk = decodePubkeyRef(args.user);

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
    const [lockAuthority] = deriveLockAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const marketVault = deriveMarketVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );
    const lockVault = deriveLockVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );

    // Read the current Position to grab `lock_nonce`. The LockEntry PDA seed
    // includes the nonce; without the up-to-date value the `init` would land
    // at the wrong address and Anchor would reject. Position is required to
    // exist (you can only sell shares you've previously bought).
    const positionRaw = await (
      this.soothAmm.account as any
    ).position.fetchNullable(positionPda);
    if (!positionRaw) {
      throw new SoothError({
        kind: "AccountNotFound",
        msg: `buildSell: Position PDA not found at ${positionPda.toBase58()} — buy shares before selling`,
      });
    }
    const lockNonce = bnToBigInt(positionRaw.lockNonce);

    const [lockEntryPda] = deriveLockEntryPda(
      positionPda,
      lockNonce,
      this.programIds,
    );

    // Sign: ix args. `delta_shares` MUST be negative on-wire. `min_proceeds_wad`
    // defaults to 0 (skip slippage check) — production callers should pass
    // a real lower bound derived from the off-chain `readQuote` result.
    const wireDelta = -args.deltaShares;
    const minProceedsWad = args.minProceedsWad ?? 0n;

    const ix: TransactionInstruction = await (this.soothAmm.methods as any)
      .sellPositions(
        args.outcome,
        bigIntToBn(wireDelta),
        bigIntToBn(minProceedsWad),
      )
      .accounts({
        market: marketPda,
        ammState: ammPda,
        position: positionPda,
        vaultAuthority,
        lockAuthority,
        marketVault,
        lockVault,
        lockEntry: lockEntryPda,
        usdcMint: this.usdcMint,
        user: userPk,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        // Wave 1B: `sell_positions` now CPIs into `sooth_market::transfer_to_lock`
        // for the PDA-signed `vault → lock_vault` transfer. The `vault_authority`
        // PDA is owned by `sooth_market`, so the AMM cannot `invoke_signed`
        // against it directly — see the matching commit on the on-chain side.
        soothMarketProgram: this.programIds.soothMarket,
      })
      .instruction();

    // Cost estimate via the same off-chain LMSR port. For sells, `cost` is
    // negative (proceeds back to the user); we surface |cost| as the
    // estimate so the field stays unsigned for downstream UI parity with
    // the buy path.
    const quote = await this.readQuote(market, args.outcome, wireDelta);
    const proceedsAbs = quote.cost < 0n ? -quote.cost : quote.cost;

    const accounts = ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }));

    return {
      kind: "trade",
      serializedTx: undefined,
      costEstimateWad: proceedsAbs,
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
        operation: "sell",
        deltaSharesStr: wireDelta.toString(),
        minProceedsWadStr: minProceedsWad.toString(),
        outcome: args.outcome,
        lockEntryPda: lockEntryPda.toBase58(),
        lockNonceStr: lockNonce.toString(),
      },
    };
  }

  // ─── Claim path (Wave 1A `claim_unlocked` ix) ──────────────────────────
  //
  // The integrator-contract spec types `buildClaim(market, args: ClaimArgs)`.
  // EVM's `claimUnlocked(maxClaims)` walks a per-user storage queue; on
  // Solana each `LockEntry` is its own account, so we resolve a *single*
  // entry per ix invocation (one-lock-per-call mirrors the on-chain
  // handler's design, see `claim_unlocked.rs` "Why one-lock-per-call").
  //
  // The `ClaimArgs` shape is shared across chains and doesn't carry a
  // LockEntry pubkey, so the Solana adapter accepts an extension via the
  // same `args.user` / `args.lockEntry` meta channel buildTrade uses for
  // `args.user`. Callers wanting to claim multiple lock entries fan out N
  // builds + submits at the call site (the demo's chain-shim does this).
  async buildClaim(
    market: MarketRef,
    args: ClaimArgs & { user?: AddressRef; lockEntry?: AddressRef },
  ): Promise<ClaimRequest> {
    const user = args.user;
    if (!user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildClaim — args.user (Solana-only meta) is required at build time",
      });
    }
    const lockEntryRef = args.lockEntry;
    if (!lockEntryRef) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildClaim — args.lockEntry (Solana-only meta; the LockEntry PDA to drain) is required",
      });
    }

    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const userPk = decodePubkeyRef(user);
    const lockEntryPda = decodePubkeyRef(lockEntryRef);

    const [positionPda] = derivePositionPda(
      resolved.marketId,
      userPk,
      this.programIds,
    );
    const [lockAuthority] = deriveLockAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const lockVault = deriveLockVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );
    const userUsdcAta = deriveUserUsdcAta(userPk, this.usdcMint);

    const ix: TransactionInstruction = await (this.soothAmm.methods as any)
      .claimUnlocked()
      .accounts({
        market: marketPda,
        position: positionPda,
        lockEntry: lockEntryPda,
        lockAuthority,
        lockVault,
        userUsdcAta,
        usdcMint: this.usdcMint,
        user: userPk,
        tokenProgram: TOKEN_PROGRAM_ID,
        // Wave 1B: `claim_unlocked` now CPIs into
        // `sooth_market::transfer_from_lock_vault` for the PDA-signed
        // `lock_vault → user_usdc_ata` transfer.
        soothMarketProgram: this.programIds.soothMarket,
      })
      .instruction();

    const accounts = ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }));

    return {
      kind: "claim",
      serializedTx: undefined,
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
        operation: "claim",
        lockEntryPda: lockEntryPda.toBase58(),
      },
    };
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

  async submit(
    req: SoothRequest,
    signer: SignerRef,
    options?: SubmitOptions,
  ): Promise<SubmitReceipt> {
    // Reconstruct the transaction from the meta payload, attach a fresh
    // blockhash, sign, send, confirm — retrying on transient failures up to
    // `MAX_SUBMIT_ATTEMPTS` per the integrator-contract spec
    // (`docs/implementation-guide.md §2`: "EVM always returns 1; Solana may
    // return 1–5").
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

    if (!signer.signTransaction) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "submit: signer lacks signTransaction",
      });
    }

    const userPk = new PublicKey(meta.userPk);
    const ix = new TransactionInstruction({
      programId: new PublicKey(meta.ixProgramId),
      keys: meta.ixKeys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(meta.ixData, "base64"),
    });

    const requested = options?.maxAttempts ?? MAX_SUBMIT_ATTEMPTS;
    // Clamp to spec: at least 1, at most MAX_SUBMIT_ATTEMPTS.
    const maxAttempts = Math.max(
      1,
      Math.min(MAX_SUBMIT_ATTEMPTS, Math.floor(requested)),
    );

    let lastError: SoothError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Each attempt re-fetches the blockhash and re-signs — the blockhash
      // is part of the message, so the previous signature is invalid for
      // the new send. The signer is invoked once per attempt.
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(ix);
      tx.feePayer = userPk;

      let blockhash: string;
      let lastValidBlockHeight: number;
      try {
        const bh = await this.connection.getLatestBlockhash("confirmed");
        blockhash = bh.blockhash;
        lastValidBlockHeight = bh.lastValidBlockHeight;
      } catch (e) {
        // Fetching a fresh blockhash failed — that's an RPC-side issue. If
        // we still have attempts left, retry; otherwise surface as
        // NetworkError.
        lastError = makeNetworkError(e, attempt, undefined);
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;

      const serialized = tx.serialize({
        verifySignatures: false,
        requireAllSignatures: false,
      });
      const signedBytes = await signer.signTransaction(serialized);

      let sig: string | undefined;
      try {
        sig = await this.connection.sendRawTransaction(signedBytes, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
      } catch (e) {
        const classified = classifySubmitError(e, attempt, undefined);
        lastError = classified.error;
        if (classified.retryable && attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw classified.error;
      }

      let confirmation;
      try {
        confirmation = await this.connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );
      } catch (e) {
        // Confirmation timeout or RPC drop. Treat as retryable: the tx may
        // have landed, may have expired — the next attempt re-sends with a
        // new blockhash. The previous signature is harmless even if the tx
        // did land (Solana rejects duplicate signatures cheaply).
        lastError = makeNetworkError(e, attempt, sig);
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      // H5 (Codex): inspect confirmation.value.err. `confirmTransaction`
      // resolves successfully even for transactions whose execution
      // reverted — the failure surface is the `value.err` field, not a
      // thrown exception. Without this branch failed trades returned a
      // "success" SubmitReceipt.
      if (
        confirmation.value.err !== null &&
        confirmation.value.err !== undefined
      ) {
        const classified = classifySubmitError(
          confirmation.value.err,
          attempt,
          sig,
        );
        lastError = classified.error;
        if (classified.retryable && attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw classified.error;
      }

      return {
        txId: encodeSignatureRef(sig),
        confirmedAt: BigInt(Date.now()),
        fills: [], // AMM trades emit `PositionTraded` not orderbook fills.
        attempts: attempt,
      };
    }

    // Loop exited without returning — exhausted all retry attempts.
    throw (
      lastError ??
      new SoothError({
        kind: "NetworkError",
        msg: "submit: exhausted retries with no captured error",
        attempt: maxAttempts,
      })
    );
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

// H5 (Codex 2nd-pass): bounded retry/resend in submit().
//
// Cap mirrors the integrator-contract spec
// (`docs/implementation-guide.md §2`: "EVM always returns 1; Solana may
// return 1–5"). 5 ≈ ~6.2s of accumulated backoff worst case which is in line
// with Solana's blockhash validity window (~150 slots ≈ 60s) — we'll always
// see the blockhash expire before we exhaust the cap on a slow RPC.
const MAX_SUBMIT_ATTEMPTS = 5;

// Exponential backoff schedule between attempts (capped). Index 0 = the
// delay before the SECOND attempt; index 4 is unused (no 6th attempt).
const BACKOFF_MS = [200, 400, 800, 1600, 3200] as const;

function backoffMs(attempt: number): number {
  // attempt is the index of the JUST-FAILED attempt (1-based). The next
  // attempt waits BACKOFF_MS[attempt - 1].
  const i = Math.max(0, Math.min(BACKOFF_MS.length - 1, attempt - 1));
  return BACKOFF_MS[i] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  6012: {
    kind: "LockNotElapsed",
    msg: "Lock has not elapsed yet (now < lock_entry.unlock_at)",
  },
  6013: {
    kind: "LockVaultMismatch",
    msg: "Lock vault account does not match market.lock_vault",
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

// H5 (Codex 2nd-pass): classify a raw submit failure into:
//   - `retryable: true`  → transient (blockhash expired, node lag, RPC blip,
//     transaction-not-found after confirm timeout). Caller resends with a
//     fresh blockhash after backoff.
//   - `retryable: false` → terminal program error (custom code 6000-6011)
//     or terminal network error (signature mismatch, insufficient lamports
//     for rent, malformed message). Caller throws immediately.
//
// `decodeSubmitError` (above) preserves the existing per-code mapping for
// program errors. The classifier wraps it: program errors are always
// terminal, anything else is bucketed by string-matching `.message`.
function classifySubmitError(
  raw: unknown,
  attempt: number,
  signature: string | undefined,
): { retryable: boolean; error: SoothError } {
  const code = extractCustomCode(raw);
  if (code !== undefined) {
    // Program errors are deterministic — retrying with a new blockhash will
    // produce the exact same failure. Always terminal.
    const error = decodeSubmitError(raw, signature);
    // Re-stamp with `attempt` so receipts/logs see which attempt died.
    return {
      retryable: false,
      error: new SoothError({
        kind: error.kind,
        code: error.fields.code,
        msg: error.fields.msg,
        signature: error.fields.signature,
        attempt,
      }),
    };
  }

  // No custom program code — must be a network/RPC-level failure. Look at
  // the error message to decide retryable vs terminal.
  const text = errorText(raw);
  if (isRetryableNetworkText(text)) {
    return {
      retryable: true,
      error: new SoothError({
        kind: "NetworkError",
        msg: text,
        signature,
        attempt,
      }),
    };
  }

  // Terminal network error — signature failure, balance/rent issue, or
  // some other permanent condition. Surface as NetworkError (not
  // ProgramError — the program never ran).
  return {
    retryable: false,
    error: new SoothError({
      kind: "NetworkError",
      msg: text,
      signature,
      attempt,
    }),
  };
}

function makeNetworkError(
  raw: unknown,
  attempt: number,
  signature: string | undefined,
): SoothError {
  return new SoothError({
    kind: "NetworkError",
    msg: errorText(raw),
    signature,
    attempt,
  });
}

function errorText(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

// Heuristic: which RPC error strings indicate a transient/recoverable
// condition where re-sending with a fresh blockhash is likely to succeed?
//
// Sources:
//   - `BlockhashNotFound` — Solana validators GC blockhashes after ~150
//     slots; a slow client misses the window.
//   - `BlockhashExpired` — same root cause, different RPC wording.
//   - `Transaction was not confirmed` — confirmTransaction timeout; the tx
//     might have landed silently or might have expired. Re-sending is safe
//     because Solana dedupes by signature.
//   - generic "fetch failed" / "ECONNRESET" / "503" / "timeout" — RPC node
//     lag.
//
// We deliberately do NOT match on "InsufficientFundsForFee" or "signature
// verification failure" — those are permanent. Anything we don't recognize
// falls through as terminal.
function isRetryableNetworkText(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("blockhashnotfound") ||
    t.includes("blockhash not found") ||
    t.includes("blockhashexpired") ||
    t.includes("blockhash expired") ||
    t.includes("transaction was not confirmed") ||
    t.includes("transaction not found") ||
    t.includes("nodebehind") ||
    t.includes("node is behind") ||
    t.includes("503") ||
    t.includes("502") ||
    t.includes("econnreset") ||
    t.includes("etimedout") ||
    t.includes("fetch failed") ||
    t.includes("network error") ||
    t.includes("rate limit")
  );
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
