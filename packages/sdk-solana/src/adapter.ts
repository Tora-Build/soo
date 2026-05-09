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
  SYSVAR_INSTRUCTIONS_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

import {
  soothAdjudicatorIdl,
  soothAmmIdl,
  soothBookIdl,
  soothLaunchpadIdl,
  soothMarketIdl,
} from "./anchor/index.js";
import {
  costDelta,
  LN2_WAD,
  wadToUsdcCeil,
  yesPriceWad,
  WAD,
} from "./math/lmsr.js";
import {
  deriveAdjudicatorAllowlistPda,
  deriveAmmStatePda,
  deriveBookAuthorisedOperatorsPda,
  deriveBookEscrowPda,
  deriveBookFundingPda,
  deriveBookMarketLiquiditiesPda,
  deriveBookMarketPositionPda,
  deriveBookMarketPda,
  deriveBookMarketTypePda,
  deriveBookOrderPda,
  deriveBookOrderRequestQueuePda,
  deriveFeePoolVaultAta,
  deriveLockAuthorityPda,
  deriveAdjudicatorPda,
  deriveLockEntryPda,
  deriveLockVaultAta,
  deriveLpMintPda,
  deriveLpMintAuthorityPda,
  deriveLpYieldAuthority,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveNoMintPda,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  deriveYesMintPda,
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
  CompleteSetArgs,
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

export interface MintCompleteSetToProgramOwnedArgs {
  market: MarketRef;
  payer: AddressRef;
  destinationAuthority: AddressRef;
  destinationYesAta: AddressRef;
  destinationNoAta: AddressRef;
  amount: bigint;
}

export interface RedeemFromProgramOwnedArgs {
  market: MarketRef;
  burnAuthority: AddressRef;
  sourceYesAta: AddressRef;
  sourceNoAta: AddressRef;
  usdcDestination: AddressRef;
  amountYes: bigint;
  amountNo: bigint;
}

export interface MintIntoBookArgs {
  user: AddressRef;
  bookMarketPda: AddressRef;
  soothMarketPda: AddressRef;
  priceYes: bigint;
  stake: bigint;
  distinctSeedYes: bigint;
  distinctSeedNo: bigint;
}

export interface SettleRestingOrdersArgs {
  caller: AddressRef;
  bookMarketPda: AddressRef;
  soothMarketPda: AddressRef;
  orderPda: AddressRef;
  // Optional test/operator fast path. When omitted, the adapter fetches the
  // Order account and reads its purchaser field.
  orderPurchaser?: AddressRef;
}

export interface CreateBookMarketArgs {
  creator: AddressRef;
  soothMarketPda: AddressRef;
  eventAccount?: AddressRef;
  marketType?: AddressRef;
  marketTypeName?: string;
  marketTypeDiscriminator?: string | null;
  marketTypeValue?: string | null;
  title: string;
  maxDecimals?: number;
  marketLockTimestamp: bigint;
  eventStartTimestamp: bigint;
  marketLockOrderBehaviour?: "none" | "cancelUnmatched";
  existingBookMarketPda?: AddressRef;
  mint?: AddressRef;
}

// Resolved-once cache key — `Market` PDA layout is invariant across reads.
interface ResolvedMarket {
  marketPda: PublicKey;
  marketId: Uint8Array; // 16 bytes
  creator: PublicKey;
  adjudicator: PublicKey;
  questionHash: Uint8Array; // 32 bytes (raw — we don't have the original question on-chain)
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  startTime: bigint;
  deadline: bigint;
  lifecycle: "Initializing" | "Open" | "Locked" | "Settled";
  winningOutcome: number;
}

interface PriorityFeeCacheEntry {
  expiresAtMs: number;
  percentileMicroLamports: number;
}

// Anchor's IDL types are loose; we re-narrow at the boundary.
type AnyProgram = Program<Idl>;

type AnchorIxBuilder = {
  accounts(accounts: Record<string, PublicKey | null>): {
    instruction(): Promise<TransactionInstruction>;
  };
};

interface SoothMarketProgramOwnedMethods {
  mintCompleteSetToProgramOwned(amount: BN): AnchorIxBuilder;
  redeemFromProgramOwned(amountYes: BN, amountNo: BN): AnchorIxBuilder;
}

type BookMarketOrderBehaviourWire =
  | { none: Record<string, never> }
  | { cancelUnmatched: Record<string, never> };

interface SoothBookMethods {
  mintIntoBook(
    priceYes: BN,
    stake: BN,
    distinctSeedYes: BN,
    distinctSeedNo: BN,
  ): AnchorIxBuilder;
  settleRestingOrders(): AnchorIxBuilder;
  createMarket(
    soothMarketPda: PublicKey,
    eventAccount: PublicKey,
    marketTypeDiscriminator: string | null,
    marketTypeValue: string | null,
    title: string,
    maxDecimals: number,
    marketLockTimestamp: BN,
    eventStartTimestamp: BN,
    marketLockOrderBehaviour: BookMarketOrderBehaviourWire,
  ): AnchorIxBuilder;
}

const SOOTH_BOOK_DEFAULT_PROGRAM_ID = new PublicKey(
  "5gAMjRCaZfb4NtHmBf2RZHFJVLAAZQ1PBP6dRNPUTxkH",
);

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
  private readonly soothLaunchpad: AnyProgram;
  private readonly soothAdjudicator: AnyProgram;
  private readonly soothBook: AnyProgram;

  // Failing-program-ID → error code table. Populated at construction from the
  // resolved program IDs. Decoders use this to disambiguate Anchor codes
  // (e.g. 6012 means LockNotElapsed in sooth_amm but
  // AdjudicatorNotAllowlisted in sooth_market).
  private readonly programErrorLookup: ProgramErrorLookup;
  private readonly priorityFeeCache = new Map<string, PriorityFeeCacheEntry>();

  constructor(opts: SolanaAdapterOptions) {
    this.node = opts.node;

    // Resolve program IDs. Explicit override wins; otherwise read from the
    // node descriptor; otherwise fall back to the IDL `address` field
    // (placeholder IDs from the on-chain `declare_id!` macros).
    if (opts.programIds) {
      this.programIds = {
        ...opts.programIds,
        // `soothLaunchpad` is optional on the public surface but the adapter
        // needs it for `buildCreateMarket`. Fall back to the IDL placeholder.
        soothLaunchpad:
          opts.programIds.soothLaunchpad ??
          new PublicKey(soothLaunchpadIdl.address),
        // Same fallback story for sooth_adjudicator: required by
        // buildRequestLock / buildAttestOutcome (operator path).
        soothAdjudicator:
          opts.programIds.soothAdjudicator ??
          new PublicKey(soothAdjudicatorIdl.address),
        soothBook:
          opts.programIds.soothBook ??
          programIdOrFallback(
            (soothBookIdl as { address?: string }).address,
            SOOTH_BOOK_DEFAULT_PROGRAM_ID,
          ),
      };
    } else {
      const ammStr = opts.node.programs?.soothAmm ?? soothAmmIdl.address;
      const mktStr = opts.node.programs?.soothMarket ?? soothMarketIdl.address;
      const bookStr =
        (opts.node.programs as { soothBook?: string } | undefined)
          ?.soothBook ?? (soothBookIdl as { address?: string }).address;
      const lpStr =
        (opts.node.programs as { soothLaunchpad?: string } | undefined)
          ?.soothLaunchpad ?? soothLaunchpadIdl.address;
      const adjStr =
        (opts.node.programs as { soothAdjudicator?: string } | undefined)
          ?.soothAdjudicator ?? soothAdjudicatorIdl.address;
      this.programIds = {
        soothAmm: new PublicKey(ammStr),
        soothMarket: new PublicKey(mktStr),
        soothBook: programIdOrFallback(bookStr, SOOTH_BOOK_DEFAULT_PROGRAM_ID),
        soothLaunchpad: new PublicKey(lpStr),
        soothAdjudicator: new PublicKey(adjStr),
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
    const launchpadIdl = {
      ...soothLaunchpadIdl,
      address: (
        this.programIds.soothLaunchpad ??
        new PublicKey(soothLaunchpadIdl.address)
      ).toBase58(),
    };
    const adjudicatorIdl = {
      ...soothAdjudicatorIdl,
      address: (
        this.programIds.soothAdjudicator ??
        new PublicKey(soothAdjudicatorIdl.address)
      ).toBase58(),
    };
    const bookIdl = {
      ...soothBookIdl,
      address: (
        this.programIds.soothBook ?? SOOTH_BOOK_DEFAULT_PROGRAM_ID
      ).toBase58(),
    };
    this.soothAmm = new Program(ammIdl as Idl, provider);
    this.soothMarket = new Program(marketIdl as Idl, provider);
    this.soothLaunchpad = new Program(launchpadIdl as Idl, provider);
    this.soothAdjudicator = new Program(adjudicatorIdl as Idl, provider);
    this.soothBook = new Program(bookIdl as Idl, provider);

    // Build the program-ID → error-table lookup. sooth_adjudicator isn't
    // exposed as a separate `programIds` field today (the SDK doesn't build
    // adjudicator ixs directly), but its errors can still surface via CPI
    // from sooth_market/sooth_launchpad — pull its base58 ID off the IDL
    // so those decode cleanly too.
    this.programErrorLookup = new Map([
      [this.programIds.soothAmm.toBase58(), SOOTH_AMM_ERROR_TABLE],
      [this.programIds.soothMarket.toBase58(), SOOTH_MARKET_ERROR_TABLE],
      [
        (
          this.programIds.soothLaunchpad ??
          new PublicKey(soothLaunchpadIdl.address)
        ).toBase58(),
        SOOTH_LAUNCHPAD_ERROR_TABLE,
      ],
      [soothAdjudicatorIdl.address, SOOTH_ADJUDICATOR_ERROR_TABLE],
    ]);
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
    // Fee router live (Wave 1C-fee). Read `fee_bps` from `ProtocolConfig`
    // and mirror the on-chain floor formula:
    //   fee_wad = cost_wad * fee_bps / 10_000
    // The on-chain handler uses `cost_wad as u128 * fee_bps / 10_000`;
    // we operate on bigint here for parity. EVM analogue:
    // `FeeRouter._quoteFee:421`. Pre/post-graduation collapse to one bps
    // (architecture §8) so no graduation branch on this side either.
    const feeBps = await this.readProtocolFeeBps();
    const fee = cost > 0n ? (cost * BigInt(feeBps)) / 10_000n : 0n;
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
      lockedCostUsdc:
        (raw.lockedCostUsdc ?? raw.locked_cost_usdc) != null
          ? bnToBigInt(raw.lockedCostUsdc ?? raw.locked_cost_usdc)
          : undefined,
    };
  }

  async readGraduationProgress(market: MarketRef): Promise<{
    feesAccumulatedWad: bigint;
    thresholdWad: bigint;
    isGraduated: boolean;
    progressBps: number;
  }> {
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

    const feesAccumulatedWad = bnToBigInt(
      ammRaw.feeBBaseWad ?? ammRaw.fee_b_base_wad ?? 0,
    );
    const b = bnToBigInt(ammRaw.b);
    const thresholdWad = b > 0n ? (b * LN2_WAD) / WAD : 0n;
    const progress =
      thresholdWad > 0n
        ? Number((10_000n * feesAccumulatedWad) / thresholdWad)
        : 0;

    return {
      feesAccumulatedWad,
      thresholdWad,
      isGraduated: Boolean(ammRaw.isGraduated ?? ammRaw.is_graduated),
      progressBps: Math.max(0, Math.min(10_000, Math.floor(progress))),
    };
  }

  async readAmmState(
    market: MarketRef,
    user?: AddressRef,
  ): Promise<{
    market: MarketRef;
    creator: AddressRef;
    trialEndAt: bigint;
    isGraduated: boolean;
    isDismissed: boolean;
    feeBBaseWad: bigint;
    qYes: bigint;
    qNo: bigint;
    b: bigint;
    lockedCostUsdc: bigint;
  }> {
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

    let lockedCostUsdc = 0n;
    if (user) {
      const userPk = decodePubkeyRef(user);
      const pos = await this.readPositionInner(resolved.marketId, userPk);
      lockedCostUsdc = pos.lockedCostUsdc ?? 0n;
    }

    return {
      market,
      creator: `sol:${resolved.creator.toBase58()}`,
      trialEndAt: bnToBigInt(ammRaw.trialEndAt ?? ammRaw.trial_end_at ?? 0),
      isGraduated: Boolean(ammRaw.isGraduated ?? ammRaw.is_graduated),
      isDismissed: Boolean(ammRaw.isDismissed ?? ammRaw.is_dismissed),
      feeBBaseWad: bnToBigInt(ammRaw.feeBBaseWad ?? ammRaw.fee_b_base_wad ?? 0),
      qYes: bnToBigInt(ammRaw.qYes ?? ammRaw.q_yes ?? 0),
      qNo: bnToBigInt(ammRaw.qNo ?? ammRaw.q_no ?? 0),
      b: bnToBigInt(ammRaw.b ?? 0),
      lockedCostUsdc,
    };
  }

  async readLpRedemption(
    market: MarketRef,
    user: AddressRef,
  ): Promise<{
    market: MarketRef;
    lpMint: AddressRef;
    lpYieldVault: AddressRef;
    lpBalance: bigint;
    lpSupply: bigint;
    lpYieldVaultAmount: bigint;
    expectedPayoutForFullBalance: bigint;
    isGraduated: boolean;
  }> {
    const marketPda = decodePubkeyRef(market);
    const userPk = decodePubkeyRef(user);
    const resolved = await this.fetchMarket(marketPda);
    const amm = await this.readAmmState(market);
    if (!this.programIds.soothLaunchpad) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "readLpRedemption: programIds.soothLaunchpad is missing",
      });
    }

    const [lpMint] = deriveLpMintPda(resolved.marketId, {
      soothLaunchpad: this.programIds.soothLaunchpad,
    });
    const userLpAta = deriveUserLpAta(userPk, lpMint);
    const [lpYieldAuthority] = deriveLpYieldAuthority({
      soothLaunchpad: this.programIds.soothLaunchpad,
    });
    const lpYieldVault = getAssociatedTokenAddressSync(
      this.usdcMint,
      lpYieldAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const lpBalance = await getTokenAmountOrZero(this.connection, userLpAta);
    const lpYieldVaultAmount = await getTokenAmountOrZero(
      this.connection,
      lpYieldVault,
    );
    let lpSupply = 0n;
    try {
      lpSupply = (await getMint(this.connection, lpMint)).supply;
    } catch {
      lpSupply = 0n;
    }
    const expectedPayoutForFullBalance =
      lpSupply > 0n ? (lpYieldVaultAmount * lpBalance) / lpSupply : 0n;

    return {
      market,
      lpMint: `sol:${lpMint.toBase58()}`,
      lpYieldVault: `sol:${lpYieldVault.toBase58()}`,
      lpBalance,
      lpSupply,
      lpYieldVaultAmount,
      expectedPayoutForFullBalance,
      isGraduated: amm.isGraduated,
    };
  }

  async readPortfolio(_user: AddressRef): Promise<Portfolio> {
    notImplemented("readPortfolio");
  }

  /**
   * Fetch the per-market `Adjudicator` PDA. Operator UI calls this to
   * check whether the connected wallet is the registered authority for a
   * given market (and to surface the attested outcome / dispute state).
   *
   * Returns null when the PDA hasn't been initialized yet (the
   * register_adjudicator ix runs as part of create_market, so this should
   * only be null for malformed deployments).
   */
  async readAdjudicator(market: MarketRef): Promise<{
    market: string;
    authority: string;
    attestedOutcome: number | null;
    disputed: boolean;
  } | null> {
    const marketPda = decodePubkeyRef(market);
    if (!this.programIds.soothAdjudicator) return null;
    const [adjudicatorPda] = deriveAdjudicatorPda(marketPda, {
      ...this.programIds,
      soothAdjudicator: this.programIds.soothAdjudicator,
    });
    const raw = await (
      this.soothAdjudicator.account as any
    ).adjudicator.fetchNullable(adjudicatorPda);
    if (!raw) return null;
    const attested = raw.attestedOutcome;
    return {
      market: (raw.market as PublicKey).toBase58(),
      authority: (raw.authority as PublicKey).toBase58(),
      attestedOutcome:
        attested === null || attested === undefined ? null : Number(attested),
      disputed: !!raw.disputed,
    };
  }

  /**
   * Enumerate the user's pending sell-lock entries on a given market.
   *
   * Sells route USDC proceeds into a per-LockEntry PDA with a 24h cooldown
   * (`sooth_amm::sell_positions` → `LockEntry::unlock_at = now + 86400`).
   * `claim_unlocked` drains one matured LockEntry per call back to the
   * user's USDC ATA and closes the LockEntry account (rent → user).
   *
   * The PDA seed is `[b"lock_entry", positionPda, nonce_le_u64]` where
   * `nonce` ranges 0..Position.lock_nonce. We iterate the range and read
   * each candidate; surviving accounts (=unclaimed) come back with their
   * `amount_usdc` and `unlock_at`. Closed (=claimed) accounts are absent
   * and silently skipped.
   *
   * O(lock_nonce) RPC calls. Acceptable while users have <50 sells; for
   * heavier usage migrate to `getProgramAccounts` with an owner memcmp
   * filter at the LockEntry `user` offset.
   */
  async readPendingUnlocks(
    market: MarketRef,
    user: AddressRef,
  ): Promise<
    Array<{
      lockEntry: AddressRef;
      amountUsdc: bigint;
      unlockAt: bigint;
      nonce: bigint;
    }>
  > {
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const userPk = decodePubkeyRef(user);
    const [posPda] = derivePositionPda(
      resolved.marketId,
      userPk,
      this.programIds,
    );
    const positionRaw = await (
      this.soothAmm.account as any
    ).position.fetchNullable(posPda);
    if (!positionRaw) return [];
    const lockNonce = bnToBigInt(positionRaw.lockNonce);
    if (lockNonce === 0n) return [];

    // Derive every candidate PDA, then batch-fetch in groups of 100 (Solana
    // RPC's getMultipleAccounts cap). Existing accounts decode; absent ones
    // (=already claimed) skipped.
    const candidates: Array<{ pda: PublicKey; nonce: bigint }> = [];
    for (let n = 0n; n < lockNonce; n++) {
      const [pda] = deriveLockEntryPda(posPda, n, this.programIds);
      candidates.push({ pda, nonce: n });
    }

    const out: Array<{
      lockEntry: AddressRef;
      amountUsdc: bigint;
      unlockAt: bigint;
      nonce: bigint;
    }> = [];
    const CHUNK = 100;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const slice = candidates.slice(i, i + CHUNK);
      const infos = await this.connection.getMultipleAccountsInfo(
        slice.map((c) => c.pda),
      );
      for (let j = 0; j < slice.length; j++) {
        const info = infos[j];
        if (!info) continue;
        const data = Buffer.from(info.data);
        // 8 disc + 32 user + 32 market = 72 → amount_usdc (u64 LE)
        const amountUsdc = data.readBigUInt64LE(72);
        // 80 → unlock_at (i64 LE)
        const unlockAt = data.readBigInt64LE(80);
        out.push({
          lockEntry: `sol:${slice[j].pda.toBase58()}`,
          amountUsdc,
          unlockAt,
          nonce: slice[j].nonce,
        });
      }
    }
    return out;
  }

  /**
   * Fetch the singleton `ProtocolConfig` and return its `fee_bps`.
   *
   * Reads via the launchpad Anchor account decoder so changes to
   * `ProtocolConfig`'s field list trip a decode error rather than a
   * silently-misaligned offset (the on-chain side guards the same way
   * via the `sooth-account-offsets` cross-crate assertion).
   *
   * Returns 0 if the config PDA hasn't been initialized — the on-chain
   * `trade_positions` will then reject the build because the same PDA
   * is in the account list with `seeds=[b"protocol_config"]`. The
   * graceful 0 here means `readQuote` previews zero fee on a fresh
   * cluster instead of throwing during the read path.
   */
  private async readProtocolFeeBps(): Promise<number> {
    const [cfgPda] = deriveProtocolConfigPda(
      this.programIds as {
        soothLaunchpad: PublicKey;
      },
    );
    const raw = await (
      this.soothLaunchpad.account as any
    ).protocolConfig.fetchNullable(cfgPda);
    if (!raw) {
      return 0;
    }
    // `fee_bps` is `u16` on-chain; Anchor's coder returns it as a JS
    // number directly (not BN, not bigint) — keep that type through.
    return Number(raw.feeBps ?? raw.fee_bps ?? 0);
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
    // Wave 1C-fee: ProtocolConfig + global fee_pool_vault are now in the
    // account list. Both are derived deterministically — `protocolConfig`
    // is the singleton at `[b"protocol_config"]` under the launchpad
    // program, and `feePoolVault` is the ATA of the singleton
    // `fee_pool_authority` PDA (also under the launchpad program). The
    // ATA may not be initialized on a fresh cluster — see
    // `programs/sooth_launchpad/docs` for the bootstrap sequence.
    const [protocolConfig] = deriveProtocolConfigPda(
      this.programIds as {
        soothLaunchpad: PublicKey;
      },
    );
    const feePoolVault = deriveFeePoolVaultAta(
      this.usdcMint,
      this.programIds as {
        soothLaunchpad: PublicKey;
      },
    );

    // LP-mint plumbing for the pre-graduation buy path (architecture §4.2).
    // `trade_positions` CPIs into `sooth_launchpad::mint_lp_for_buy` on
    // every pre-graduation buy and credits the trader's LP ATA. The
    // launchpad-side ix is a no-op when `amm.is_graduated == true`, but
    // Anchor still requires the accounts to be present in the account list
    // — so we always derive and pass them.
    const launchpadProgramId = (
      this.programIds as { soothLaunchpad: PublicKey }
    ).soothLaunchpad;
    const [lpMint] = deriveLpMintPda(resolved.marketId, {
      soothLaunchpad: launchpadProgramId,
    });
    const [lpMintAuthority] = deriveLpMintAuthorityPda(resolved.marketId, {
      soothLaunchpad: launchpadProgramId,
    });
    const userLpAta = deriveUserLpAta(userPk, lpMint);

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
        protocolConfig,
        feePoolVault,
        lpMint,
        lpMintAuthority,
        userLpAta,
        user: userPk,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        soothLaunchpadProgram: launchpadProgramId,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Idempotent ATA-create for the user's LP ATA. The Anchor
    // `token::authority = user, token::mint = lp_mint` constraint on
    // `user_lp_ata` requires the account to exist when `trade_positions`
    // runs. A fresh trader has no LP ATA on first buy; this prepended ix
    // creates it (no-op if it already exists). Same convention as the
    // user_usdc_ata pattern: creation is the SDK's responsibility, not
    // the program's.
    //
    // Carried through `meta.preIxs` so `submit()` can replay it under a
    // fresh blockhash without re-deriving — the ATA-create ix is data-only
    // (no per-blockhash content), so the identical bytes are valid every
    // attempt.
    const lpAtaCreateIx = createAssociatedTokenAccountIdempotentInstruction(
      userPk, // payer
      userLpAta,
      userPk, // owner
      lpMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const tx = new Transaction();
    // Generous CU bump — `trade_positions` benched ~75-80k per the spike but
    // `init_if_needed` on the first Position adds rent payer overhead.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(lpAtaCreateIx);
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
        ...buildIxMeta(ix, userPk),
        // Pre-ixs replayed by `submit()` ahead of the trade ix. Currently
        // a single idempotent ATA-create for `user_lp_ata` (architecture
        // §4.2 LP-mint side-effect requires the trader's LP ATA to exist
        // before `trade_positions` runs).
        preIxs: [serializeIx(lpAtaCreateIx)],
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
        // Auth-gap closer: `transfer_to_lock` reads the Instructions sysvar
        // to verify a parent `sell_positions` ix exists in the same tx. The
        // sysvar account is forwarded through this AMM ix to the helper CPI.
        // The IDL pin (`address = Sysvar1nstructions...`) means Anchor would
        // resolve it automatically, but we pass explicitly to keep the
        // intent visible at the call site.
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Cost estimate via the same off-chain LMSR port. For sells, `cost` is
    // negative (proceeds back to the user); we surface |cost| as the
    // estimate so the field stays unsigned for downstream UI parity with
    // the buy path.
    const quote = await this.readQuote(market, args.outcome, wireDelta);
    const proceedsAbs = quote.cost < 0n ? -quote.cost : quote.cost;

    const accounts = ixKeysToShim(ix.keys);

    return {
      kind: "trade",
      serializedTx: undefined,
      costEstimateWad: proceedsAbs,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: "sell",
        deltaSharesStr: wireDelta.toString(),
        minProceedsWadStr: minProceedsWad.toString(),
        outcome: args.outcome,
        lockEntryPda: lockEntryPda.toBase58(),
        lockNonceStr: lockNonce.toString(),
      },
    };
  }

  // ─── Claim path ────────────────────────────────────────────────────────
  //
  // The integrator-contract spec types `buildClaim(market, args: ClaimArgs)`
  // and earmarks it for "Settlement redemption" (`useClaim` /
  // `buildClaimRequest`). On Solana there are TWO distinct post-trade USDC
  // outflows that share the "claim" semantic surface:
  //
  //   1. `kind: 'unlock'` — drain a `LockEntry` from the AMM sell-with-lock
  //      cooldown (Wave 1A `sooth_amm::claim_unlocked`). This is the EVM
  //      `claimUnlocked(maxClaims)` analogue. One LockEntry per call mirrors
  //      the on-chain handler (see `claim_unlocked.rs`).
  //
  //   2. `kind: 'redeem'` — post-settlement redemption against the resolved
  //      outcome (`sooth_market::redeem`). EVM `OrderEngine.settlePosition`
  //      analogue; pays out per `TruthMarket.getRedemptionValue`.
  //
  // The discriminator dispatches between them. Default = `'unlock'` to
  // preserve the Wave 4 call shape (existing tests don't pass `kind`).
  // Both paths return a `ClaimRequest` with `kind: 'claim'` at the wire
  // level so `client.submit` is unchanged.
  async buildClaim(
    market: MarketRef,
    args: ClaimArgs & {
      user?: AddressRef;
      lockEntry?: AddressRef;
      kind?: "unlock" | "redeem";
    },
  ): Promise<ClaimRequest> {
    const user = args.user;
    if (!user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildClaim — args.user (Solana-only meta) is required at build time",
      });
    }
    const userPk = decodePubkeyRef(user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);

    const dispatchKind = args.kind ?? "unlock";

    if (dispatchKind === "redeem") {
      // ── Post-settlement redemption — sooth_market::redeem ────────────
      //
      // No CPI fan-out: `redeem` owns its own vault transfer + outcome-
      // token burns directly (the vault_authority PDA is `sooth_market`-
      // owned). The user signs the burn (their ATA is the burn source).
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
      const userYesAta = getAssociatedTokenAddressSync(
        resolved.yesMint,
        userPk,
      );
      const userNoAta = getAssociatedTokenAddressSync(resolved.noMint, userPk);

      const ix: TransactionInstruction = await (this.soothMarket.methods as any)
        .redeem()
        .accounts({
          market: marketPda,
          vaultAuthority,
          yesMint: resolved.yesMint,
          noMint: resolved.noMint,
          vault: marketVault,
          userUsdcAta,
          userYesAta,
          userNoAta,
          user: userPk,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      const accounts = ixKeysToShim(ix.keys);

      return {
        kind: "claim",
        serializedTx: undefined,
        accounts,
        meta: {
          marketPda: marketPda.toBase58(),
          ...buildIxMeta(ix, userPk),
          operation: "redeem",
          winningOutcome: resolved.winningOutcome,
        },
      };
    }

    // ── Default: AMM lock-claim — sooth_amm::claim_unlocked ────────────
    const lockEntryRef = args.lockEntry;
    if (!lockEntryRef) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildClaim — args.lockEntry (Solana-only meta; the LockEntry PDA to drain) is required for kind='unlock'",
      });
    }
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
        // Auth-gap closer: `transfer_from_lock_vault` reads the Instructions
        // sysvar to verify a parent `claim_unlocked` ix exists in the same
        // tx. Forwarded through this AMM ix to the helper CPI. See the
        // matching comment in `buildSell`.
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);

    return {
      kind: "claim",
      serializedTx: undefined,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: "claim",
        lockEntryPda: lockEntryPda.toBase58(),
      },
    };
  }

  async buildClaimRefund(
    market: MarketRef,
    args: { user: AddressRef },
  ): Promise<ClaimRequest> {
    if (!args.user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildClaimRefund — args.user (Solana-only meta) is required at build time",
      });
    }
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);

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
    const marketVault = deriveMarketVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );
    const userUsdcAta = deriveUserUsdcAta(userPk, this.usdcMint);

    const ix: TransactionInstruction = await (this.soothMarket.methods as any)
      .claimRefund()
      .accounts({
        user: userPk,
        market: marketPda,
        ammState: ammPda,
        vaultAuthority,
        marketVault,
        userUsdcAta,
        position: positionPda,
        usdcMint: this.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        soothAmmProgram: this.programIds.soothAmm,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "claim",
      serializedTx: undefined,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: "claimRefund",
        positionPda: positionPda.toBase58(),
      },
    };
  }

  async buildDismissMarket(
    market: MarketRef,
    args: { user: AddressRef },
  ): Promise<TradeRequest> {
    if (!args.user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildDismissMarket — args.user (Solana-only meta) is required at build time",
      });
    }
    const creatorPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [ammPda] = deriveAmmStatePda(resolved.marketId, this.programIds);

    const ix: TransactionInstruction = await (this.soothAmm.methods as any)
      .dismissMarket()
      .accounts({
        market: marketPda,
        ammState: ammPda,
        creator: creatorPk,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, creatorPk),
        operation: "dismissMarket",
      },
    };
  }

  async buildRedeemLp(
    market: MarketRef,
    args: { user: AddressRef; lpAmount: bigint },
  ): Promise<ClaimRequest> {
    if (!args.user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildRedeemLp — args.user (Solana-only meta) is required at build time",
      });
    }
    if (args.lpAmount <= 0n || args.lpAmount > 0xffffffffffffffffn) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `buildRedeemLp: lpAmount must fit in u64 and be > 0, got ${args.lpAmount.toString()}`,
      });
    }
    if (!this.programIds.soothLaunchpad) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildRedeemLp: programIds.soothLaunchpad is missing",
      });
    }

    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [ammPda] = deriveAmmStatePda(resolved.marketId, this.programIds);
    const [lpMint] = deriveLpMintPda(resolved.marketId, {
      soothLaunchpad: this.programIds.soothLaunchpad,
    });
    const userLpAta = deriveUserLpAta(userPk, lpMint);
    const [lpYieldAuthority] = deriveLpYieldAuthority({
      soothLaunchpad: this.programIds.soothLaunchpad,
    });
    const lpYieldVault = getAssociatedTokenAddressSync(
      this.usdcMint,
      lpYieldAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userUsdcAta = deriveUserUsdcAta(userPk, this.usdcMint);

    const ix: TransactionInstruction = await (
      this.soothLaunchpad.methods as any
    )
      .redeemLp(bigIntToBn(args.lpAmount))
      .accounts({
        ammState: ammPda,
        lpMint,
        userLpAta,
        lpYieldVault,
        lpYieldAuthority,
        userUsdcAta,
        user: userPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "claim",
      serializedTx: undefined,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: "redeemLp",
        lpAmountStr: args.lpAmount.toString(),
        lpYieldVault: lpYieldVault.toBase58(),
      },
    };
  }

  async buildRedeemFromProgramOwned(
    args: RedeemFromProgramOwnedArgs,
  ): Promise<ClaimRequest> {
    if (args.amountYes < 0n || args.amountNo < 0n) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildRedeemFromProgramOwned: amounts must be non-negative",
      });
    }
    if (args.amountYes === 0n && args.amountNo === 0n) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildRedeemFromProgramOwned: at least one amount must be positive",
      });
    }

    const burnAuthorityPk = decodePubkeyRef(args.burnAuthority);
    const marketPda = decodePubkeyRef(args.market);
    const sourceYesAta = decodePubkeyRef(args.sourceYesAta);
    const sourceNoAta = decodePubkeyRef(args.sourceNoAta);
    const usdcDestination = decodePubkeyRef(args.usdcDestination);
    const resolved = await this.fetchMarket(marketPda);

    const [vaultAuthority] = deriveVaultAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const marketVault = deriveMarketVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );

    const methods = this.soothMarket
      .methods as unknown as SoothMarketProgramOwnedMethods;
    const ix: TransactionInstruction = await methods
      .redeemFromProgramOwned(
        bigIntToBn(args.amountYes),
        bigIntToBn(args.amountNo),
      )
      .accounts({
        market: marketPda,
        vaultAuthority,
        yesMint: resolved.yesMint,
        noMint: resolved.noMint,
        usdcMint: this.usdcMint,
        marketVault,
        sourceYesAta,
        sourceNoAta,
        usdcDestination,
        burnAuthority: burnAuthorityPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "claim",
      serializedTx: undefined,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, burnAuthorityPk),
        operation: "redeemFromProgramOwned",
        amountYesStr: args.amountYes.toString(),
        amountNoStr: args.amountNo.toString(),
      },
    };
  }

  // ─── Mint / merge complete-set ─────────────────────────────────────────
  //
  // 1 USDC ↔ 1·WAD YES + 1·WAD NO at parity. No price impact, no fee.
  // mint   : N USDC in   → N·WAD YES + N·WAD NO out
  // merge  : N·WAD YES + N·WAD NO in → N USDC out
  //
  // Both routes lower into `sooth_market::{mint,merge}_complete_set`
  // (architecture §4.5). `amount` is the USDC base-unit (u64) value the
  // on-chain ix expects.
  //
  // The mint path includes idempotent-ATA-create preIxs for the user's
  // YES/NO outcome ATAs so first-time mints don't require a separate
  // account-bootstrap tx. The merge path can assume those ATAs already
  // exist (you can only merge tokens you already hold).
  async buildMintCompleteSet(
    market: MarketRef,
    args: CompleteSetArgs,
  ): Promise<TradeRequest> {
    return this.buildCompleteSetInner(market, args, "mint");
  }

  async buildMintCompleteSetToProgramOwned(
    args: MintCompleteSetToProgramOwnedArgs,
  ): Promise<TradeRequest> {
    if (args.amount <= 0n) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildMintCompleteSetToProgramOwned: amount must be positive",
      });
    }

    const payerPk = decodePubkeyRef(args.payer);
    const destinationAuthority = decodePubkeyRef(args.destinationAuthority);
    const destinationYesAta = decodePubkeyRef(args.destinationYesAta);
    const destinationNoAta = decodePubkeyRef(args.destinationNoAta);
    const marketPda = decodePubkeyRef(args.market);
    const resolved = await this.fetchMarket(marketPda);

    const [vaultAuthority] = deriveVaultAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const marketVault = deriveMarketVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );
    const payerUsdcAta = deriveUserUsdcAta(payerPk, this.usdcMint);

    const methods = this.soothMarket
      .methods as unknown as SoothMarketProgramOwnedMethods;
    const ix: TransactionInstruction = await methods
      .mintCompleteSetToProgramOwned(bigIntToBn(args.amount))
      .accounts({
        market: marketPda,
        vaultAuthority,
        yesMint: resolved.yesMint,
        noMint: resolved.noMint,
        usdcMint: this.usdcMint,
        marketVault,
        payerUsdcAta,
        destinationAuthority,
        destinationYesAta,
        destinationNoAta,
        payer: payerPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const yesAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      payerPk,
      destinationYesAta,
      destinationAuthority,
      resolved.yesMint,
    );
    const noAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      payerPk,
      destinationNoAta,
      destinationAuthority,
      resolved.noMint,
    );
    const preIxs = [serializeIx(yesAtaIx), serializeIx(noAtaIx)];

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "trade",
      serializedTx: undefined,
      costEstimateWad: args.amount * 1_000_000_000_000n,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, payerPk),
        operation: "mintCompleteSetToProgramOwned",
        amountStr: args.amount.toString(),
        preIxs,
      },
    };
  }

  async buildMergeCompleteSet(
    market: MarketRef,
    args: CompleteSetArgs,
  ): Promise<TradeRequest> {
    return this.buildCompleteSetInner(market, args, "merge");
  }

  private async buildCompleteSetInner(
    market: MarketRef,
    args: CompleteSetArgs,
    kind: "mint" | "merge",
  ): Promise<TradeRequest> {
    if (!args.user) {
      throw new SoothError({
        kind: "NotImplemented",
        method: `build${kind === "mint" ? "Mint" : "Merge"}CompleteSet — args.user (Solana-only meta) is required at build time`,
      });
    }
    if (args.amount <= 0n) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `build${kind === "mint" ? "Mint" : "Merge"}CompleteSet: amount must be positive`,
      });
    }
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);

    const [vaultAuthority] = deriveVaultAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const [yesMint] = deriveYesMintPda(resolved.marketId, this.programIds);
    const [noMint] = deriveNoMintPda(resolved.marketId, this.programIds);
    const marketVault = deriveMarketVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );
    const userUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, userPk);
    const userYesAta = getAssociatedTokenAddressSync(yesMint, userPk);
    const userNoAta = getAssociatedTokenAddressSync(noMint, userPk);

    const methodName = kind === "mint" ? "mintCompleteSet" : "mergeCompleteSet";
    const ix: TransactionInstruction = await (this.soothMarket.methods as any)
      [methodName](bigIntToBn(args.amount))
      .accounts({
        market: marketPda,
        vaultAuthority,
        yesMint,
        noMint,
        vault: marketVault,
        userUsdcAta,
        userYesAta,
        userNoAta,
        user: userPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // Idempotent ATA creates for the outcome tokens. Mint must have these
    // present (they receive the new tokens); merge must have these present
    // with non-zero balance (the ix burns from them). Either way, prepending
    // the idempotent create is safe — it's a no-op when the ATA exists.
    const preIxs: Array<{
      programId: string;
      keys: Array<{
        pubkey: string;
        isSigner: boolean;
        isWritable: boolean;
      }>;
      data: string;
    }> = [];
    if (kind === "mint") {
      const yesAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        userPk,
        userYesAta,
        userPk,
        yesMint,
      );
      const noAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        userPk,
        userNoAta,
        userPk,
        noMint,
      );
      for (const p of [yesAtaIx, noAtaIx]) {
        preIxs.push(serializeIx(p));
      }
    }

    const accounts = ixKeysToShim(ix.keys);

    return {
      kind: "trade",
      serializedTx: undefined,
      // Cost estimate: 1 USDC = 1·WAD shares, so the WAD-side estimate is
      // amount * 1e12 (USDC base units → WAD).
      costEstimateWad: args.amount * 1_000_000_000_000n,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: kind === "mint" ? "mintCompleteSet" : "mergeCompleteSet",
        amountStr: args.amount.toString(),
        preIxs,
      },
    };
  }

  // ─── Operator path (request_lock / attest_outcome) ─────────────────────
  //
  // Both ixs live on `sooth_adjudicator` and CPI into `sooth_market`:
  //   request_lock      → sooth_market::lock_for_resolution
  //                       (Market.lifecycle: Open → Locked)
  //   attest_outcome(o) → sooth_market::settle(winning_outcome=o)
  //                       (Market.lifecycle: Locked → Settled, sets
  //                        Market.winning_outcome)
  //
  // The signer must be `Adjudicator.authority` (set at register_adjudicator
  // time). v1 Manual variant — future ZkTLS / agent variants would
  // replace the auth check with verifier-program logic.

  async buildRequestLock(
    market: MarketRef,
    args: { user: AddressRef },
  ): Promise<TradeRequest> {
    if (!args.user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildRequestLock — args.user (Solana-only meta) is required at build time",
      });
    }
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    if (!this.programIds.soothAdjudicator) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildRequestLock: programIds.soothAdjudicator is missing",
      });
    }
    const [adjudicatorPda] = deriveAdjudicatorPda(marketPda, {
      ...this.programIds,
      soothAdjudicator: this.programIds.soothAdjudicator,
    });

    const ix: TransactionInstruction = await (
      this.soothAdjudicator.methods as any
    )
      .requestLock()
      .accounts({
        adjudicator: adjudicatorPda,
        market: marketPda,
        authority: userPk,
        soothMarketProgram: this.programIds.soothMarket,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: "requestLock",
      },
    };
  }

  async buildAttestOutcome(
    market: MarketRef,
    args: { user: AddressRef; winningOutcome: 0 | 1 | 2 },
  ): Promise<TradeRequest> {
    if (!args.user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildAttestOutcome — args.user (Solana-only meta) is required at build time",
      });
    }
    if (![0, 1, 2].includes(args.winningOutcome)) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `buildAttestOutcome: winningOutcome must be 0/1/2, got ${args.winningOutcome}`,
      });
    }
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    if (!this.programIds.soothAdjudicator) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildAttestOutcome: programIds.soothAdjudicator is missing",
      });
    }
    const [adjudicatorPda] = deriveAdjudicatorPda(marketPda, {
      ...this.programIds,
      soothAdjudicator: this.programIds.soothAdjudicator,
    });

    const ix: TransactionInstruction = await (
      this.soothAdjudicator.methods as any
    )
      .attestOutcome(args.winningOutcome)
      .accounts({
        adjudicator: adjudicatorPda,
        market: marketPda,
        authority: userPk,
        soothMarketProgram: this.programIds.soothMarket,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: "attestOutcome",
        winningOutcome: args.winningOutcome,
      },
    };
  }

  // ─── sooth_book order lifecycle builders ──────────────────────────────

  async buildMintIntoBook(args: MintIntoBookArgs): Promise<TradeRequest> {
    assertU128(args.priceYes, "buildMintIntoBook: priceYes");
    assertU64(args.stake, "buildMintIntoBook: stake");
    assertU64(args.distinctSeedYes, "buildMintIntoBook: distinctSeedYes");
    assertU64(args.distinctSeedNo, "buildMintIntoBook: distinctSeedNo");
    if (args.stake <= 0n) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildMintIntoBook: stake must be positive",
      });
    }

    const bookPrograms = this.bookProgramIds();
    const userPk = decodePubkeyRef(args.user);
    const soothMarketPda = decodePubkeyRef(args.soothMarketPda);
    const bookMarketPda = decodePubkeyRef(args.bookMarketPda);
    const [expectedBookMarket] = deriveBookMarketPda(
      soothMarketPda,
      bookPrograms,
    );
    assertPublicKeyEquals(
      bookMarketPda,
      expectedBookMarket,
      "buildMintIntoBook: bookMarketPda",
    );

    const resolved = await this.fetchMarket(soothMarketPda);
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
    const [bookEscrowAuthority] = deriveBookEscrowPda(
      bookMarketPda,
      bookPrograms,
    );
    const marketEscrowYes = getAssociatedTokenAddressSync(
      resolved.yesMint,
      bookEscrowAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const marketEscrowNo = getAssociatedTokenAddressSync(
      resolved.noMint,
      bookEscrowAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const [orderYes] = deriveBookOrderPda(
      bookMarketPda,
      args.distinctSeedYes,
      bookPrograms,
    );
    const [orderNo] = deriveBookOrderPda(
      bookMarketPda,
      args.distinctSeedNo,
      bookPrograms,
    );
    const [marketLiquidities] = deriveBookMarketLiquiditiesPda(
      bookMarketPda,
      bookPrograms,
    );
    const [marketPosition] = deriveBookMarketPositionPda(
      bookMarketPda,
      userPk,
      bookPrograms,
    );
    const [orderRequestQueue] = deriveBookOrderRequestQueuePda(
      bookMarketPda,
      bookPrograms,
    );

    const methods = this.soothBook.methods as unknown as SoothBookMethods;
    const ix: TransactionInstruction = await methods
      .mintIntoBook(
        bigIntToBn(args.priceYes),
        bigIntToBn(args.stake),
        bigIntToBn(args.distinctSeedYes),
        bigIntToBn(args.distinctSeedNo),
      )
      .accounts({
        user: userPk,
        userUsdcAta,
        usdcMint: this.usdcMint,
        marketPda: soothMarketPda,
        vaultAuthority,
        yesMint: resolved.yesMint,
        noMint: resolved.noMint,
        marketVault,
        bookMarket: bookMarketPda,
        marketEscrowYes,
        marketEscrowNo,
        bookMarketEscrowAuthority: bookEscrowAuthority,
        orderYes,
        orderNo,
        marketLiquidities,
        marketPosition,
        soothMarketProgram: this.programIds.soothMarket,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const yesAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      userPk,
      marketEscrowYes,
      bookEscrowAuthority,
      resolved.yesMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const noAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      userPk,
      marketEscrowNo,
      bookEscrowAuthority,
      resolved.noMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "trade",
      serializedTx: undefined,
      costEstimateWad: args.stake * 1_000_000_000_000n,
      accounts,
      meta: {
        marketPda: soothMarketPda.toBase58(),
        bookMarketPda: bookMarketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: "mintIntoBook",
        priceYesStr: args.priceYes.toString(),
        stakeStr: args.stake.toString(),
        distinctSeedYesStr: args.distinctSeedYes.toString(),
        distinctSeedNoStr: args.distinctSeedNo.toString(),
        marketEscrowYes: marketEscrowYes.toBase58(),
        marketEscrowNo: marketEscrowNo.toBase58(),
        bookMarketEscrowAuthority: bookEscrowAuthority.toBase58(),
        orderYes: orderYes.toBase58(),
        orderNo: orderNo.toBase58(),
        marketLiquidities: marketLiquidities.toBase58(),
        marketPosition: marketPosition.toBase58(),
        orderRequestQueue: orderRequestQueue.toBase58(),
        preIxs: [serializeIx(yesAtaIx), serializeIx(noAtaIx)],
      },
    };
  }

  async buildSettleRestingOrders(
    args: SettleRestingOrdersArgs,
  ): Promise<ClaimRequest> {
    const bookPrograms = this.bookProgramIds();
    const callerPk = decodePubkeyRef(args.caller);
    const soothMarketPda = decodePubkeyRef(args.soothMarketPda);
    const bookMarketPda = decodePubkeyRef(args.bookMarketPda);
    const orderPda = decodePubkeyRef(args.orderPda);
    const [expectedBookMarket] = deriveBookMarketPda(
      soothMarketPda,
      bookPrograms,
    );
    assertPublicKeyEquals(
      bookMarketPda,
      expectedBookMarket,
      "buildSettleRestingOrders: bookMarketPda",
    );

    const resolved = await this.fetchMarket(soothMarketPda);
    const orderPurchaser = args.orderPurchaser
      ? decodePubkeyRef(args.orderPurchaser)
      : await this.fetchBookOrderPurchaser(orderPda);
    const [soothMarketVaultAuthority] = deriveVaultAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const soothMarketVault = deriveMarketVaultAta(
      resolved.marketId,
      this.usdcMint,
      this.programIds,
    );
    const [marketEscrowAuthority] = deriveBookEscrowPda(
      bookMarketPda,
      bookPrograms,
    );
    const marketEscrowYes = getAssociatedTokenAddressSync(
      resolved.yesMint,
      marketEscrowAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const marketEscrowNo = getAssociatedTokenAddressSync(
      resolved.noMint,
      marketEscrowAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const purchaserUsdcAta = deriveUserUsdcAta(orderPurchaser, this.usdcMint);

    const methods = this.soothBook.methods as unknown as SoothBookMethods;
    const ix: TransactionInstruction = await methods
      .settleRestingOrders()
      .accounts({
        adjudicator: resolved.adjudicator,
        soothMarketPda,
        bookMarket: bookMarketPda,
        order: orderPda,
        orderPurchaser,
        yesMint: resolved.yesMint,
        noMint: resolved.noMint,
        usdcMint: this.usdcMint,
        soothMarketVault,
        soothMarketVaultAuthority,
        marketEscrowYes,
        marketEscrowNo,
        marketEscrowAuthority,
        purchaserUsdcAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        soothMarketProgram: this.programIds.soothMarket,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "claim",
      serializedTx: undefined,
      accounts,
      meta: {
        marketPda: soothMarketPda.toBase58(),
        bookMarketPda: bookMarketPda.toBase58(),
        ...buildIxMeta(ix, callerPk),
        operation: "settleRestingOrders",
        orderPda: orderPda.toBase58(),
        orderPurchaser: orderPurchaser.toBase58(),
        purchaserUsdcAta: purchaserUsdcAta.toBase58(),
        soothMarketVault: soothMarketVault.toBase58(),
        marketEscrowYes: marketEscrowYes.toBase58(),
        marketEscrowNo: marketEscrowNo.toBase58(),
      },
    };
  }

  async buildCreateBookMarket(
    args: CreateBookMarketArgs,
  ): Promise<CreateMarketRequest> {
    assertI64(args.marketLockTimestamp, "buildCreateBookMarket: marketLockTimestamp");
    assertI64(args.eventStartTimestamp, "buildCreateBookMarket: eventStartTimestamp");

    const bookPrograms = this.bookProgramIds();
    const creatorPk = decodePubkeyRef(args.creator);
    const soothMarketPda = decodePubkeyRef(args.soothMarketPda);
    const eventAccount = args.eventAccount
      ? decodePubkeyRef(args.eventAccount)
      : soothMarketPda;
    const marketType = args.marketType
      ? decodePubkeyRef(args.marketType)
      : args.marketTypeName
        ? deriveBookMarketTypePda(args.marketTypeName, bookPrograms)[0]
        : undefined;
    if (!marketType) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildCreateBookMarket — either marketType or marketTypeName is required",
      });
    }
    const [bookMarketPda] = deriveBookMarketPda(soothMarketPda, bookPrograms);
    const [escrow] = deriveBookEscrowPda(bookMarketPda, bookPrograms);
    const [funding] = deriveBookFundingPda(bookMarketPda, bookPrograms);
    const [authorisedOperators] = deriveBookAuthorisedOperatorsPda(
      "MARKET",
      bookPrograms,
    );
    const mint = args.mint ? decodePubkeyRef(args.mint) : this.usdcMint;
    const existingMarket = args.existingBookMarketPda
      ? decodePubkeyRef(args.existingBookMarketPda)
      : null;
    const maxDecimals = args.maxDecimals ?? 3;
    const behaviour = bookMarketOrderBehaviour(
      args.marketLockOrderBehaviour ?? "none",
    );

    const methods = this.soothBook.methods as unknown as SoothBookMethods;
    const ix: TransactionInstruction = await methods
      .createMarket(
        soothMarketPda,
        eventAccount,
        args.marketTypeDiscriminator ?? null,
        args.marketTypeValue ?? null,
        args.title,
        maxDecimals,
        bigIntToBn(args.marketLockTimestamp),
        bigIntToBn(args.eventStartTimestamp),
        behaviour,
      )
      .accounts({
        existingMarket,
        market: bookMarketPda,
        escrow,
        marketType,
        funding,
        rent: SYSVAR_RENT_PUBKEY,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        marketOperator: creatorPk,
        authorisedOperators,
      })
      .instruction();

    const accounts = ixKeysToShim(ix.keys);
    return {
      kind: "createMarket",
      serializedTx: undefined,
      costEstimateWad: 0n,
      accounts,
      meta: {
        marketPda: bookMarketPda.toBase58(),
        bookMarketPda: bookMarketPda.toBase58(),
        soothMarketPda: soothMarketPda.toBase58(),
        ...buildIxMeta(ix, creatorPk),
        operation: "createBookMarket",
        eventAccount: eventAccount.toBase58(),
        marketType: marketType.toBase58(),
        escrow: escrow.toBase58(),
        funding: funding.toBase58(),
        authorisedOperators: authorisedOperators.toBase58(),
        maxDecimals,
        marketLockTimestampStr: args.marketLockTimestamp.toString(),
        eventStartTimestampStr: args.eventStartTimestamp.toString(),
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
    args: CreateMarketArgs,
  ): Promise<CreateMarketRequest> {
    // The on-chain `sooth_launchpad::create_market` ix composes the four-leg
    // init flow from `sooth_market` + `sooth_amm` into a single tx. See
    // `programs/sooth_launchpad/src/instructions/create_market.rs` for the
    // CPI body and architecture §4.1 for the call chain.
    //
    // Solana-only meta channel: the user pubkey (creator + payer for every
    // CPI leg) is required at build time — we need it to sign the tx and to
    // populate `creator` on the ix. Same pattern as `buildTrade.user`.
    const userStr = args.user;
    if (!userStr) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildCreateMarket — CreateMarketArgs.user (Solana-only meta) is required at build time",
      });
    }
    const userPk = decodePubkeyRef(userStr);

    // ── Argument defaults ──────────────────────────────────────────────
    //
    // The umbrella SDK's CreateMarketArgs is intentionally narrow; we fill
    // in Solana-specific fields with safe defaults when omitted. See the
    // type definition in `types.ts` for the full per-field contract.
    const marketId = args.marketId ?? randomMarketId();
    if (marketId.length !== 16) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `buildCreateMarket: marketId must be 16 bytes, got ${marketId.length}`,
      });
    }
    const questionHash = args.questionHash ?? (await sha256(args.question));
    if (questionHash.length !== 32) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `buildCreateMarket: questionHash must be 32 bytes, got ${questionHash.length}`,
      });
    }
    const startTime = args.startTime ?? BigInt(Math.floor(Date.now() / 1000));
    const adjudicator = args.adjudicator
      ? decodePubkeyRef(args.adjudicator)
      : userPk;
    const initialB = args.initialB ?? 1000n * WAD;

    // ── PDA derivations ───────────────────────────────────────────────
    const [marketPda] = deriveMarketPda(marketId, this.programIds);
    const [allowlistPda] = deriveAdjudicatorAllowlistPda(this.programIds);
    const [vaultAuthority] = deriveVaultAuthorityPda(marketId, this.programIds);
    const [yesMint] = deriveYesMintPda(marketId, this.programIds);
    const [noMint] = deriveNoMintPda(marketId, this.programIds);
    const [lockAuthority] = deriveLockAuthorityPda(marketId, this.programIds);
    const vault = deriveMarketVaultAta(
      marketId,
      this.usdcMint,
      this.programIds,
    );
    const lockVault = deriveLockVaultAta(
      marketId,
      this.usdcMint,
      this.programIds,
    );
    const [ammStatePda] = deriveAmmStatePda(marketId, this.programIds);
    if (!this.programIds.soothLaunchpad) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildCreateMarket: programIds.soothLaunchpad is missing",
      });
    }
    const [configPda] = deriveProtocolConfigPda({
      soothLaunchpad: this.programIds.soothLaunchpad,
    });

    // ── Build the ix via Anchor's coder ────────────────────────────────
    //
    // `CreateMarketArgs` on-chain (from the IDL) has fields:
    //   market_id: [u8;16], question_hash: [u8;32], start_time: i64,
    //   deadline: i64, adjudicator: pubkey, initial_b: u128
    // Order matters for borsh — we pass the object Anchor's coder expects.
    const ix: TransactionInstruction = await (
      this.soothLaunchpad.methods as any
    )
      .createMarket({
        marketId: Array.from(marketId),
        questionHash: Array.from(questionHash),
        startTime: bigIntToBn(startTime),
        deadline: bigIntToBn(args.deadline),
        adjudicator,
        initialB: bigIntToBn(initialB),
      })
      .accounts({
        config: configPda,
        market: marketPda,
        adjudicatorAllowlist: allowlistPda,
        vaultAuthority,
        yesMint,
        noMint,
        lockAuthority,
        usdcMint: this.usdcMint,
        vault,
        lockVault,
        ammState: ammStatePda,
        creator: userPk,
        soothMarketProgram: this.programIds.soothMarket,
        soothAmmProgram: this.programIds.soothAmm,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    // The four CPIs each consume their own ~10–20k CU; the outer ix's
    // overhead is small. Empirically the full create_market envelope sits
    // around 80–100k CU on litesvm — well under the 200k default — but
    // bumping the limit gives headroom for IDL-init overhead on the first
    // call after a redeploy. Same pattern as `buildTrade`.
    const accounts = ixKeysToShim(ix.keys);

    return {
      kind: "createMarket",
      serializedTx: undefined,
      costEstimateWad: 0n,
      accounts,
      meta: {
        marketPda: marketPda.toBase58(),
        marketIdHex: Buffer.from(marketId).toString("hex"),
        ...buildIxMeta(ix, userPk),
        adjudicator: adjudicator.toBase58(),
        startTimeStr: startTime.toString(),
        deadlineStr: args.deadline.toString(),
        initialBStr: initialB.toString(),
      },
    };
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
          // Optional pre-ixs prepended ahead of the main ix on every submit
          // attempt. Used by `buildTrade` to ship the idempotent ATA-create
          // for `user_lp_ata` (architecture §4.2). Each entry is the same
          // {programId, keys, data} shape as the main ix and is replayed
          // verbatim under each fresh blockhash.
          preIxs?: Array<{
            programId: string;
            keys: Array<{
              pubkey: string;
              isSigner: boolean;
              isWritable: boolean;
            }>;
            data: string;
          }>;
          marketPda?: string;
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

    // Reconstruct any pre-ixs (e.g. the LP-ATA idempotent create from
    // `buildTrade`). These are replayed verbatim on every attempt — they
    // carry no per-blockhash data, so the bytes are identical across
    // retries.
    const preIxs: TransactionInstruction[] = (meta.preIxs ?? []).map(
      (p) =>
        new TransactionInstruction({
          programId: new PublicKey(p.programId),
          keys: p.keys.map((k) => ({
            pubkey: new PublicKey(k.pubkey),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Buffer.from(p.data, "base64"),
        }),
    );

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
      const microLamports =
        await this.nextSubmitComputeUnitPriceMicroLamports(
          parseOptionalPublicKey(meta.marketPda),
        );
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      // Priority fee = recent p50 for this market's locked writable account
      // plus the existing byte-level salt. The salt remains load-bearing:
      // two identical writes in the same blockhash window must still hash
      // differently even if the fee cache returns the same p50 value.
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports,
        }),
      );
      for (const pre of preIxs) tx.add(pre);
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
        const classified = classifySubmitError(
          e,
          attempt,
          undefined,
          this.programErrorLookup,
        );
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
          this.programErrorLookup,
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

  async preflight(req: SoothRequest): Promise<PreflightResult> {
    // Mirror submit's tx construction so the simulation hits the same compute
    // path (CU limit + preIxs + main ix). Diverging here would make
    // unitsConsumed misleading vs the real send.
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
          preIxs?: Array<{
            programId: string;
            keys: Array<{
              pubkey: string;
              isSigner: boolean;
              isWritable: boolean;
            }>;
            data: string;
          }>;
        };
    if (!meta?.ixData) {
      return {
        ok: false,
        error: {
          kind: "ProgramError",
          msg: "preflight: request missing meta.ixData",
        },
      };
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
    const preIxs: TransactionInstruction[] = (meta.preIxs ?? []).map(
      (p) =>
        new TransactionInstruction({
          programId: new PublicKey(p.programId),
          keys: p.keys.map((k) => ({
            pubkey: new PublicKey(k.pubkey),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Buffer.from(p.data, "base64"),
        }),
    );

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    for (const pre of preIxs) tx.add(pre);
    tx.add(ix);
    tx.feePayer = userPk;

    try {
      const bh = await this.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: "NetworkError",
          msg: (e as Error).message ?? String(e),
        },
      };
    }

    let sim;
    try {
      sim = await this.connection.simulateTransaction(tx);
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: "NetworkError",
          msg: (e as Error).message ?? String(e),
        },
      };
    }

    if (sim.value.err !== null && sim.value.err !== undefined) {
      return {
        ok: false,
        error: {
          kind: "SimulationFailed",
          err: sim.value.err,
          logs: sim.value.logs ?? [],
        },
      };
    }

    const unitsConsumed = sim.value.unitsConsumed;
    return {
      ok: true,
      gasEstimate: unitsConsumed != null ? BigInt(unitsConsumed) : undefined,
    };
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

  private async nextSubmitComputeUnitPriceMicroLamports(
    marketPda?: PublicKey,
  ): Promise<number> {
    const percentile = await this.cachedRecentPriorityFeePercentile(marketPda);
    return nextSubmitComputeUnitPrice(percentile);
  }

  private async cachedRecentPriorityFeePercentile(
    marketPda?: PublicKey,
  ): Promise<number> {
    const cacheKey = marketPda?.toBase58() ?? "global";
    const now = Date.now();
    const cached = this.priorityFeeCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return cached.percentileMicroLamports;
    }

    let percentileMicroLamports = 0;
    try {
      const lockedWritableAccounts = marketPda ? [marketPda] : [];
      const fees = await this.connection.getRecentPrioritizationFees({
        lockedWritableAccounts,
      });
      percentileMicroLamports = percentile50MicroLamports(fees);
    } catch {
      // Local bankrun shims and transient RPC failures may not expose recent
      // fee data. Falling back to the salt-only path keeps submit usable.
      percentileMicroLamports = 0;
    }

    this.priorityFeeCache.set(cacheKey, {
      expiresAtMs: now + PRIORITY_FEE_CACHE_MS,
      percentileMicroLamports,
    });
    return percentileMicroLamports;
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
      creator: raw.creator,
      adjudicator: raw.adjudicator,
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

  private bookProgramIds(): { soothBook: PublicKey } {
    return {
      soothBook: this.programIds.soothBook ?? SOOTH_BOOK_DEFAULT_PROGRAM_ID,
    };
  }

  private requireLaunchpadProgramId(method: string): PublicKey {
    if (!this.programIds.soothLaunchpad) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `${method}: programIds.soothLaunchpad is missing`,
      });
    }
    return this.programIds.soothLaunchpad;
  }

  private async fetchBookOrderPurchaser(orderPda: PublicKey): Promise<PublicKey> {
    const accounts = this.soothBook.account as unknown as {
      order: {
        fetchNullable(pda: PublicKey): Promise<{ purchaser: PublicKey } | null>;
      };
    };
    const order = await accounts.order.fetchNullable(orderPda);
    if (!order) {
      throw new SoothError({
        kind: "AccountNotFound",
        msg: `Order PDA not found at ${orderPda.toBase58()}`,
      });
    }
    return order.purchaser;
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
const PRIORITY_FEE_CACHE_MS = 5_000;
const PRIORITY_FEE_CAP_MICROLAMPORTS = 50_000;
const PRIORITY_FEE_SALT_HEADROOM_MICROLAMPORTS = 1_000;

// Monotonically increasing CU-price salt. Two back-to-back identical
// writes (same signer + same ix bytes + same recent blockhash) hash
// identically, so the cluster rejects the second send as duplicate.
// Adding a per-call price tweak makes every signed tx unique. Reserve a
// small headroom band below the 50k cap so the salt remains visible even
// when recent fee samples are at or above the ceiling. Lives at module
// scope so consecutive submits across multiple adapter instances still see
// distinct values.
let __submitCuPriceSalt = 0;
function nextSubmitComputeUnitPrice(percentileMicroLamports = 0): number {
  const percentile = sanitizeMicroLamports(percentileMicroLamports);
  const salt = nextSubmitComputeUnitPriceSalt(percentile);
  return Math.min(
    PRIORITY_FEE_CAP_MICROLAMPORTS,
    Math.max(salt, percentile, 1),
  );
}

function nextSubmitComputeUnitPriceSalt(percentileMicroLamports: number): number {
  __submitCuPriceSalt =
    (__submitCuPriceSalt % PRIORITY_FEE_SALT_HEADROOM_MICROLAMPORTS) + 1;
  const baseline = Math.min(
    Math.max(1, percentileMicroLamports),
    PRIORITY_FEE_CAP_MICROLAMPORTS - PRIORITY_FEE_SALT_HEADROOM_MICROLAMPORTS,
  );
  return baseline + __submitCuPriceSalt;
}

function percentile50MicroLamports(
  samples: Array<{ prioritizationFee: number }>,
): number {
  const fees = samples
    .map((sample) => sanitizeMicroLamports(sample.prioritizationFee))
    .filter((fee) => fee >= 0)
    .sort((a, b) => a - b);
  if (fees.length === 0) return 0;
  const mid = Math.floor(fees.length / 2);
  if (fees.length % 2 === 1) return fees[mid]!;
  return Math.floor((fees[mid - 1]! + fees[mid]!) / 2);
}

function sanitizeMicroLamports(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function parseOptionalPublicKey(value: unknown): PublicKey | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return new PublicKey(value);
  } catch {
    return undefined;
  }
}

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

function programIdOrFallback(value: string | undefined, fallback: PublicKey): PublicKey {
  return value && value.length > 0 ? new PublicKey(value) : fallback;
}

function assertU64(v: bigint, name: string): void {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new SoothError({
      kind: "ProgramError",
      msg: `${name} must fit in u64, got ${v.toString()}`,
    });
  }
}

function assertU128(v: bigint, name: string): void {
  if (v < 0n || v > 0xffffffffffffffffffffffffffffffffn) {
    throw new SoothError({
      kind: "ProgramError",
      msg: `${name} must fit in u128, got ${v.toString()}`,
    });
  }
}

function assertI64(v: bigint, name: string): void {
  if (v < -0x8000000000000000n || v > 0x7fffffffffffffffn) {
    throw new SoothError({
      kind: "ProgramError",
      msg: `${name} must fit in i64, got ${v.toString()}`,
    });
  }
}

function assertSeed16(seed: Uint8Array, name: string): void {
  if (seed.length !== 16) {
    throw new SoothError({
      kind: "ProgramError",
      msg: `${name} must be exactly 16 bytes, got ${seed.length}`,
    });
  }
}

function assertPublicKeyEquals(
  actual: PublicKey,
  expected: PublicKey,
  name: string,
): void {
  if (!actual.equals(expected)) {
    throw new SoothError({
      kind: "ProgramError",
      msg: `${name} mismatch: expected ${expected.toBase58()}, got ${actual.toBase58()}`,
    });
  }
}

function bookMarketOrderBehaviour(
  value: CreateBookMarketArgs["marketLockOrderBehaviour"],
): BookMarketOrderBehaviourWire {
  return value === "cancelUnmatched"
    ? { cancelUnmatched: {} }
    : { none: {} };
}

// Generate a 16-byte random market id. Architecture §2.2 specifies this as
// the truncated keccak256 of `question || creator || nonce`; the SDK
// surfaces a permissive default (random bytes) so callers without a
// canonical question/nonce pair can still create markets. Production
// deployments are encouraged to override `marketId` with the canonical
// derivation.
function randomMarketId(): Uint8Array {
  const bytes = new Uint8Array(16);
  // `globalThis.crypto.getRandomValues` is available in Node 20+ (engines
  // requirement of this package) and every modern browser.
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

// SHA-256 of the input string (UTF-8 encoded). 32-byte output. Used as a
// default `questionHash` when the caller doesn't provide one. EVM uses
// keccak256 for the same role; Solana's `solana-program` exposes both
// SHA-256 and keccak — we pick SHA-256 here because `crypto.subtle` ships
// it natively whereas keccak would require a userland dep.
async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
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

// ─── Ix → SoothRequest.meta serialization helpers ────────────────────────────
//
// Every build* method needs to translate an Anchor-built TransactionInstruction
// into the serializable shape `submit()`/`preflight()` rebuild from on each
// attempt. The shape is tedious — `pubkey: PublicKey` → base58 string,
// `data: Buffer` → base64 string. Centralize the three patterns here so
// every adapter method shares one source of truth.

interface SerializedAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

interface SerializedIx {
  programId: string;
  keys: SerializedAccountMeta[];
  data: string;
}

function ixKeysToShim(
  keys: TransactionInstruction["keys"],
): SerializedAccountMeta[] {
  return keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));
}

function buildIxMeta(
  ix: TransactionInstruction,
  userPk: PublicKey,
): {
  userPk: string;
  ixData: string;
  ixKeys: SerializedAccountMeta[];
  ixProgramId: string;
} {
  return {
    userPk: userPk.toBase58(),
    ixData: Buffer.from(ix.data).toString("base64"),
    ixKeys: ixKeysToShim(ix.keys),
    ixProgramId: ix.programId.toBase58(),
  };
}

function serializeIx(ix: TransactionInstruction): SerializedIx {
  return {
    programId: ix.programId.toBase58(),
    keys: ixKeysToShim(ix.keys),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

async function getTokenAmountOrZero(
  connection: Connection,
  ata: PublicKey,
): Promise<bigint> {
  try {
    return (await getAccount(connection, ata)).amount;
  } catch {
    return 0n;
  }
}

// Map a Solana RPC error (thrown by sendRawTransaction or surfaced via
// confirmation.value.err) to a SoothError. Anchor returns program errors as
// `{ InstructionError: [ixIndex, { Custom: code }] }`.
//
// Anchor numbers each program's user errors starting at 6000 in the order
// they appear in `error.rs`. The same numeric code (e.g. 6012) can mean
// completely different things across programs — `sooth_amm::LockNotElapsed`
// vs `sooth_market::AdjudicatorNotAllowlisted`. Without disambiguation by
// failing-program-ID the decoder picks the wrong message and the caller
// chases the wrong root cause.
//
// All four tables mirror `programs/<name>/src/error.rs`. Reorder an enum
// and the corresponding table needs the same change.

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
  6014: {
    kind: "TrialNotExpired",
    msg: "Trial period has not expired yet",
  },
  6015: { kind: "AlreadyGraduated", msg: "Market has already graduated" },
  6016: {
    kind: "AlreadyDismissed",
    msg: "Market has already been dismissed",
  },
  6017: {
    kind: "ProgramError",
    msg: "AmmState market backlink does not match market account",
  },
  6018: { kind: "MarketNotDismissed", msg: "Market is not dismissed" },
  6019: {
    kind: "ProgramError",
    msg: "Helper ix must be CPI'd from sooth_market::claim_refund",
  },
};

const SOOTH_MARKET_ERROR_TABLE: Record<number, { kind: string; msg: string }> =
  {
    6000: {
      kind: "MarketNotActive",
      msg: "Market is not in the Open lifecycle state",
    },
    6001: {
      kind: "ProgramError",
      msg: "Market is not in the Locked lifecycle state",
    },
    6002: { kind: "ProgramError", msg: "Market is not Settled" },
    6003: {
      kind: "ProgramError",
      msg: "Lifecycle transition not permitted from current state",
    },
    6004: {
      kind: "ProgramError",
      msg: "Caller is not the registered adjudicator for this market",
    },
    6005: {
      kind: "ProgramError",
      msg: "Invalid outcome (must be NO=0, YES=1, or INVALID=2)",
    },
    6006: { kind: "ProgramError", msg: "Amount must be non-zero" },
    6007: {
      kind: "InsufficientShares",
      msg: "Insufficient outcome-token balance",
    },
    6008: { kind: "ProgramError", msg: "Math overflow" },
    6009: { kind: "ProgramError", msg: "Vault / mint authority mismatch" },
    6010: {
      kind: "ProgramError",
      msg: "Deadline must be greater than start_time",
    },
    6011: {
      kind: "ProgramError",
      msg: "Adjudicator pubkey must not be the default (all-zero) key",
    },
    6012: {
      kind: "ProgramError",
      msg: "Adjudicator pubkey is not present on the on-chain allowlist",
    },
    6013: {
      kind: "ProgramError",
      msg: "Caller is not the registered allowlist authority",
    },
    6014: {
      kind: "ProgramError",
      msg: "Adjudicator allowlist is full (capacity exhausted)",
    },
    6015: {
      kind: "ProgramError",
      msg: "Adjudicator pubkey is already present on the allowlist",
    },
    6016: {
      kind: "ProgramError",
      msg: "Adjudicator pubkey is not present on the allowlist",
    },
    6017: {
      kind: "ProgramError",
      msg: "Helper ixs must be CPI'd from sooth_amm; direct calls are rejected.",
    },
    6018: { kind: "MarketNotDismissed", msg: "Market is not dismissed" },
  };

const SOOTH_LAUNCHPAD_ERROR_TABLE: Record<
  number,
  { kind: string; msg: string }
> = {
  6000: {
    kind: "ProgramError",
    msg: "Caller is not the registered protocol authority",
  },
  6001: {
    kind: "ProgramError",
    msg: "Fee bps must not exceed 10000 (100%)",
  },
  6002: { kind: "ProgramError", msg: "Fee split bps do not sum to 10000" },
  6003: { kind: "ProgramError", msg: "Treasury pubkey must be non-default" },
  6004: { kind: "ProgramError", msg: "Default trial period must be > 0" },
  6005: {
    kind: "ProgramError",
    msg: "Market is already graduated; LP-mint flow disabled",
  },
  6006: { kind: "ProgramError", msg: "Math overflow" },
  6007: {
    kind: "ProgramError",
    msg: "Protocol config already initialized",
  },
  6008: {
    kind: "ProgramError",
    msg: "Fee pool is empty — nothing to distribute",
  },
  6009: { kind: "NotGraduated", msg: "Market is not graduated" },
  6010: { kind: "ProgramError", msg: "LP amount must be > 0" },
  6011: { kind: "ProgramError", msg: "LP supply is empty" },
};

const SOOTH_ADJUDICATOR_ERROR_TABLE: Record<
  number,
  { kind: string; msg: string }
> = {
  6000: {
    kind: "ProgramError",
    msg: "Caller is not the registered authority for this adjudicator",
  },
  6001: {
    kind: "ProgramError",
    msg: "Adjudicator kind does not support this operation",
  },
  6002: {
    kind: "ProgramError",
    msg: "Adjudicator has already attested an outcome; re-attestation is not permitted",
  },
  6003: {
    kind: "ProgramError",
    msg: "Adjudicator has not yet attested an outcome",
  },
  6004: {
    kind: "ProgramError",
    msg: "Invalid outcome (must be NO=0, YES=1, or INVALID=2)",
  },
  6005: {
    kind: "ProgramError",
    msg: "Adjudicator account does not match the supplied market",
  },
  6006: {
    kind: "ProgramError",
    msg: "Authority pubkey must not be the default (all-zero) key",
  },
  6007: {
    kind: "NotImplemented",
    msg: "Dispute path is not implemented in v1; see architecture §4.4",
  },
  6008: {
    kind: "ProgramError",
    msg: "Caller is not the registered dispute authority for this adjudicator",
  },
  6009: {
    kind: "ProgramError",
    msg: "Adjudicator has already been disputed; dispute is one-shot per market",
  },
  6010: {
    kind: "ProgramError",
    msg: "Market is already settled; dispute can no longer override the outcome",
  },
};

// Lookup of failing-program-ID base58 → which error table to consult. Built
// per-adapter at construction time so the decoder doesn't need to know the
// concrete deployment IDs (those rotate across localnet/devnet/mainnet).
type ProgramErrorLookup = Map<
  string,
  Record<number, { kind: string; msg: string }>
>;

// Exported for tests so they can assert per-program code disambiguation
// without round-tripping through the full submit() retry loop.
export const __testing = {
  decodeSubmitError: (...args: Parameters<typeof decodeSubmitError>) =>
    decodeSubmitError(...args),
  extractFailingProgramId,
  SOOTH_AMM_ERROR_TABLE,
  SOOTH_MARKET_ERROR_TABLE,
  SOOTH_LAUNCHPAD_ERROR_TABLE,
  SOOTH_ADJUDICATOR_ERROR_TABLE,
};

function decodeSubmitError(
  raw: unknown,
  signature: string | undefined,
  programLookup?: ProgramErrorLookup,
): SoothError {
  const code = extractCustomCode(raw);
  if (code !== undefined) {
    const failingId = extractFailingProgramId(raw);
    const table = failingId ? programLookup?.get(failingId) : undefined;
    const entry = table?.[code];
    if (entry) {
      return new SoothError({
        kind: entry.kind as SoothError["kind"],
        code,
        msg: entry.msg,
        signature,
      });
    }
    // No program-ID match (or unknown code) — surface the bare code with
    // the failing program ID if we recovered one. Don't guess at
    // semantics; that's how the LockNotElapsed/AdjudicatorNotAllowlisted
    // confusion got into the wild.
    return new SoothError({
      kind: "ProgramError",
      code,
      msg: failingId
        ? `Unknown program error code ${code} from ${failingId}`
        : `Unknown program error code ${code}`,
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
  programLookup?: ProgramErrorLookup,
): { retryable: boolean; error: SoothError } {
  const code = extractCustomCode(raw);
  if (code !== undefined) {
    // Program errors are deterministic — retrying with a new blockhash will
    // produce the exact same failure. Always terminal.
    const error = decodeSubmitError(raw, signature, programLookup);
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

// Pull the failing program's base58 ID out of the error context. Solana
// runtime emits `Program <ID> failed: custom program error: 0x...` in the
// transaction logs immediately before the failing instruction unwinds. The
// `SendTransactionError` thrown by web3.js exposes those logs on `.logs`;
// stringified `confirmation.value.err` payloads embed the same line in
// `.message`. We try the structured shape first, then fall back to a regex
// over the message.
//
// Why we need this: Anchor numbers user errors per-program starting at
// 6000. The same numeric code (e.g. 6012) means
// `sooth_amm::LockNotElapsed` in one program and
// `sooth_market::AdjudicatorNotAllowlisted` in another. Without the
// failing-program-ID the decoder either guesses wrong or refuses to decode.
function extractFailingProgramId(raw: unknown): string | undefined {
  const PROGRAM_FAILED_RE = /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed:/;
  const logs = (raw as { logs?: unknown })?.logs;
  if (Array.isArray(logs)) {
    // Walk newest → oldest; the failing program emits its `failed:` line
    // last before the runtime unwinds.
    for (let i = logs.length - 1; i >= 0; i--) {
      const line = logs[i];
      if (typeof line !== "string") continue;
      const m = PROGRAM_FAILED_RE.exec(line);
      if (m && m[1]) return m[1];
    }
  }
  const text =
    raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  if (text) {
    const m = PROGRAM_FAILED_RE.exec(text);
    if (m && m[1]) return m[1];
  }
  return undefined;
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
