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
const { AnchorProvider, Program } = anchor;

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

export function describeError(err) {
  const code = anchorErrorCode(err);
  if (code == null) return String(err?.message ?? err);
  return `${code} (${PROGRAM_ERRORS[code] ?? "unrecognised"})`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
