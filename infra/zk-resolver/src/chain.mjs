// Everything that talks to Solana.
//
// Reading (is this market due? is it already attested? what rule did it
// commit to?) and writing (`request_lock`, `attest_outcome_zk`) both live
// here, so the resolution loop in `resolve.mjs` stays a decision procedure
// over plain data and can be unit-tested with no validator.

import { loadAnchor, loadSdk, loadWeb3 } from "./deps.mjs";

const web3 = await loadWeb3();
const {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} = web3;
const anchor = await loadAnchor();
const { AnchorProvider, BN, Program, utils: anchorUtils } = anchor;

export const sdk = await loadSdk();

/**
 * HARD INVARIANT (CLAUDE.md): every transaction hitting `sooth_core` must
 * prepend a 256 KB heap-frame request. The program installs a custom 256 KB
 * bump `#[global_allocator]`, and the runtime only maps that region when the
 * transaction asks for it. Omit this and the program aborts on its first
 * allocation.
 */
export const heapFrameIx = () =>
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 });

/**
 * `secp256k1_recover` plus three keccak passes fit inside the default 200k,
 * but the margin costs nothing and keeps a fee-market bump from turning into
 * an exceeded-CU failure.
 */
export const cuLimitIx = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

/**
 * Lifecycle discriminant name, lowercased.
 *
 * Anchor deserializes a unit enum into a single-key tagged object —
 * `MarketLifecycle::Locked` arrives as `{ locked: {} }`. Lowercasing makes the
 * comparisons in `resolve.mjs` independent of the IDL's casing convention.
 */
export function lifecycleName(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") return String(lifecycle);
  const key = Object.keys(lifecycle)[0];
  return key ? key.toLowerCase() : "unknown";
}

export class Chain {
  #program;
  #adapter;

  constructor({ connection, program, adapter, payer, programId }) {
    this.connection = connection;
    this.#program = program;
    this.#adapter = adapter;
    this.payer = payer;
    this.programId = programId;
  }

  /**
   * `payer` may be null — `--plan` reads chain state without a key, which is
   * how an operator inspects what the resolver would do before funding
   * anything.
   */
  static async connect({ rpcUrl, payer, programId }) {
    const connection = new Connection(rpcUrl, "confirmed");
    const id = programId ?? new PublicKey(sdk.soothCoreIdl.address);

    // Anchor insists on a wallet even for reads. With no key, a throwing stub
    // keeps reads working and makes an accidental write loud instead of
    // silently unsigned.
    const wallet = payer
      ? {
          publicKey: payer.publicKey,
          signTransaction: async (tx) => (tx.partialSign(payer), tx),
          signAllTransactions: async (txs) => (
            txs.forEach((t) => t.partialSign(payer)), txs
          ),
          payer,
        }
      : {
          publicKey: PublicKey.default,
          signTransaction: async () => {
            throw new Error("read-only: RESOLVER_KEYPAIR is not set");
          },
          signAllTransactions: async () => {
            throw new Error("read-only: RESOLVER_KEYPAIR is not set");
          },
        };

    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const program = new Program(
      { ...sdk.soothCoreIdl, address: id.toBase58() },
      provider,
    );
    const adapter = new sdk.SolanaChainAdapter({
      node: {
        id: "resolver",
        chainKind: "solana",
        chainId: "devnet",
        cluster: "devnet",
        rpcUrl,
        programs: { soothCore: id.toBase58() },
      },
      connection,
    });

    return new Chain({ connection, program, adapter, payer, programId: id });
  }

  get program() {
    return this.#program;
  }

  get adapter() {
    return this.#adapter;
  }

  adjudicatorPda(marketPk) {
    return sdk.pdas.deriveAdjudicatorEntryPda(marketPk, {
      soothCore: this.programId,
    })[0];
  }

  /**
   * The full on-chain picture for one market, normalized.
   *
   * Anchor's field naming depends on the IDL's casing, so both spellings are
   * read for every field — the same defensive read `zk-attest-devnet.mjs`
   * does. A missing account comes back as `{ exists: false }` rather than
   * throwing, because an unregistered market is a legitimate registry state
   * the loop reports and skips.
   */
  async readMarket(marketBase58) {
    const marketPk = new PublicKey(marketBase58);
    const entryPk = this.adjudicatorPda(marketPk);

    const [market, entry] = await Promise.all([
      this.#program.account.market.fetch(marketPk).catch(() => null),
      this.#program.account.adjudicatorEntry.fetch(entryPk).catch(() => null),
    ]);

    if (!market) {
      return { exists: false, reason: `market account ${marketBase58} not found`, marketPk, entryPk };
    }
    if (!entry) {
      return {
        exists: false,
        reason: `no AdjudicatorEntry at ${entryPk.toBase58()} — the market has no zk adjudicator registered`,
        marketPk,
        entryPk,
      };
    }

    const pick = (obj, snake, camel) => obj[snake] ?? obj[camel];
    const attestedOutcome = pick(entry, "attested_outcome", "attestedOutcome");
    const attestedAt = pick(entry, "attested_at", "attestedAt");

    return {
      exists: true,
      marketPk,
      entryPk,
      market: {
        deadline: Number(market.deadline.toString()),
        lifecycle: lifecycleName(market.lifecycle),
        question: market.question,
      },
      entry: {
        authority: pick(entry, "authority", "authority"),
        attestedOutcome: attestedOutcome ?? null,
        attestedAt: attestedAt == null ? null : Number(attestedAt.toString()),
        disputed: entry.disputed ?? false,
        comparator: pick(entry, "zk_comparator", "zkComparator"),
        valueScale: pick(entry, "zk_value_scale", "zkValueScale"),
        attestorEvm: Uint8Array.from(pick(entry, "zk_attestor_evm", "zkAttestorEvm")),
        ruleHash: Uint8Array.from(pick(entry, "zk_rule_hash", "zkRuleHash")),
        threshold: BigInt(pick(entry, "zk_threshold", "zkThreshold").toString()),
      },
    };
  }

  /**
   * The raw `Market` account, plus the PDAs the T\* voiding path derives from
   * it. `market_id` is the seed every sibling account hangs off, so it is read
   * once here rather than re-derived at each call site.
   */
  async readMarketAccount(marketPk) {
    const market = await this.#program.account.market.fetch(marketPk);
    const programs = { soothCore: this.programId };
    const marketId = Uint8Array.from(market.marketId ?? market.market_id);
    return {
      market,
      marketId,
      ammState: sdk.pdas.deriveAmmStatePda(marketId, programs)[0],
      protocolConfig: sdk.pdas.deriveProtocolConfigPda(programs)[0],
      resolutionCommitment: sdk.pdas.deriveResolutionCommitmentPda(marketPk, programs)[0],
      book: sdk.bookPda(marketId, programs)[0],
      vaultAmm: new PublicKey(market.vaultAmm ?? market.vault_amm),
      vaultBook: new PublicKey(market.vaultBook ?? market.vault_book),
      startTime: Number((market.startTime ?? market.start_time).toString()),
      deadline: Number(market.deadline.toString()),
      lifecycle: lifecycleName(market.lifecycle),
    };
  }

  /**
   * Every `Position` on this market.
   *
   * This is the authoritative set of wallets that must be able to redeem: once
   * a commitment exists, `redeem_amm_position` REFUSES a `None` claim, so a
   * position with no leaf in the tree cannot redeem at all. The tape says what
   * a wallet is owed; this says who must appear.
   *
   * Filtered on `Position.market`, which sits at offset 8 (discriminator) + 32
   * (user) = 40.
   */
  async readPositions(marketPk, { marketId, wallets = [] } = {}) {
    try {
      const all = await this.#program.account.position.all([
        { memcmp: { offset: 40, bytes: marketPk.toBase58() } },
      ]);
      return { positions: all, source: "getProgramAccounts" };
    } catch (err) {
      // `getProgramAccounts` is gated on plenty of hosted endpoints, and a
      // resolver that only works on an unmetered RPC is not a resolver. The
      // fallback derives one PDA per wallet the tape mentions and fetches
      // those directly — which is the same set on an honest, complete tape,
      // and a STRICT SUBSET when the tape is short. That difference matters,
      // so the caller is told which source it got.
      if (!marketId) throw err;
      const programs = { soothCore: this.programId };
      const keys = wallets.map(
        (w) => sdk.pdas.derivePositionPda(marketId, new PublicKey(w), programs)[0],
      );
      const positions = [];
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const infos = await this.connection.getMultipleAccountsInfo(chunk, "confirmed");
        infos.forEach((info, j) => {
          if (!info || info.data.length === 0) return;
          positions.push({
            publicKey: chunk[j],
            account: this.#program.coder.accounts.decode("position", info.data),
          });
        });
      }
      return { positions, source: "tape-derived", reason: String(err?.message ?? err) };
    }
  }

  /**
   * The book's seats, or `null` when the market never graduated.
   *
   * Decoded with the SDK's own `decodeBook` so the resolver and the demo read
   * the same arena the same way.
   */
  async readBookSeats(bookPk) {
    const info = await this.connection.getAccountInfo(bookPk, "confirmed");
    if (!info || info.data.length === 0) return null;
    return sdk.decodeBook(info.data).seats;
  }

  /**
   * How much of the veto window is left, from the state that decides it.
   *
   * `publish_resolution_commitment` is accepted only while
   * `now < attested_at + veto_period_secs`, measured from the ATTESTATION so a
   * late publisher gets the scrutiny that is left rather than a fresh window.
   * Read before building a transaction, so a closed window is reported as what
   * it is instead of arriving as a rejected signature.
   */
  async readVetoWindow(marketPk, protocolConfigPk) {
    const [entry, config] = await Promise.all([
      this.#program.account.adjudicatorEntry.fetch(this.adjudicatorPda(marketPk)),
      this.#program.account.protocolConfig.fetch(protocolConfigPk),
    ]);
    const attestedAt = entry.attestedAt ?? entry.attested_at;
    const vetoPeriodSecs = Number(
      (config.vetoPeriodSecs ?? config.veto_period_secs).toString(),
    );
    if (attestedAt == null) {
      return { attested: false, vetoPeriodSecs, closesAt: null, secondsLeft: null };
    }
    const closesAt = Number(attestedAt.toString()) + vetoPeriodSecs;
    return {
      attested: true,
      attestedAt: Number(attestedAt.toString()),
      vetoPeriodSecs,
      closesAt,
      secondsLeft: closesAt - (await this.now()),
    };
  }

  /** The published commitment, or `null` — absence is the honest default. */
  async readResolutionCommitment(pda) {
    return this.#program.account.resolutionCommitment.fetch(pda).catch(() => null);
  }

  /**
   * `publish_resolution_commitment`, signed by the adjudicator authority.
   *
   * Callable only while the market is `Locked`, attested, and inside the veto
   * window — the program checks all three, and so does `--void` before it gets
   * here, so a refusal at this point is a race rather than a mistake.
   */
  async publishResolutionCommitment(marketPk, accounts, args, { extraPreIxs = [] } = {}) {
    const tx = await this.#program.methods
      .publishResolutionCommitment({
        merkleRoot: Array.from(args.merkleRoot),
        tStar: new BN(args.tStar.toString()),
        leafCount: args.leafCount,
        totalVoidRefundUsdc: new BN(args.totalVoidRefundUsdc.toString()),
        totalBookVoidRefundUsdc: new BN(args.totalBookVoidRefundUsdc.toString()),
      })
      .accounts({
        resolutionCommitment: accounts.resolutionCommitment,
        market: marketPk,
        adjudicatorEntry: accounts.adjudicatorEntry,
        protocolConfig: accounts.protocolConfig,
        ammState: accounts.ammState,
        vaultAmm: accounts.vaultAmm,
        book: accounts.book,
        vaultBook: accounts.vaultBook,
        authority: this.payer.publicKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .preInstructions([heapFrameIx(), ...extraPreIxs])
      .transaction();
    return this.sendAndConfirm(tx, [this.payer]);
  }

  /** Chain time, which is what every deadline is compared against. */
  async now() {
    const slot = await this.connection.getSlot("confirmed");
    const t = await this.connection.getBlockTime(slot);
    return t ?? Math.floor(Date.now() / 1000);
  }

  /**
   * `Open` -> `Locked`, which `attest_outcome_zk` requires.
   *
   * Signer-gated on `adjudicator_entry.authority`, unlike attestation itself.
   * The resolver can only do this when its fee payer happens to BE that
   * authority; otherwise the caller reports the market as blocked and moves
   * on rather than pretending it can proceed.
   */
  async requestLock(marketPk, entryPk) {
    const tx = await this.#program.methods
      .requestLock()
      .accounts({
        adjudicatorEntry: entryPk,
        market: marketPk,
        authority: this.payer.publicKey,
      })
      .preInstructions([heapFrameIx()])
      .transaction();
    return this.sendAndConfirm(tx, [this.payer]);
  }

  /**
   * Submits `attest_outcome_zk` through the SDK builder.
   *
   * Permissionless: the fee payer is not an authority. The attestation carries
   * its own, and the program re-encodes and recovers the signer rather than
   * trusting anything this process asserts.
   */
  async attestOutcomeZk(marketPk, attestation) {
    const req = await this.#adapter.buildAttestOutcomeZk(
      `sol:${marketPk.toBase58()}`,
      {
        user: `sol:${this.payer.publicKey.toBase58()}`,
        attestation: sdk.toZkAttestationArg(attestation),
      },
    );
    const tx = new Transaction().add(
      cuLimitIx(),
      heapFrameIx(),
      ixFromMeta(req.meta),
    );
    return this.sendAndConfirm(tx, [this.payer]);
  }

  /**
   * Send and confirm over HTTP only.
   *
   * web3.js derives its websocket URL from the HTTP one and waits on
   * `signatureSubscribe`; the proxied endpoints this project uses do not serve
   * it on the free tier, so `confirmTransaction` reports an expiry for
   * transactions that in fact landed. Polling `getSignatureStatuses` is what
   * `zk-attest-devnet.mjs` and `seed-localnet.mjs` both fall back to, promoted
   * here to the only path so behaviour is identical on any endpoint.
   */
  async sendAndConfirm(tx, signers, { timeoutMs = 60_000 } = {}) {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);

    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = (
        await this.connection.getSignatureStatuses([sig], {
          searchTransactionHistory: true,
        })
      ).value?.[0];
      if (st?.err) {
        const err = new Error(`transaction ${sig} failed`);
        err.signature = sig;
        err.txErr = st.err;
        throw err;
      }
      if (
        st &&
        (st.confirmationStatus === "confirmed" ||
          st.confirmationStatus === "finalized")
      ) {
        return sig;
      }
      await sleep(1000);
    }
    throw new Error(`transaction ${sig} not confirmed after ${timeoutMs}ms`);
  }
}

/** A `TransactionInstruction` rebuilt from an SDK builder's returned meta. */
export function ixFromMeta(meta) {
  return new TransactionInstruction({
    programId: new PublicKey(meta.ixProgramId),
    keys: meta.ixKeys.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(meta.ixData, "base64"),
  });
}

/** Anchor error names by code, so a failure reports what the program said. */
export const PROGRAM_ERRORS = Object.fromEntries(
  (sdk.soothCoreIdl.errors ?? []).map((e) => [e.code, e.name]),
);

/**
 * The anchor error code a failed send carried, or `null`.
 *
 * Preflight rejections surface the code in simulation logs; a landed-then-
 * failed transaction surfaces it in `err.txErr.InstructionError`. Both shapes
 * are read because which one arrives depends on whether preflight ran.
 */
export function anchorErrorCode(err) {
  const custom = err?.txErr?.InstructionError?.[1]?.Custom;
  if (typeof custom === "number") return custom;
  const logs = err?.logs ?? err?.transactionLogs ?? [];
  const text = `${err?.transactionMessage ?? ""} ${err?.message ?? ""} ${logs.join(" ")}`;
  const hexMatch = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hexMatch) return Number.parseInt(hexMatch[1], 16);
  const decMatch = text.match(/Error Number: (\d+)/);
  if (decMatch) return Number.parseInt(decMatch[1], 10);
  return null;
}

/**
 * `ResolutionError` (`error_resolution.rs`), by code.
 *
 * A second `#[error_code(offset = 1000)]` enum that the generated IDL does not
 * carry, so `PROGRAM_ERRORS` above has no entry for any of it and a T\* voiding
 * failure would otherwise print as "1017 (unrecognised)" — which is exactly the
 * moment an operator most needs the name. Append-only, like the enum.
 */
export const RESOLUTION_ERRORS = Object.fromEntries(
  [
    "InvalidTStar",
    "EmptyCommitment",
    "ZeroMerkleRoot",
    "CommitmentAlreadyPublished",
    "VoidedClaimRequired",
    "UnexpectedVoidedClaim",
    "CommitmentMarketMismatch",
    "InvalidMerkleProof",
    "MerkleProofTooLong",
    "EntitlementExceedsPosition",
    "VoidRefundExceedsCost",
    "VoidRefundExceedsPublishedTotal",
    "CommitmentOwnerMismatch",
    "AbandonmentTimeoutNotElapsed",
    "EntitlementExceedsSeat",
    "BookVoidRefundExceedsVoidedValue",
    "BookVoidRefundExceedsPublishedTotal",
    "CommitmentExceedsVault",
  ].map((name, i) => [1000 + i, name]),
);

export function describeError(err) {
  const code = anchorErrorCode(err);
  if (code == null) return String(err?.message ?? err);
  return `${code} (${PROGRAM_ERRORS[code] ?? RESOLUTION_ERRORS[code] ?? "unrecognised"})`;
}

/** base58 -> bytes, the encoding web3.js hands inner-instruction data back in. */
export const bs58Decode = (s) => Buffer.from(anchorUtils.bytes.bs58.decode(s));

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
