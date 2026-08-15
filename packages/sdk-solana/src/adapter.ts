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
  Program,
  utils as anchorUtils,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import BN from "bn.js";
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
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

import { soothCoreIdl } from "./anchor/index.js";
import {
  costDelta,
  LN2_WAD,
  wadToUsdcCeil,
  yesPriceWad,
  WAD,
} from "./math/lmsr.js";
import {
  deriveAmmStatePda,
  deriveAdjudicatorEntryPda,
  deriveFeePoolAuthorityPda,
  deriveLockAuthorityPda,
  deriveLockEntryPda,
  deriveLockVaultAta,
  deriveLpMintPda,
  deriveLpMintAuthorityPda,
  deriveLpYieldAuthority,
  deriveMarketPda,
  deriveMarketVaultAta,
  deriveLpPositionPda,
  derivePositionPda,
  deriveProtocolConfigPda,
  deriveUserLpAta,
  deriveUserUsdcAta,
  deriveVaultAuthorityPda,
  feePoolAmmPda,
  lpYieldAmmPda,
  lpYieldBookPda,
  feePoolBookPda,
  SOOTH_CORE_PROGRAM_ID,
  type ProgramIds,
} from "./pdas.js";
import {
  bookPda,
  decodeBook,
  eventAuthorityPda,
  buildBookCancel as buildBookCancelIx,
  buildBookPlace as buildBookPlaceIx,
  buildBookWithdraw as buildBookWithdrawIx,
  type BookRefs,
  type BookSnapshot,
  type PlaceArgs,
} from "./book/index.js";
import {
  decodeBookEventsFromInner,
  type BookEvent,
} from "./book/events.js";
import { decodePubkeyRef, encodeSignatureRef } from "./refs.js";
import { SoothError, notImplemented } from "./errors.js";
import type {
  AddressRef,
  ChainAdapter,
  ClaimArgs,
  ClaimRequest,
  CreateMarketArgs,
  CreateMarketRequest,
  MarketEvent,
  MarketRef,
  Portfolio,
  Position,
  PositionEvent,
  PreflightResult,
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
  bookMint?: PublicKey;
  ammMint?: PublicKey;
  // Pre-built `Connection` to reuse (e.g. when running under the test SVM where
  // the connection is replaced by a custom client).
  connection?: Connection;
}

// Resolved-once cache key — `Market` PDA layout is invariant across reads.
interface ResolvedMarket {
  marketPda: PublicKey;
  marketId: Uint8Array; // 16 bytes
  creator: PublicKey;
  adjudicator: PublicKey;
  questionHash: Uint8Array; // 32 bytes (raw — we don't have the original question on-chain)
  /** Book-venue collateral vault (`BOOK_TOKEN_MINT`). */
  vaultBook: PublicKey;
  /** AMM-venue collateral vault (`AMM_TOKEN_MINT`). */
  vaultAmm: PublicKey;
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

const INIT_MARKET_FEE_POOL_DISCRIMINATOR = Buffer.from([
  51, 19, 251, 120, 171, 91, 138, 115,
]);

/** Mirrors `MAX_QUESTION_LEN` in the program's `constants.rs`. */
const MAX_QUESTION_LEN = 300;

export class SolanaChainAdapter implements ChainAdapter {
  readonly node: SoothNode;
  readonly chainKind = "solana" as const;

  // Program IDs and connection are resolved once at construction.
  readonly programIds: ProgramIds;
  /// The book venue's token — USDC. Named distinctly from `ammMint` because
  /// handing an instruction the other venue's mint is the one mistake here
  /// that fails silently.
  readonly bookMint: PublicKey;
  /// The AMM venue's token.
  readonly ammMint: PublicKey;
  readonly connection: Connection;

  // Anchor `Program` wrapper for the merged sooth_core program.
  private readonly program: AnyProgram;

  // Failing-program-ID → error code table. Populated at construction from the
  // resolved program IDs. Decoders consult it only when the failing program is
  // sooth_core, so codes from unrelated programs are never misdecoded.
  private readonly programErrorLookup: ProgramErrorLookup;
  private readonly priorityFeeCache = new Map<string, PriorityFeeCacheEntry>();

  constructor(opts: SolanaAdapterOptions) {
    this.node = opts.node;

    // Resolve program IDs. Explicit override wins; otherwise read from the
    // node descriptor; otherwise fall back to the IDL `address` field
    // (placeholder IDs from the on-chain `declare_id!` macros).
    if (opts.programIds) {
      this.programIds = {
        soothCore: opts.programIds.soothCore ?? SOOTH_CORE_PROGRAM_ID,
      };
    } else {
      const coreStr =
        (opts.node.programs as { soothCore?: string } | undefined)?.soothCore ??
        soothCoreIdl.address;
      this.programIds = {
        soothCore: new PublicKey(coreStr),
      };
    }

    // Both venue mints. Defaults mirror the program's compile-time constants
    // (`BOOK_TOKEN_MINT` / `AMM_TOKEN_MINT` in `constants.rs`); a mismatch is
    // a hard transaction failure, not a display bug, so they are pinned in one
    // place on each side and must move together.
    this.bookMint =
      opts.bookMint ??
      (opts.node.programs?.usdcMint
        ? new PublicKey(opts.node.programs.usdcMint)
        : new PublicKey("ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX"));
    this.ammMint =
      opts.ammMint ??
      (opts.node.programs?.ammMint
        ? new PublicKey(opts.node.programs.ammMint)
        : new PublicKey("CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu"));

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

    // Inject the resolved program ID into the IDL clone so `program.programId`
    // matches the active deployment regardless of the placeholder.
    const idl = {
      ...soothCoreIdl,
      address: this.programIds.soothCore.toBase58(),
    } as Idl;
    this.program = new Program(idl, provider);

    // Build the program-ID → error-table lookup.
    this.programErrorLookup = new Map([
      [this.programIds.soothCore.toBase58(), SOOTH_CORE_ERROR_TABLE],
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
    const ammRaw = await (this.program.account as any).ammState.fetchNullable(
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
    const ammRaw = await (this.program.account as any).ammState.fetchNullable(
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
    // Read `fee_bps` from `ProtocolConfig`
    // and mirror the on-chain floor formula:
    //   fee_wad = cost_wad * fee_bps / 10_000
    // The on-chain handler uses `cost_wad as u128 * fee_bps / 10_000`;
    // we operate on bigint here for parity. EVM analogue:
    // `FeeRouter._quoteFee:421`. Pre/post-graduation collapse to one bps
    // (architecture §8) so no graduation branch on this side either.
    const feeBps = await this.readProtocolFeeBps();
    // Fee is charged on the MAGNITUDE, both directions. `sell_positions`
    // takes `proceeds_wad = cost_wad.unsigned_abs()` and charges the same bps
    // on it, so a sell is fee-bearing exactly like a buy. A quote that
    // reported zero fee on sells would overstate seller proceeds by the whole
    // fee and surface later as SlippageExceeded on a market that had not
    // moved.
    const magnitude = cost < 0n ? -cost : cost;
    const fee = (magnitude * BigInt(feeBps)) / 10_000n;
    // Signed, and correct in both directions because `fee` is positive:
    //   buy  cost=+5, fee=+0.25 -> +5.25, what the taker pays
    //   sell cost=-5, fee=+0.25 -> -4.75, what the seller receives
    // matching the program's `cost + fee` and `proceeds - fee` respectively.
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
    const raw = await (this.program.account as any).position.fetchNullable(
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
    const ammRaw = await (this.program.account as any).ammState.fetchNullable(
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
    const ammRaw = await (this.program.account as any).ammState.fetchNullable(
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

    const [lpMint] = deriveLpMintPda(resolved.marketId, this.programIds);
    const userLpAta = deriveUserLpAta(userPk, lpMint);
    const [lpYieldAuthority] = deriveLpYieldAuthority(this.programIds);
    const lpYieldVault = getAssociatedTokenAddressSync(
      this.ammMint,
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
    const [adjudicatorPda] = deriveAdjudicatorEntryPda(marketPda, this.programIds);
    const raw = await (
      this.program.account as any
    ).adjudicatorEntry.fetchNullable(adjudicatorPda);
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
      this.program.account as any
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
   * Both venues' taker fee rates, in bps, as the program has them.
   *
   * Public because the UI needs to DISPLAY a rate and the only honest source
   * is the config the program charges from.
   *
   * Zeroes on an uninitialised config, matching `readProtocolFeeBps`.
   */
  async readVenueFeeBps(): Promise<{ amm: number; book: number }> {
    const [cfgPda] = deriveProtocolConfigPda(this.programIds);
    const raw = await (
      this.program.account as any
    ).protocolConfig.fetchNullable(cfgPda);
    if (!raw) return { amm: 0, book: 0 };
    return {
      amm: Number(raw.ammFeeBps ?? raw.amm_fee_bps ?? 0),
      book: Number(raw.bookFeeBps ?? raw.book_fee_bps ?? 0),
    };
  }

  private async readProtocolFeeBps(): Promise<number> {
    // The AMM's rate specifically. `readQuote` prices an AMM trade, and the
    // two venues charge different rates — reading the wrong one makes a quote
    // disagree with what the program charges, which shows up as a slippage
    // failure rather than as a wrong number.
    //
    // Returns 0 if the config PDA hasn't been initialized — the on-chain
    // `trade_positions` will then reject the build because the same PDA is in
    // the account list with `seeds=[b"protocol_config"]`. The graceful 0 here
    // means `readQuote` previews zero fee on a fresh cluster instead of
    // throwing during the read path.
    const [cfgPda] = deriveProtocolConfigPda(this.programIds);
    const raw = await (
      this.program.account as any
    ).protocolConfig.fetchNullable(cfgPda);
    if (!raw) {
      return 0;
    }
    // `u16` on-chain; Anchor's coder returns it as a JS number directly (not
    // BN, not bigint) — keep that type through.
    return Number(raw.ammFeeBps ?? raw.amm_fee_bps ?? 0);
  }

  // ─── Writes ──────────────────────────────────────────────────────────────

  async buildTrade(market: MarketRef, args: TradeArgs): Promise<TradeRequest> {
    if (args.side === "sell") {
      // `sell_positions` is a separate on-chain ix from `trade_positions`;
      // the SDK split mirrors that. Sell callers must use
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
    const userUsdcAta = deriveUserUsdcAta(userPk, this.ammMint);
    const marketVault = deriveMarketVaultAta(
      resolved.marketId,
      this.ammMint,
      this.programIds,
    );
    // AMM buys credit the per-market fee pool owned by sooth_core. The
    // on-chain trade ix requires the token account to exist; the SDK adds
    // the init ix only for fresh markets.
    const [protocolConfig] = deriveProtocolConfigPda(this.programIds);
    const {
      marketFeePool,
      ix: initMarketFeePoolIx,
    } = buildInitMarketFeePoolIx({
      market: marketPda,
      marketId: resolved.marketId,
      user: userPk,
      bookMint: this.bookMint,
      ammMint: this.ammMint,
      coreProgramId: this.programIds.soothCore,
    });
    const marketFeePoolInfo =
      await this.connection.getAccountInfo(marketFeePool);

    // LP-mint plumbing for the pre-graduation buy path (architecture §4.2).
    // `trade_positions` requires the per-market `lp_mint` ATA to exist even
    // when the market is graduated (no-op in that case).
    const [lpMint] = deriveLpMintPda(resolved.marketId, this.programIds);
    const [lpMintAuthority] = deriveLpMintAuthorityPda(resolved.marketId, this.programIds);
    const userLpAta = deriveUserLpAta(userPk, lpMint);

    // Build the `trade_positions` instruction. Anchor's coder takes `BN`
    // for `i128` / `u128` args; we widen at the boundary.
    const ix: TransactionInstruction = await (this.program.methods as any)
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
        userAmmAta: userUsdcAta,
        marketVault,
        ammMint: this.ammMint,
        protocolConfig,
        feePoolAmm: marketFeePool,
        lpMint,
        lpMintAuthority,
        userLpAta,
        user: userPk,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
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
    // Same treatment for the user's USDC ATA.
    //
    // `trade_positions` constrains `user_usdc_ata` with
    // `token::authority = user`, so the account must EXIST — a wallet that has
    // never held USDC fails account validation with AccountNotInitialized
    // (3012) before any balance is checked. That surfaces in a wallet as an
    // opaque "simulation failed", which is the worst possible message for the
    // most common first-time case.
    //
    // Creating it idempotently costs ~0.002 SOL of rent on the first trade and
    // turns that into an ordinary insufficient-funds error, which a user can
    // act on. It does not give anyone USDC — it just stops a missing account
    // from masquerading as a broken transaction.
    const usdcAtaCreateIx = createAssociatedTokenAccountIdempotentInstruction(
      userPk, // payer
      deriveUserUsdcAta(userPk, this.ammMint),
      userPk, // owner
      this.ammMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const preIxs = marketFeePoolInfo
      ? [usdcAtaCreateIx, lpAtaCreateIx]
      : [initMarketFeePoolIx, usdcAtaCreateIx, lpAtaCreateIx];

    const tx = new Transaction();
    // Generous CU bump — `trade_positions` benched ~75-80k per the spike but
    // `init_if_needed` on the first Position adds rent payer overhead.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    // sooth_core ships a 256 KB custom #[global_allocator] (see its lib.rs).
    // The runtime only maps that heap when the transaction asks, and the
    // allocator addresses from the TOP of the region — so without this every
    // sooth_core instruction faults with "Access violation in heap section".
    // Unconditional: the merged program means every instruction shares it.
    tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }));
    for (const preIx of preIxs) tx.add(preIx);
    tx.add(ix as TransactionInstruction);
    tx.feePayer = userPk;
    // The latest blockhash is fetched at submit time (so the request remains
    // serializable across processes / RPCs). Build-time we leave it unset.

    // Cost estimate via the same off-chain LMSR port the program runs.
    const cost = await this.readQuote(market, args.outcome, args.deltaShares);

    // Derive `accounts` from the instruction's `keys`
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
        // Pre-ixs replayed by `submit()` ahead of the trade ix: optional
        // per-market fee-pool init plus the idempotent user LP ATA create.
        preIxs: preIxs.map(serializeIx),
        deltaSharesStr: args.deltaShares.toString(),
        maxCostWadStr: args.maxCostWad.toString(),
        outcome: args.outcome,
      },
    };
  }

  // ─── Sell path (`sell_positions` ix) ───────────────────────────────────
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
      this.ammMint,
      this.programIds,
    );
    const lockVault = deriveLockVaultAta(
      resolved.marketId,
      this.ammMint,
      this.programIds,
    );
    const [protocolConfig] = deriveProtocolConfigPda(this.programIds);
    const {
      marketFeePool,
      ix: initMarketFeePoolIx,
    } = buildInitMarketFeePoolIx({
      market: marketPda,
      marketId: resolved.marketId,
      user: userPk,
      bookMint: this.bookMint,
      ammMint: this.ammMint,
      coreProgramId: this.programIds.soothCore,
    });
    const marketFeePoolInfo =
      await this.connection.getAccountInfo(marketFeePool);

    // Read the current Position to grab `lock_nonce`. The LockEntry PDA seed
    // includes the nonce; without the up-to-date value the `init` would land
    // at the wrong address and Anchor would reject. Position is required to
    // exist (you can only sell shares you've previously bought).
    const positionRaw = await (
      this.program.account as any
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

    const ix: TransactionInstruction = await (this.program.methods as any)
      .sellPositions(
        args.outcome,
        bigIntToBn(wireDelta),
        bigIntToBn(minProceedsWad),
        bigIntToBn(lockNonce),
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
        ammMint: this.ammMint,
        protocolConfig,
        feePoolAmm: marketFeePool,
        user: userPk,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
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
        preIxs: marketFeePoolInfo ? [] : [serializeIx(initMarketFeePoolIx)],
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
  //      cooldown (`sooth_amm::claim_unlocked`). This is the EVM
  //      `claimUnlocked(maxClaims)` analogue. One LockEntry per call mirrors
  //      the on-chain handler (see `claim_unlocked.rs`).
  //
  //   2. Post-settlement payouts, which go through `buildRedeemBookSeat` /
  //      `buildRedeemAmmPosition`, one per ledger
  //      (`docs/design/dual-token-venues.md` §4).
  async buildClaim(
    market: MarketRef,
    args: ClaimArgs & {
      user?: AddressRef;
      lockEntry?: AddressRef;
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
      this.ammMint,
      this.programIds,
    );
    const userUsdcAta = deriveUserUsdcAta(userPk, this.ammMint);

    const ix: TransactionInstruction = await (this.program.methods as any)
      .claimUnlocked()
      .accounts({
        market: marketPda,
        position: positionPda,
        lockEntry: lockEntryPda,
        lockAuthority,
        lockVault,
        userAmmAta: userUsdcAta,
        ammMint: this.ammMint,
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
      this.ammMint,
      this.programIds,
    );
    const userUsdcAta = deriveUserUsdcAta(userPk, this.ammMint);

    const ix: TransactionInstruction = await (this.program.methods as any)
      .claimRefund()
      .accounts({
        user: userPk,
        market: marketPda,
        ammState: ammPda,
        vaultAuthority,
        marketVault,
        userAmmAta: userUsdcAta,
        position: positionPda,
        ammMint: this.ammMint,
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

    const ix: TransactionInstruction = await (this.program.methods as any)
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
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [ammPda] = deriveAmmStatePda(resolved.marketId, this.programIds);
    const [lpMint] = deriveLpMintPda(resolved.marketId, this.programIds);
    const userLpAta = deriveUserLpAta(userPk, lpMint);
    const [lpYieldAuthority] = deriveLpYieldAuthority(this.programIds);
    const [lpYieldAmm] = lpYieldAmmPda(resolved.marketId, this.programIds);
    const [lpYieldBook] = lpYieldBookPda(resolved.marketId, this.programIds);
    const userUsdcAta = deriveUserUsdcAta(userPk, this.ammMint);
    const userBookAta = deriveUserUsdcAta(userPk, this.bookMint);

    const ix: TransactionInstruction = await (this.program.methods as any)
      .redeemLp(bigIntToBn(args.lpAmount))
      .accounts({
        // Everything is bound to one market: an unconstrained lp_mint
        // accepted alongside any graduated amm_state would let anyone drain
        // the LP yield vault with a self-created mint (bug B6).
        market: marketPda,
        ammState: ammPda,
        lpMint,
        userLpAta,
        // One burn claims BOTH venues' yield — paying one and burning would
        // forfeit the other, which is why this is a single instruction.
        lpYieldAmm,
        lpYieldBook,
        lpYieldAuthority,
        userAmmAta: userUsdcAta,
        userBookAta,
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
        // Both destinations must exist or the call fails with
        // AccountNotInitialized (3012). The user's AMM ATA is the likelier
        // gap: an LP who only ever supplied liquidity has never held the AMM's
        // token, so the account they are owed INTO does not exist yet. The
        // yield vault is covered too, for the LP who redeems before any fees
        // have been distributed.
        preIxs: [
          serializeIx(
            createAssociatedTokenAccountIdempotentInstruction(
              userPk,
              userUsdcAta,
              userPk,
              this.ammMint,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          ),
          serializeIx(
            createAssociatedTokenAccountIdempotentInstruction(
              userPk,
              userBookAta,
              userPk,
              this.bookMint,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          ),
        ],
        operation: "redeemLp",
        lpAmountStr: args.lpAmount.toString(),
        lpYieldVault: lpYieldAmm.toBase58(),
      },
    };
  }
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
    const [adjudicatorEntryPda] = deriveAdjudicatorEntryPda(marketPda, this.programIds);

    const ix: TransactionInstruction = await (this.program.methods as any)
      .requestLock()
      .accounts({
        adjudicatorEntry: adjudicatorEntryPda,
        market: marketPda,
        authority: userPk,
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
    const [adjudicatorEntryPda] = deriveAdjudicatorEntryPda(marketPda, this.programIds);

    const ix: TransactionInstruction = await (this.program.methods as any)
      .attestOutcome(args.winningOutcome)
      .accounts({
        adjudicatorEntry: adjudicatorEntryPda,
        market: marketPda,
        authority: userPk,
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

  /// Finalize an attested market. Permissionless — `args.user` is only the
  /// fee payer, not an authority — and takes no outcome: the winning outcome
  /// comes from the `AdjudicatorEntry`, so a caller cannot settle something
  /// other than what was attested (or vetoed).
  ///
  /// Fails with `VetoWindowOpen` (0x17ca) until the veto window closes.
  async buildSettle(
    market: MarketRef,
    args: { user: AddressRef },
  ): Promise<TradeRequest> {
    if (!args.user) {
      throw new SoothError({
        kind: "NotImplemented",
        method:
          "buildSettle — args.user (Solana-only meta) is required at build time",
      });
    }
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const [adjudicatorEntryPda] = deriveAdjudicatorEntryPda(
      marketPda,
      this.programIds,
    );
    const [protocolConfigPda] = deriveProtocolConfigPda(this.programIds);

    const ix: TransactionInstruction = await (this.program.methods as any)
      .settle()
      .accounts({
        market: marketPda,
        adjudicatorEntry: adjudicatorEntryPda,
        protocolConfig: protocolConfigPda,
        cranker: userPk,
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
        operation: "settle",
      },
    };
  }

  // ─── The book (docs/design/orderbook-redesign.md) ──────────────────────
  //
  // Thin wrappers over the raw instruction builders in `./book`, in the same
  // TradeRequest shape as every other path so the demo's chain-shim can submit
  // them without a special case.
  //
  // There is no planner or simulator here, and that is the point: the program
  // walks its own book, so a taker sends one instruction with a `matchLimit`
  // and nothing has to be predicted off-chain — no client-side match plan
  // exists to go stale (the failure class of audit finding H1).

  private bookRefs(marketPda: PublicKey, marketId: Uint8Array): BookRefs {
    return {
      marketId,
      marketPda,
      usdcMint: this.bookMint,
      programs: this.programIds,
    };
  }

  async buildBookPlace(
    market: MarketRef,
    args: PlaceArgs & { user: AddressRef },
  ): Promise<TradeRequest> {
    if (!args.user) {
      throw new SoothError({
        kind: "NotImplemented",
        method: "buildBookPlace — args.user is required at build time",
      });
    }
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const ix = buildBookPlaceIx(
      this.bookRefs(marketPda, resolved.marketId),
      userPk,
      args,
    );
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        preIxs: [this.usdcAtaCreateIx(userPk)],
        operation: "bookPlace",
      },
    };
  }

  /**
   * Idempotent create for a user's USDC ATA, as a pre-instruction.
   *
   * Every instruction that moves USDC constrains `user_usdc_ata` with
   * `token::authority = user`, which requires the account to already exist. A
   * wallet that has never held USDC has no ATA, so without this its FIRST
   * order fails at simulation with nothing on screen naming the cause — the
   * wallet looks funded, because it has plenty of SOL.
   *
   * Idempotent, so it is a no-op for everyone else, and data-only, so `submit`
   * can replay the identical bytes under a fresh blockhash.
   */
  private usdcAtaCreateIx(userPk: PublicKey) {
    return serializeIx(
      createAssociatedTokenAccountIdempotentInstruction(
        userPk, // payer
        getAssociatedTokenAddressSync(this.bookMint, userPk),
        userPk, // owner
        this.bookMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  /**
   * Pay out a book position after settlement (`redeem_book_seat`).
   *
   * The book's own claim path. `book_withdraw` moves seat CREDIT — USDC
   * already released by a cancel or a closing fill — while this converts the
   * seat's signed net into money against the resolved outcome. Both exist
   * because they answer different questions, and only this one requires the
   * market to be settled.
   */
  async buildRedeemBookSeat(
    market: MarketRef,
    args: { user: AddressRef },
  ): Promise<TradeRequest> {
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [book] = bookPda(resolved.marketId, this.programIds);
    const [vaultAuthority] = deriveVaultAuthorityPda(
      resolved.marketId,
      this.programIds,
    );

    const ix: TransactionInstruction = await (this.program.methods as any)
      .redeemBookSeat()
      .accounts({
        book,
        market: marketPda,
        vaultAuthority,
        vaultBook: deriveMarketVaultAta(
          resolved.marketId,
          this.bookMint,
          this.programIds,
        ),
        userUsdcAta: getAssociatedTokenAddressSync(this.bookMint, userPk),
        user: userPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        preIxs: [this.usdcAtaCreateIx(userPk)],
        operation: "redeemBookSeat",
      },
    };
  }

  /**
   * Pay out an AMM `Position` after settlement (`redeem_amm_position`).
   *
   * The book seat and the AMM position are separate ledgers, and a trader who
   * used both has to claim from both — `redeemBookSeat` pays the seat and
   * knows nothing about `Position.yes_shares`.
   *
   * Callable more than once: the handler zeroes both legs before transferring,
   * so a second call pays nothing rather than double-paying. It deliberately
   * does not close the `Position` account — `claim_unlocked` still needs it.
   */
  async buildRedeemAmmPosition(
    market: MarketRef,
    args: { user: AddressRef },
  ): Promise<TradeRequest> {
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [vaultAuthority] = deriveVaultAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const [position] = derivePositionPda(
      resolved.marketId,
      userPk,
      this.programIds,
    );

    const ix: TransactionInstruction = await (this.program.methods as any)
      .redeemAmmPosition()
      .accounts({
        market: marketPda,
        // Redeeming retires the shares from AmmState's outstanding count
        // — the bookkeeping `sweep_residual` gates on.
        ammState: deriveAmmStatePda(resolved.marketId, this.programIds)[0],
        vaultAuthority,
        position,
        vault: deriveMarketVaultAta(
          resolved.marketId,
          this.ammMint,
          this.programIds,
        ),
        userAmmAta: getAssociatedTokenAddressSync(this.ammMint, userPk),
        user: userPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        preIxs: [this.usdcAtaCreateIx(userPk)],
        operation: "redeemAmmPosition",
      },
    };
  }

  /**
   * Drain a market's fee pool and split it (`distribute_fees_amm` /
   * `distribute_fees_book`).
   *
   * Permissionless — `cranker` is any signer, and every destination is pinned
   * on-chain, so who calls it cannot change where the money goes. That pinning
   * is load-bearing: a destination constrained only by mint would let any
   * caller route a market's fees to themselves.
   *
   * The two venues are separate instructions because their splits differ: the
   * book has no `b_base` share (that grows AMM liquidity, denominated in the
   * AMM's token), so routing book fees into it would mix currencies.
   */
  async buildDistributeFees(
    market: MarketRef,
    args: { venue: "amm" | "book"; cranker: AddressRef },
  ): Promise<TradeRequest> {
    const crankerPk = decodePubkeyRef(args.cranker);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const isAmm = args.venue === "amm";
    const venueMint = isAmm ? this.ammMint : this.bookMint;

    const [configPda] = deriveProtocolConfigPda(this.programIds);
    const [feePoolAuthority] = deriveFeePoolAuthorityPda(this.programIds);
    const [lpYieldAuthority] = deriveLpYieldAuthority(this.programIds);
    const [feePool] = isAmm
      ? feePoolAmmPda(resolved.marketId, this.programIds)
      : feePoolBookPda(resolved.marketId, this.programIds);

    const config = await (this.program.account as any).protocolConfig.fetch(
      configPda,
    );

    // Every destination is an ATA of the venue's mint, derived from the OWNER
    // the program pins. The treasury included: `config.treasury` is an owner,
    // not a token account — passing it directly fails with AccountNotInitialized
    // (3012), because a wallet is not an SPL token account. It cannot be one
    // account either way, since the two venues hold different mints.
    const lpYieldVault = (isAmm
      ? lpYieldAmmPda(resolved.marketId, this.programIds)
      : lpYieldBookPda(resolved.marketId, this.programIds))[0];
    const adjudicatorFeeVault = getAssociatedTokenAddressSync(
      venueMint,
      resolved.adjudicator,
      true,
    );
    const protocolTreasuryVault = getAssociatedTokenAddressSync(
      venueMint,
      config.treasury as PublicKey,
      true,
    );

    const common = {
      config: configPda,
      market: marketPda,
      feePoolAuthority,
      venueMint,
      feePool,
      lpYieldAuthority,
      // Read for supply: a zero-supply LP mint reroutes the LP slice to the
      // protocol, since no holder exists to ever claim it.
      lpMint: deriveLpMintPda(resolved.marketId, this.programIds)[0],
      lpYieldVault,
      adjudicatorFeeVault,
      protocolTreasuryVault,
      cranker: crankerPk,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    // Create any destination that does not exist yet, paid for by the cranker.
    //
    // Distribution is permissionless so that fees are never hostage to one
    // keeper — but that only holds if a cranker can complete the call alone.
    // Requiring the adjudicator or the treasury to have pre-created their ATA
    // would hand exactly those parties a veto over everyone else's fees, on a
    // venue they may never have traded. Idempotent, so it costs nothing once
    // the accounts exist.
    const preIxs = [
      [adjudicatorFeeVault, resolved.adjudicator],
      [protocolTreasuryVault, config.treasury as PublicKey],
    ].map(([ata, owner]) =>
      serializeIx(
        createAssociatedTokenAccountIdempotentInstruction(
          crankerPk, // payer
          ata,
          owner,
          venueMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      ),
    );

    const ix: TransactionInstruction = isAmm
      ? await (this.program.methods as any)
          .distributeFeesAmm()
          .accounts({
            ...common,
            // The b_base share returns to the venue's own collateral vault.
            bBaseYieldVault: deriveMarketVaultAta(
              resolved.marketId,
              this.ammMint,
              this.programIds,
            ),
          })
          .instruction()
      : await (this.program.methods as any)
          .distributeFeesBook()
          .accounts(common)
          .instruction();

    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, crankerPk),
        preIxs,
        operation: `distributeFees:${args.venue}`,
      },
    };
  }

  /**
   * Sweep a settled market's unowed AMM surplus to the protocol treasury.
   *
   * Only legal once every winning share has been redeemed — the program
   * checks `q_winner == seed_q_winner`, so calling early fails with
   * OutstandingClaims rather than taking money a slow claimant is owed.
   * Permissionless; every destination is pinned by the program.
   */
  async buildSweepResidual(
    market: MarketRef,
    args: { cranker: AddressRef },
  ): Promise<TradeRequest> {
    const crankerPk = decodePubkeyRef(args.cranker);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [configPda] = deriveProtocolConfigPda(this.programIds);
    const config = await (this.program.account as any).protocolConfig.fetch(
      configPda,
    );
    const treasuryVault = getAssociatedTokenAddressSync(
      this.ammMint,
      config.treasury as PublicKey,
      true,
    );
    const ix: TransactionInstruction = await (this.program.methods as any)
      .sweepResidual()
      .accounts({
        config: configPda,
        market: marketPda,
        ammState: deriveAmmStatePda(resolved.marketId, this.programIds)[0],
        // The creator's subsidy ledger — the program reserves their
        // unreclaimed cap so a sweep cannot front-run reclaim_subsidy.
        lpPosition: deriveLpPositionPda(
          resolved.marketId,
          resolved.creator,
          this.programIds,
        )[0],
        vaultAuthority: deriveVaultAuthorityPda(
          resolved.marketId,
          this.programIds,
        )[0],
        venueMint: this.ammMint,
        vaultAmm: deriveMarketVaultAta(
          resolved.marketId,
          this.ammMint,
          this.programIds,
        ),
        protocolTreasuryVault: treasuryVault,
        cranker: crankerPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, crankerPk),
        // The treasury may never have held the AMM token; create its ATA so a
        // permissionless crank cannot be blocked by a missing account.
        preIxs: [
          serializeIx(
            createAssociatedTokenAccountIdempotentInstruction(
              crankerPk,
              treasuryVault,
              config.treasury as PublicKey,
              this.ammMint,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          ),
        ],
        operation: "sweepResidual",
      },
    };
  }

  /**
   * Close a finished market and reclaim its rent to the creator.
   *
   * Fails unless every vault and fee pool is empty and the book (if any) is
   * inert — the program's preconditions, not this client's. The Market
   * account itself survives as an 8-byte tombstone so the market_id can never
   * be re-created; see close_market.rs for why full deletion is an exploit.
   */
  async buildCloseMarket(
    market: MarketRef,
    args: { creator: AddressRef },
  ): Promise<TradeRequest> {
    const creatorPk = decodePubkeyRef(args.creator);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const id = resolved.marketId;
    const [bookPdaKey] = bookPda(id, this.programIds);
    // The book account only exists for graduated markets. Anchor's Option
    // accounts are encoded by passing the program id in the slot when absent.
    const bookInfo = await this.connection.getAccountInfo(bookPdaKey);

    const ix: TransactionInstruction = await (this.program.methods as any)
      .closeMarket(Array.from(id))
      .accounts({
        market: marketPda,
        ammState: deriveAmmStatePda(id, this.programIds)[0],
        book: bookInfo ? bookPdaKey : null,
        vaultBook: deriveMarketVaultAta(id, this.bookMint, this.programIds),
        vaultAmm: deriveMarketVaultAta(id, this.ammMint, this.programIds),
        lockVault: deriveLockVaultAta(id, this.ammMint, this.programIds),
        feePoolAmm: feePoolAmmPda(id, this.programIds)[0],
        feePoolBook: feePoolBookPda(id, this.programIds)[0],
        lpYieldAmm: lpYieldAmmPda(id, this.programIds)[0],
        lpYieldBook: lpYieldBookPda(id, this.programIds)[0],
        vaultAuthority: deriveVaultAuthorityPda(id, this.programIds)[0],
        lockAuthority: deriveLockAuthorityPda(id, this.programIds)[0],
        feePoolAuthority: deriveFeePoolAuthorityPda(this.programIds)[0],
        lpYieldAuthority: deriveLpYieldAuthority(this.programIds)[0],
        creator: creatorPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, creatorPk),
        operation: "closeMarket",
      },
    };
  }

  /**
   * Fund a market's LMSR curve: the creator posts the b·ln2 subsidy and
   * receives the LP allocation. Required for every created market: without it
   * the market LOOKS alive but cannot trade — `trade_positions` mints LP to
   * every buyer, and only `seed_lp` creates the LP mint.
   */
  async buildSeedLp(
    market: MarketRef,
    args: { creator: AddressRef },
  ): Promise<TradeRequest> {
    const creatorPk = decodePubkeyRef(args.creator);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const amm = await this.readAmmState(`sol:${marketPda.toBase58()}`);
    const bWad = amm?.b ?? 0n;
    const LN2_WAD = 693147180559945309n;
    const seedDepositWad = (bWad * LN2_WAD) / 10n ** 18n;
    const [lpMint] = deriveLpMintPda(resolved.marketId, this.programIds);
    const creatorLpAta = deriveUserLpAta(creatorPk, lpMint);
    const ix: TransactionInstruction = await (this.program.methods as any)
      .seedLp({
        lpAmount: bigIntToBn(1_000_000_000n),
        seedDepositWad: bigIntToBn(seedDepositWad),
      })
      .accounts({
        config: deriveProtocolConfigPda(this.programIds)[0],
        market: marketPda,
        ammState: deriveAmmStatePda(resolved.marketId, this.programIds)[0],
        lpMint,
        lpMintAuthority: deriveLpMintAuthorityPda(
          resolved.marketId,
          this.programIds,
        )[0],
        creatorLpAta,
        lpPosition: deriveLpPositionPda(
          resolved.marketId,
          creatorPk,
          this.programIds,
        )[0],
        marketVault: deriveMarketVaultAta(
          resolved.marketId,
          this.ammMint,
          this.programIds,
        ),
        creatorAmmAta: deriveUserUsdcAta(creatorPk, this.ammMint),
        ammMint: this.ammMint,
        creator: creatorPk,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, creatorPk),
        operation: "seedLp",
      },
    };
  }

  /**
   * Return the unspent LMSR subsidy to the creator (`reclaim_subsidy`).
   *
   * Reads every ledger that can still owe the vault — mint supply, AMM
   * aggregate, and the book's seats — so it needs all three accounts even
   * though it only moves USDC.
   */
  async buildReclaimSubsidy(
    market: MarketRef,
    args: { creator: AddressRef },
  ): Promise<TradeRequest> {
    const creatorPk = decodePubkeyRef(args.creator);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [ammState] = deriveAmmStatePda(resolved.marketId, this.programIds);
    const [lpPosition] = deriveLpPositionPda(
      resolved.marketId,
      creatorPk,
      this.programIds,
    );
    const [vaultAuthority] = deriveVaultAuthorityPda(
      resolved.marketId,
      this.programIds,
    );
    const ix: TransactionInstruction = await (this.program.methods as any)
      .reclaimSubsidy()
      .accounts({
        market: marketPda,
        ammState,
        lpPosition,
        vaultAuthority,
        vaultAmm: deriveMarketVaultAta(
          resolved.marketId,
          this.ammMint,
          this.programIds,
        ),
        creatorAmmAta: getAssociatedTokenAddressSync(this.ammMint, creatorPk),
        creator: creatorPk,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, creatorPk),
        preIxs: [this.usdcAtaCreateIx(creatorPk)],
        operation: "reclaimSubsidy",
      },
    };
  }

  /**
   * Cancel several orders in ONE transaction, then sweep the refunds.
   *
   * One transaction rather than one per order: N separate cancels would mean
   * N signatures, N fees, and N chances to half-finish and leave the trader
   * guessing which ones went. Cancelling is the action people take when they
   * want out quickly, which is the worst time to make them approve prompts one
   * at a time.
   *
   * Batching is cheap here because a transaction de-duplicates its account
   * list: every cancel touches the same book, market and signer, so the second
   * instruction onward adds only its header, a few account indices and the
   * 8-byte sequence. `book_withdraw` goes last so the whole batch's refunds
   * land in the wallet rather than in seat credit — the same composition a
   * single cancel already uses.
   *
   * Ordering matters: withdraw must come after every cancel, or it sweeps only
   * what was already there.
   */
  async buildBookCancelMany(
    market: MarketRef,
    args: { user: AddressRef; orderSeqs: readonly bigint[] },
  ): Promise<TradeRequest> {
    if (args.orderSeqs.length === 0) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildBookCancelMany: no orders given",
      });
    }
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const refs = this.bookRefs(marketPda, resolved.marketId);

    const cancels = args.orderSeqs.map((seq) =>
      buildBookCancelIx(refs, userPk, seq),
    );
    // Withdraw is the MAIN instruction so the cancels can ride in `preIxs`,
    // which `submit` replays in order ahead of it.
    const withdraw = buildBookWithdrawIx(refs, userPk);

    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(withdraw.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(withdraw, userPk),
        preIxs: [
          this.usdcAtaCreateIx(userPk),
          ...cancels.map((ix) => serializeIx(ix)),
        ],
        // Each cancel scans the book for its order, so a full batch needs well
        // more than the 400k default. 1.4M is the per-transaction maximum.
        computeUnitLimit: 1_400_000,
        operation: "bookCancelMany",
      },
    };
  }

  async buildBookCancel(
    market: MarketRef,
    args: { user: AddressRef; orderSeq: bigint },
  ): Promise<TradeRequest> {
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const ix = buildBookCancelIx(
      this.bookRefs(marketPda, resolved.marketId),
      userPk,
      args.orderSeq,
    );
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        operation: "bookCancel",
      },
    };
  }

  async buildBookWithdraw(
    market: MarketRef,
    args: { user: AddressRef },
  ): Promise<TradeRequest> {
    const userPk = decodePubkeyRef(args.user);
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const ix = buildBookWithdrawIx(
      this.bookRefs(marketPda, resolved.marketId),
      userPk,
    );
    return {
      kind: "trade",
      serializedTx: undefined,
      accounts: ixKeysToShim(ix.keys),
      meta: {
        marketPda: marketPda.toBase58(),
        ...buildIxMeta(ix, userPk),
        preIxs: [this.usdcAtaCreateIx(userPk)],
        operation: "bookWithdraw",
      },
    };
  }

  /** Decoded book snapshot — one `getAccountInfo`, no per-tick scan. */
  async readBook(market: MarketRef): Promise<BookSnapshot> {
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [pda] = bookPda(resolved.marketId, this.programIds);
    const info = await this.connection.getAccountInfo(pda);
    if (!info) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `book account not found for market ${marketPda.toBase58()}`,
      });
    }
    return decodeBook(Buffer.from(info.data));
  }

  /**
   * The question a market asked, recovered from its creation transaction.
   *
   * `Market` stores only `question_hash`, so the text lives in exactly one
   * place on chain: the `MarketCreated` event emitted at creation, which the
   * program only emits after proving the text hashes to the stored hash. That
   * makes this trustworthy without an indexer — but it is a transaction-history
   * read, not an index, so it is worth understanding the cost before calling it
   * in a loop.
   *
   * Creation is the OLDEST signature on the market PDA, and
   * `getSignaturesForAddress` pages newest-first, so a busy market means
   * walking back through its history. Bounded by `maxPages`; a market with more
   * traffic than that returns undefined rather than a wrong answer, and the
   * caller should cache what it finds.
   *
   * Returns undefined when no `MarketCreated` event on the account carries a
   * question that hashes to the stored `question_hash` — such a market's text
   * is not recoverable from chain data.
   */
  async readMarketQuestion(
    market: MarketRef,
    opts?: { maxPages?: number },
  ): Promise<string | undefined> {
    const marketPda = decodePubkeyRef(market);
    const maxPages = opts?.maxPages ?? 5;
    // The stored hash, used below to verify whatever the event decodes to.
    const resolved = await this.fetchMarket(marketPda);

    // Walk to the oldest signature on the account.
    let before: string | undefined;
    let oldest: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const sigs = await this.connection.getSignaturesForAddress(marketPda, {
        limit: 1000,
        before,
      });
      if (sigs.length === 0) break;
      oldest = sigs[sigs.length - 1].signature;
      if (sigs.length < 1000) break; // reached the beginning
      before = oldest;
      if (page === maxPages - 1) return undefined; // deeper than we will walk
    }
    if (!oldest) return undefined;

    const tx = await this.connection.getTransaction(oldest, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const logs = tx?.meta?.logMessages;
    if (!logs) return undefined;

    // `emit!` writes the event as base64 on a "Program data:" log line.
    for (const line of logs) {
      const m = line.match(/^Program data: (.+)$/);
      if (!m) continue;
      try {
        const decoded = (this.program as { coder: { events: { decode(s: string): { name: string; data: Record<string, unknown> } | null } } })
          .coder.events.decode(m[1]);
        if (!decoded) continue;
        if (!/^marketCreated$/i.test(decoded.name)) continue;
        const q = decoded.data.question;
        if (typeof q !== "string" || !q.trim()) continue;
        // Prove it before returning it.
        //
        // Decoding an event of a different layout against this schema does not
        // fail — it reads a length prefix out of unrelated bytes and hands back
        // binary garbage that is still a `string`. Rendering that as a title is
        // worse than rendering the address, and caching it is worse again.
        //
        // The program guarantees `sha256(question) == question_hash`, so the
        // stored hash is an independent witness: recompute and compare. A
        // mismatch returns undefined, which is the honest answer.
        const digest = await sha256(q);
        if (Buffer.from(digest).equals(Buffer.from(resolved.questionHash))) {
          return q;
        }
      } catch {
        // A log line that is not one of our events, or an older event shape.
        // Neither is an error — keep scanning.
      }
    }
    return undefined;
  }

  /**
   * The market's trade tape — every price-forming event, in chain order.
   *
   * This is what a Polymarket-style probability chart consumes, and it needs
   * no indexer: every price-forming instruction touches the market PDA, so
   * one signature walk finds them all, and the events were designed to be
   * priced without context —
   *
   *   AMM  `PositionTraded`  exec price = |cost_wad / delta_shares|
   *   AMM  `PositionSold`    exec price = amount_usdc / shares_sold
   *   book `OrdersFilled`    each fill carries `yes_tick` outright
   *
   * NO-side trades are complemented onto the YES axis: the program stores one
   * price axis, and so does this tape.
   *
   * Same cost model as `readBookHistory`: one `getTransaction` per signature,
   * bounded by `limit`, newest-first walk returned oldest-first. Callers
   * cache and pass `until` to fetch only what is new.
   */
  async readMarketTrades(
    market: MarketRef,
    opts?: { limit?: number; until?: string },
  ): Promise<
    Array<{
      signature: string;
      ts: number;
      yesPriceWad: bigint;
      sizeWad: bigint;
      venue: "amm" | "book";
    }>
  > {
    const marketPda = decodePubkeyRef(market);
    const limit = opts?.limit ?? 300;
    const sigs = await this.connection.getSignaturesForAddress(marketPda, {
      limit,
      until: opts?.until,
    });
    if (sigs.length === 0) return [];

    const out: Array<{
      signature: string;
      ts: number;
      yesPriceWad: bigint;
      sizeWad: bigint;
      venue: "amm" | "book";
    }> = [];
    const coder = (
      this.program as unknown as {
        coder: {
          events: {
            decode(s: string): { name: string; data: Record<string, unknown> } | null;
          };
        };
      }
    ).coder;

    const toBig = (v: unknown): bigint => BigInt((v as { toString(): string }).toString());
    const abs = (v: bigint) => (v < 0n ? -v : v);

    for (const sig of [...sigs].reverse()) {
      if (sig.err) continue;
      const tx = await this.connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx?.meta) continue;
      const blockTs = tx.blockTime ?? 0;

      // AMM events ride the logs (`emit!`).
      for (const line of tx.meta.logMessages ?? []) {
        const m = line.match(/^Program data: (.+)$/);
        if (!m) continue;
        let decoded: { name: string; data: Record<string, unknown> } | null = null;
        try {
          decoded = coder.events.decode(m[1]);
        } catch {
          continue;
        }
        if (!decoded) continue;
        if (/^positionTraded$/i.test(decoded.name)) {
          const d = decoded.data as {
            market: PublicKey; outcome: number; deltaShares: unknown; costWad: unknown; ts: unknown;
          };
          if (!new PublicKey(d.market).equals(marketPda)) continue;
          const delta = abs(toBig(d.deltaShares));
          if (delta === 0n) continue;
          const cost = abs(toBig(d.costWad));
          let priceWad = (cost * 10n ** 18n) / delta;
          if (Number(d.outcome) === 0) priceWad = 10n ** 18n - priceWad;
          out.push({
            signature: sig.signature,
            ts: Number(toBig(d.ts)) || blockTs,
            yesPriceWad: priceWad,
            sizeWad: delta,
            venue: "amm",
          });
        } else if (/^positionSold$/i.test(decoded.name)) {
          const d = decoded.data as {
            market: PublicKey; outcome: number; sharesSold: unknown; amountUsdc: unknown;
          };
          if (!new PublicKey(d.market).equals(marketPda)) continue;
          const shares = toBig(d.sharesSold);
          if (shares === 0n) continue;
          // amount is base units (1e6); shares are WAD. price = amount/shares
          // in WAD: amount * 1e12 * 1e18 / shares.
          let priceWad = (toBig(d.amountUsdc) * 10n ** 12n * 10n ** 18n) / shares;
          if (Number(d.outcome) === 0) priceWad = 10n ** 18n - priceWad;
          out.push({
            signature: sig.signature,
            ts: blockTs,
            yesPriceWad: priceWad,
            sizeWad: shares,
            venue: "amm",
          });
        }
      }

      // Book fills ride inner instructions (`emit_cpi!`) — decoded by the
      // same versioned parser `readBookHistory` uses. The framing (event-CPI
      // discriminator + versioned body) belongs in one decoder: a hand-rolled
      // offset here would drop real fills silently.
      if (tx.meta.innerInstructions) {
        const inner = tx.meta.innerInstructions.flatMap((group) =>
          group.instructions.map((ix) =>
            anchorUtils.bytes.bs58.decode((ix as { data: string }).data),
          ),
        );
        for (const event of decodeBookEventsFromInner(inner)) {
          if (event.kind !== "filled") continue;
          if (event.market !== marketPda.toBase58()) continue;
          for (const fill of event.fills) {
            out.push({
              signature: sig.signature,
              ts: Number(event.ts) || blockTs,
              // The book has ONE price axis, so the maker's tick
              // IS the YES price: 1..999 ticks = tenths of a cent.
              yesPriceWad: (BigInt(fill.priceTick) * 10n ** 18n) / 1000n,
              sizeWad: BigInt(fill.amount) * 10n ** 12n,
              venue: "book",
            });
          }
        }
      }
    }
    return out;
  }

  /**
   * Order history for a market, reconstructed from the book's own events.
   *
   * There is no indexer on the Solana fork (`VITE_USE_INDEXER=false`). The
   * book emits versioned CPI events (`emit_cpi!`), which land as inner
   * instructions on the transaction rather than as logs. So history is: walk
   * the book PDA's signatures, decode the events, keep them in chain order.
   *
   * Bounded by `limit` signatures — this is a read over transaction history,
   * not an index, and the cost is one `getTransaction` per signature. Callers
   * wanting deep history need a real indexer.
   */
  async readBookHistory(
    market: MarketRef,
    opts?: { limit?: number },
  ): Promise<Array<{ signature: string; slot: number; event: BookEvent }>> {
    const marketPda = decodePubkeyRef(market);
    const resolved = await this.fetchMarket(marketPda);
    const [pda] = bookPda(resolved.marketId, this.programIds);

    const limit = opts?.limit ?? 100;
    const sigs = await this.connection.getSignaturesForAddress(pda, { limit });
    if (sigs.length === 0) return [];

    const out: Array<{ signature: string; slot: number; event: BookEvent }> = [];
    // Oldest first, so the caller sees the order the chain applied.
    for (const sig of [...sigs].reverse()) {
      if (sig.err) continue; // a failed tx changed nothing
      const tx = await this.connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx?.meta?.innerInstructions) continue;
      const inner = tx.meta.innerInstructions.flatMap((group) =>
        // web3.js hands inner-instruction data back base58-encoded.
        group.instructions.map((ix) =>
          anchorUtils.bytes.bs58.decode((ix as { data: string }).data),
        ),
      );
      for (const event of decodeBookEventsFromInner(inner)) {
        out.push({ signature: sig.signature, slot: sig.slot, event });
      }
    }
    return out;
  }

  // ─── sooth_book order lifecycle builders ──────────────────────────────


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
    // Deterministic by default: the market id IS the question (first 16
    // bytes of its sha256). One question, one market — a second create of
    // the same text fails at `init`, and any client can DERIVE the PDA from
    // the words alone, which is what makes wizard-created markets
    // discoverable across browsers without a registry or indexer. Callers
    // that genuinely want two markets with identical text pass marketId.
    const marketId =
      args.marketId ??
      (args.question?.trim()
        ? (await sha256(args.question)).slice(0, 16)
        : randomMarketId());
    if (marketId.length !== 16) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `buildCreateMarket: marketId must be 16 bytes, got ${marketId.length}`,
      });
    }
    // The program now takes the question TEXT and proves it hashes to
    // `question_hash` before emitting it in `MarketCreated`. That event is the
    // only place the words exist on chain, so a caller that supplies a bare
    // hash and no text would create a market nobody can ever render.
    if (!args.question || !args.question.trim()) {
      throw new SoothError({
        kind: "ProgramError",
        msg: "buildCreateMarket: question text is required — the program verifies it against questionHash and emits it, and without it the market has no recoverable title",
      });
    }
    const question = args.question.trim();
    const questionBytes = new TextEncoder().encode(question).length;
    if (questionBytes > MAX_QUESTION_LEN) {
      throw new SoothError({
        kind: "ProgramError",
        msg: `buildCreateMarket: question is ${questionBytes} bytes, max ${MAX_QUESTION_LEN}`,
      });
    }
    // Derived from the text rather than trusted from the caller: the program
    // rejects a mismatch anyway, and failing here names the cause.
    const questionHash = await sha256(question);
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
    const [vaultAuthority] = deriveVaultAuthorityPda(marketId, this.programIds);
    const [lockAuthority] = deriveLockAuthorityPda(marketId, this.programIds);
    // Three vaults, two mints. The book and AMM collateral vaults share the
    // `vault_authority` PDA — a signer-only PDA owns one ATA per mint — while
    // the sell-lock escrow hangs off `lock_authority` and follows the AMM's
    // token, because only the AMM has a sell-with-cooldown path.
    const vaultBook = deriveMarketVaultAta(
      marketId,
      this.bookMint,
      this.programIds,
    );
    const vaultAmm = deriveMarketVaultAta(
      marketId,
      this.ammMint,
      this.programIds,
    );
    const lockVault = deriveLockVaultAta(
      marketId,
      this.ammMint,
      this.programIds,
    );
    const [ammStatePda] = deriveAmmStatePda(marketId, this.programIds);
    const [configPda] = deriveProtocolConfigPda(this.programIds);

    // ── Build the ix via Anchor's coder ────────────────────────────────
    //
    // `CreateMarketArgs` on-chain (from the IDL) has fields:
    //   market_id: [u8;16], question_hash: [u8;32], start_time: i64,
    //   deadline: i64, adjudicator: pubkey, initial_b: u128
    // Order matters for borsh — we pass the object Anchor's coder expects.
    const ix: TransactionInstruction = await (this.program.methods as any)
      .createMarket({
        marketId: Array.from(marketId),
        question,
        questionHash: Array.from(questionHash),
        startTime: bigIntToBn(startTime),
        deadline: bigIntToBn(args.deadline),
        adjudicator,
        initialB: bigIntToBn(initialB),
      })
      .accounts({
        config: configPda,
        market: marketPda,
        vaultAuthority,
        lockAuthority,
        bookMint: this.bookMint,
        ammMint: this.ammMint,
        vaultBook,
        vaultAmm,
        lockVault,
        ammState: ammStatePda,
        creator: userPk,
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

  /**
   * HTTP-only confirmation: poll `getSignatureStatus` until the signature
   * reaches `confirmed`/`finalized` (or carries an error).
   *
   * Deliberately NOT `connection.confirmTransaction`, which subscribes via
   * `signatureSubscribe` over a websocket. HTTP-only endpoints (Alchemy's, for
   * one) reject that with "Method not found", which turns into a spurious
   * confirmation timeout and makes `submit` retry a transaction that has
   * ALREADY landed — the replayed non-idempotent `InitMarketFeePool` preIx
   * then fails with `Custom(0)`, reporting a failure for a trade that executed.
   *
   * Returns the same `{ value: { err } }` shape the caller inspects. Throws
   * only on genuine expiry/timeout, so a retry is safe: the transaction
   * demonstrably did not land.
   */
  private async confirmBySignatureStatus(
    sig: string,
    lastValidBlockHeight: number,
  ): Promise<{ value: { err: unknown } }> {
    const POLL_MS = 1000;
    const deadlineMs = Date.now() + 60_000;
    while (Date.now() < deadlineMs) {
      const { value } = await this.connection.getSignatureStatus(sig);
      if (value) {
        if (
          value.confirmationStatus === "confirmed" ||
          value.confirmationStatus === "finalized"
        ) {
          return { value: { err: value.err ?? null } };
        }
        if (value.err) return { value: { err: value.err } };
      } else {
        // Not yet visible. Once the chain passes the blockhash's validity
        // window the tx can never land — bail so the caller retries fresh.
        const height = await this.connection.getBlockHeight("confirmed");
        if (height > lastValidBlockHeight) {
          throw new Error(
            `transaction ${sig} expired (block height ${height} > ${lastValidBlockHeight})`,
          );
        }
      }
      await sleep(POLL_MS);
    }
    throw new Error(`confirmation timeout for ${sig}`);
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
      const microLamports = await this.nextSubmitComputeUnitPriceMicroLamports(
        parseOptionalPublicKey(meta.marketPda),
      );
      const tx = new Transaction();
      // 400k suits a single instruction. A batch does not: each `book_cancel`
      // walks the book to find its order, so a 24-cancel transaction exhausts
      // the default partway through and fails with "Program failed to
      // complete" — which names neither the limit nor the instruction that hit
      // it. Builders that know they are batching set `computeUnitLimit`.
      const requested = (meta as unknown as { computeUnitLimit?: unknown })
        .computeUnitLimit;
      const unitLimit = typeof requested === "number" ? requested : 400_000;
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }));
      // sooth_core ships a 256 KB custom #[global_allocator] (see its lib.rs).
      // The runtime only maps that heap when the transaction asks, and the
      // allocator addresses from the TOP of the region — so without this every
      // sooth_core instruction faults with "Access violation in heap section".
      // Unconditional: the merged program means every instruction shares it.
      tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }));
      // Priority fee = recent p50 for this market's locked writable account
      // plus a byte-level salt. The salt is load-bearing: two identical writes
      // in the same blockhash window must still hash differently even when the
      // fee cache returns the same p50 value.
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
        // Name the wallet.
        //
        // "Attempt to debit an account but found no record of a prior credit"
        // means the FEE PAYER has no lamports, and the raw message identifies
        // neither the account nor the cluster. When several wallets are in
        // play — and a browser extension decides which one is connected — that
        // is unanswerable from the message alone: every candidate can look
        // funded while the one actually signing is not.
        //
        // So resolve it here, where the fee payer and the connection are both
        // in hand, and state the balance as observed on THIS RPC.
        if (/found no record of a prior credit/i.test(classified.error.message)) {
          const balance = await this.connection
            .getBalance(userPk)
            .catch(() => null);
          // Rebuild from the INNER text, not `error.message`. The latter is
          // already "SoothError: NetworkError attempt=1 msg=…", so feeding it
          // back in as `msg` nests the prefix and pushes the useful part off
          // the end of a toast.
          const inner =
            (classified.error.fields as { msg?: string }).msg ??
            classified.error.message;
          classified.error = new SoothError({
            kind: "NetworkError",
            msg:
              `${inner}\n  SIGNER: ${userPk.toBase58()}` +
              `\n  BALANCE: ${balance === null ? "unreadable" : `${balance / 1e9} SOL`}` +
              ` on ${this.connection.rpcEndpoint}` +
              (balance === 0
                ? `\n  This wallet has no SOL on this cluster. If it looks funded` +
                  ` elsewhere, the wallet extension is connected to a different` +
                  ` account or a different network than the app.`
                : ""),
            attempt,
          });
        }
        lastError = classified.error;
        if (classified.retryable && attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw classified.error;
      }

      // Poll over plain HTTP rather than the websocket subscribe that
      // `confirmTransaction` uses — see confirmBySignatureStatus. A landed tx
      // is detected on attempt 1 and therefore never retried.
      let confirmation: { value: { err: unknown } };
      try {
        confirmation = await this.confirmBySignatureStatus(
          sig,
          lastValidBlockHeight,
        );
      } catch (e) {
        // Genuine timeout/expiry: the tx did not land within the blockhash
        // window. Safe to retry — non-idempotent preIxs such as
        // InitMarketFeePool never executed, so the replay runs cleanly under
        // the next blockhash.
        lastError = makeNetworkError(e, attempt, sig);
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      // Inspect confirmation.value.err. Confirmation resolves successfully
      // even for transactions whose execution reverted — the failure surface
      // is the `value.err` field, not a thrown exception, so a failed trade
      // reaches here looking like a success.
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
    // sooth_core ships a 256 KB custom #[global_allocator] (see its lib.rs).
    // The runtime only maps that heap when the transaction asks, and the
    // allocator addresses from the TOP of the region — so without this every
    // sooth_core instruction faults with "Access violation in heap section".
    // Unconditional: the merged program means every instruction shares it.
    tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }));
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
      // Local SVM shims and transient RPC failures may not expose recent
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
    const raw = await (this.program.account as any).market.fetchNullable(
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
      vaultBook: raw.vaultBook,
      vaultAmm: raw.vaultAmm,
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
      deriveMarketVaultAta(resolved.marketId, this.ammMint, this.programIds),
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

function nextSubmitComputeUnitPriceSalt(
  percentileMicroLamports: number,
): number {
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


/**
 * `init_market_fee_pool` — creates BOTH venue fee pools in one instruction.
 *
 * Both, because an SPL token account holds exactly one mint: the AMM's fees
 * and the book's physically cannot share an account. Creating them together
 * means a market cannot end up with half its fee plumbing, which would fail
 * later as `AccountNotInitialized` on the first fill of whichever venue was
 * missed.
 *
 * Returns the AMM pool because the AMM trade path is the caller that needs to
 * name it; the book pool is created here but derived where it is used.
 */
function buildInitMarketFeePoolIx(args: {
  market: PublicKey;
  marketId: Uint8Array;
  user: PublicKey;
  bookMint: PublicKey;
  ammMint: PublicKey;
  coreProgramId: PublicKey;
}): { marketFeePool: PublicKey; ix: TransactionInstruction } {
  const [feePoolAuthority] = deriveFeePoolAuthorityPda({
    soothCore: args.coreProgramId,
  });
  const [feePoolBook] = feePoolBookPda(args.marketId, {
    soothCore: args.coreProgramId,
  });
  const [feePoolAmm] = feePoolAmmPda(args.marketId, {
    soothCore: args.coreProgramId,
  });
  const [lpYieldAuthority] = deriveLpYieldAuthority({
    soothCore: args.coreProgramId,
  });
  const [lpYieldAmm] = lpYieldAmmPda(args.marketId, {
    soothCore: args.coreProgramId,
  });
  const [lpYieldBook] = lpYieldBookPda(args.marketId, {
    soothCore: args.coreProgramId,
  });
  return {
    marketFeePool: feePoolAmm,
    ix: new TransactionInstruction({
      programId: args.coreProgramId,
      keys: [
        { pubkey: args.market, isSigner: false, isWritable: false },
        { pubkey: feePoolAuthority, isSigner: false, isWritable: false },
        { pubkey: args.bookMint, isSigner: false, isWritable: false },
        { pubkey: args.ammMint, isSigner: false, isWritable: false },
        { pubkey: feePoolBook, isSigner: false, isWritable: true },
        { pubkey: feePoolAmm, isSigner: false, isWritable: true },
        // The per-market LP yield vaults, created alongside the pools since
        // the global-vault cross-market fix. Hand-rolled key list: order MUST
        // match the InitMarketFeePool struct.
        { pubkey: lpYieldAuthority, isSigner: false, isWritable: false },
        { pubkey: lpYieldAmm, isSigner: false, isWritable: true },
        { pubkey: lpYieldBook, isSigner: false, isWritable: true },
        { pubkey: args.user, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(INIT_MARKET_FEE_POOL_DISCRIMINATOR),
    }),
  };
}

// SHA-256 of the input string (UTF-8 encoded). 32-byte output. Used as a
// default `questionHash` when the caller doesn't provide one. EVM uses
// keccak256 for the same role; Solana's `solana-program` exposes both
// SHA-256 and keccak — we pick SHA-256 here because `crypto.subtle` ships
// it natively whereas keccak would require a userland dep.
/** The default market id for a question: first 16 bytes of sha256(text).
 * Exported so frontends can derive a question's market PDA without creating
 * it — the discovery primitive for registry-less clients. */
export async function marketIdForQuestion(
  question: string,
): Promise<Uint8Array> {
  return (await sha256(question)).slice(0, 16);
}

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
// Anchor numbers user errors starting at 6000 in the order they appear in
// `error.rs`. The decoder still keys by failing-program-ID so a code from an
// unrelated program (SPL, system) is never misread as a sooth_core error.
//
// Error table mirrors `sooth_core/src/error.rs` SoothCoreError enum order.
const SOOTH_CORE_ERROR_TABLE: Record<number, { kind: string; msg: string }> = {
  6000: { kind: "MarketNotActive", msg: "Market is not in the Open lifecycle state" },
  6001: { kind: "ProgramError", msg: "Market is not Settled" },
  6002: { kind: "ProgramError", msg: "Lifecycle transition not permitted from current state" },
  6003: { kind: "ProgramError", msg: "Invalid outcome (must be NO=0, YES=1, or INVALID=2)" },
  6004: { kind: "ProgramError", msg: "Amount must be non-zero" },
  6005: { kind: "InsufficientShares", msg: "Insufficient outcome-token balance" },
  6006: { kind: "ProgramError", msg: "Math overflow" },
  6007: { kind: "ProgramError", msg: "Vault / mint authority mismatch" },
  6008: { kind: "ProgramError", msg: "Deadline must be greater than start_time" },
  6009: { kind: "ProgramError", msg: "Adjudicator pubkey must not be the default (all-zero) key" },
  6010: { kind: "MarketNotDismissed", msg: "Market is not dismissed" },
  6011: { kind: "TradingClosed", msg: "Trading window has closed (now >= deadline)" },
  6012: { kind: "InvalidTick", msg: "Invalid tick" },
  6013: { kind: "ProgramError", msg: "Amount too small for base token decimals" },
  6014: { kind: "SlippageExceeded", msg: "Slippage: cost exceeded max_cost_wad" },
  6015: { kind: "ProgramError", msg: "delta_shares must be non-zero" },
  6016: { kind: "InsufficientShares", msg: "Insufficient shares to sell" },
  6017: { kind: "MarketNotActive", msg: "Market is dismissed" },
  6018: { kind: "ProgramError", msg: "Liquidity parameter b must be > 0" },
  6019: { kind: "ProgramError", msg: "Caller is not authorized for this action (creator mismatch)" },
  6020: { kind: "TradingNotStarted", msg: "Trading window has not started yet (now < start_time)" },
  6021: { kind: "SellNotImplemented", msg: "Sell path is not implemented yet — see trade_positions.rs §6 / architecture §4.3" },
  6022: { kind: "LockNotElapsed", msg: "Lock has not elapsed yet (now < lock_entry.unlock_at)" },
  6023: { kind: "LockVaultMismatch", msg: "Lock vault account does not match market.lock_vault" },
  6024: { kind: "TrialNotExpired", msg: "Trial period has not expired yet" },
  6025: { kind: "AlreadyGraduated", msg: "Market has already graduated" },
  6026: { kind: "AlreadyDismissed", msg: "Market has already been dismissed" },
  6027: { kind: "ProgramError", msg: "AmmState market backlink does not match market account" },
  6028: { kind: "ProgramError", msg: "Fee bps must not exceed 10000 (100%)" },
  6029: { kind: "ProgramError", msg: "Fee split bps do not sum to 10000" },
  6030: { kind: "ProgramError", msg: "Treasury pubkey must be non-default" },
  6031: { kind: "ProgramError", msg: "Default trial period must be > 0" },
  6032: { kind: "ProgramError", msg: "Fee pool is empty — nothing to distribute" },
  6033: { kind: "NotGraduated", msg: "Market is not graduated" },
  6034: { kind: "ProgramError", msg: "LP amount must be > 0" },
  6035: { kind: "ProgramError", msg: "LP supply is empty" },
  6036: { kind: "ProgramError", msg: "Legacy fee drain already executed" },
  6037: { kind: "ProgramError", msg: "Caller is not the registered authority for this adjudicator" },
  6038: { kind: "ProgramError", msg: "Adjudicator has already attested an outcome; re-attestation is not permitted" },
  6039: { kind: "ProgramError", msg: "Adjudicator account does not match the supplied market" },
  6040: { kind: "ProgramError", msg: "Adjudicator has already been disputed; dispute is one-shot per market" },
  6041: { kind: "ProgramError", msg: "Market is already settled; dispute can no longer override the outcome" },
  6042: { kind: "ProgramError", msg: "Order id is outside the supported composite encoding range" },
  6043: { kind: "ProgramError", msg: "Decoded order id does not match the requested side or tick" },
  6044: { kind: "ProgramError", msg: "Book side is full for this tick" },
  6045: { kind: "ProgramError", msg: "Book side is not fully drained" },
  6046: { kind: "ProgramError", msg: "Compaction drop count exceeds the per-call bound" },
  6047: { kind: "ProgramError", msg: "Market vault uses the wrong base mint" },
  6048: { kind: "ProgramError", msg: "MarketBook base mint does not match the market vault mint" },
  6049: { kind: "ProgramError", msg: "MarketBook accumulators must be reset before placing an order" },
  6050: { kind: "ProgramError", msg: "No cancellable order was found" },
  6051: { kind: "ProgramError", msg: "Remaining-account bundle does not carry the crossing BookSide" },
  6052: { kind: "ProgramError", msg: "Remaining-account bundle maker does not match the live order maker" },
  6053: { kind: "ProgramError", msg: "Remaining-account bundles must contain exactly three accounts per fill" },
  6054: { kind: "ProgramError", msg: "Protocol is paused; trading, new liquidity and market creation are disabled" },
  6055: { kind: "ProgramError", msg: "Adjudicator has not yet attested an outcome for this market" },
  6056: { kind: "ProgramError", msg: "Trading window has not closed yet (now < deadline)" },
};

// Lookup of failing-program-ID base58 → which error table to consult. Built
// per-adapter at construction time so the decoder doesn't need to know the
// concrete deployment IDs (those rotate across localnet/devnet/mainnet).
type ProgramErrorLookup = Map<
  string,
  Record<number, { kind: string; msg: string }>
>;

// Exported for tests so they can assert error code disambiguation.
export const __testing = {
  decodeSubmitError: (...args: Parameters<typeof decodeSubmitError>) =>
    decodeSubmitError(...args),
  extractFailingProgramId,
  SOOTH_CORE_ERROR_TABLE,
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
    // the failing program ID if we recovered one. Don't guess at semantics:
    // a code from a non-sooth_core program must not be mapped to this table.
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
    msg: withHint(errorText(raw)),
    signature,
    attempt,
  });
}

/**
 * Append a plain-language hint for failures that are common and whose RPC
 * wording does not say what to do about them.
 *
 * "Attempt to debit an account but found no record of a prior credit" means
 * the fee payer has never received lamports. On a local validator that is the
 * single most common first-run failure — a freshly-imported wallet with no
 * airdrop — and the raw text names neither the account nor the remedy.
 */
function withHint(text: string): string {
  if (/found no record of a prior credit/i.test(text)) {
    return `${text}\n  HINT: the signing wallet has no SOL. Airdrop to it (\`solana airdrop 2 <PUBKEY> -u <RPC>\`) before trading.`;
  }
  if (/insufficient (funds|lamports)/i.test(text)) {
    return `${text}\n  HINT: the signing wallet cannot cover this trade plus fees and rent.`;
  }
  return text;
}

/**
 * Human-readable text for an RPC error, INCLUDING program logs.
 *
 * web3.js `SendTransactionError.message` is the bare string
 * `"Simulation failed."` — everything that identifies the actual failure lives
 * on `.logs`. Returning only `.message` produced errors like
 * `NetworkError attempt=1 msg=Simulation failed.`, which tells a user nothing
 * and tells a developer less: the same text covers a missing token account, an
 * unfunded wallet, a wrong program id and a paused protocol.
 *
 * The last few log lines carry the Anchor error name and code, so they are
 * appended.
 */
function errorText(raw: unknown): string {
  if (raw instanceof Error) {
    const logs = extractLogs(raw);
    if (logs.length > 0) {
      // Tail rather than head: the Anchor error line and the failing program
      // are always at the end, while the head is invoke/success noise.
      const tail = logs.slice(-6).join("\n  ");
      return `${raw.message}\n  ${tail}`;
    }
    return raw.message;
  }
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/** Program logs off a web3.js SendTransactionError, in any of its shapes. */
function extractLogs(raw: unknown): string[] {
  const e = raw as {
    logs?: unknown;
    transactionLogs?: unknown;
    cause?: { logs?: unknown };
  };
  for (const candidate of [e?.logs, e?.transactionLogs, e?.cause?.logs]) {
    if (Array.isArray(candidate)) {
      return candidate.filter((l): l is string => typeof l === "string");
    }
  }
  return [];
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
// Why we need this: Anchor numbers user errors starting at 6000. A code in
// that range can also originate from an unrelated program in the same
// transaction (SPL token, system). The failing-program-ID lets the decoder
// apply the sooth_core table only when sooth_core is the program that failed.
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
