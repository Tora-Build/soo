# `@sooth/sdk-solana` — Implementation Guide

> How the package is built, for people changing it. The surface it exposes and
> the guarantees it makes are in
> [`./integrator-contract.md`](./integrator-contract.md); when the two disagree,
> the contract wins.
>
> Source: `packages/sdk-solana/src/`.

---

## 1. Shape of the package

`@sooth/sdk-solana` is a standalone, ESM-only TypeScript package. It talks to
one Anchor program and depends on no umbrella SDK.

```
packages/sdk-solana/src/
├── index.ts        # the public surface — everything else is reachable only through it
├── adapter.ts      # SolanaChainAdapter: reads, instruction builders, submit, preflight
├── types.ts        # the chain-adapter type vocabulary + OUTCOME / WAD constants
├── errors.ts       # SoothError and its 22 kinds
├── pdas.ts         # PDA derivation, one helper per seed family
├── refs.ts         # `sol:<base58>` ref encode / decode
├── math/lmsr.ts    # WAD fixed-point LMSR, a port of the program's math/
├── book/           # index.ts (layout mirror + builders + decoder), events.ts
├── orderbook/      # error-classifier.ts
└── anchor/         # sooth_core.json — the single IDL — and its typed re-export
```

Four runtime dependencies: `@coral-xyz/anchor`, `@solana/web3.js`,
`@solana/spl-token`, `bn.js`. Node ≥ 20.

Two design choices shape everything below.

**The adapter never holds a key.** Its Anchor provider carries a stub wallet
whose `sign` throws. Signing happens in the caller's wallet, over bytes the
adapter hands it.

**Builders are pure and re-runnable.** A `build*` method returns instruction
*metadata*, not signed transaction bytes. `submit` and `preflight` reconstruct
the transaction from that metadata on every attempt, with a fresh blockhash.
That is what lets a caller re-quote and re-simulate without rebuilding state,
and it is why `SoothRequest.serializedTx` is always `undefined`.

---

## 2. `SolanaChainAdapter`

```ts
new SolanaChainAdapter({
  node,                 // SoothNode — cluster, rpcUrl, programs
  programIds?,          // explicit override
  bookMint?, ammMint?,  // explicit override
  connection?,          // supply your own; e.g. the LiteSVM shim in tests
});
```

Program-ID resolution walks `opts.programIds.soothCore` →
`node.programs.soothCore` → `soothCoreIdl.address`, so a caller who passes
nothing still gets the deployed devnet program. Mints resolve the same way
against `node.programs.usdcMint` (the **book** venue — the field name predates
the venue split) and `node.programs.ammMint`, falling back to the compiled-in
devnet constants.

The constructor injects the resolved address into the IDL before constructing
the Anchor `Program`, builds a read-only `AnchorProvider` at `confirmed`
commitment, and seeds two caches: a program-ID-scoped error table and a
per-market priority-fee cache.

### Method families

| Family | Methods |
| ------ | ------- |
| Reads (interface) | `readSnapshot`, `readSnapshots`, `readQuote`, `readPosition` |
| Reads (extra) | `readAmmState`, `readGraduationProgress`, `readLpRedemption`, `readAdjudicator`, `readPendingUnlocks`, `readVenueFeeBps`, `readBook`, `readMarketQuestion`, `readMarketTrades`, `readBookHistory`, `getMarketVaultUsdcRaw` |
| AMM builders | `buildTrade`, `buildSell`, `buildClaim`, `buildClaimRefund`, `buildDismissMarket`, `buildRedeemAmmPosition` |
| Book builders | `buildBookPlace`, `buildBookCancel`, `buildBookCancelMany`, `buildBookWithdraw`, `buildRedeemBookSeat` |
| Lifecycle builders | `buildCreateMarket`, `buildSeedLp`, `buildRequestLock`, `buildAttestOutcome`, `buildSettle`, `buildReclaimSubsidy`, `buildSweepResidual`, `buildCloseMarket` |
| Fees / LP builders | `buildDistributeFees`, `buildRedeemLp` |
| Submission | `submit`, `preflight` |

Most instructions come from Anchor's typed builder
(`program.methods.<ix>().accounts({…}).instruction()`). Two exceptions are
hand-rolled with literal discriminators: the book instructions (which target a
raw zero-copy account Anchor cannot type) and `init_market_fee_pool`.

Methods on the `ChainAdapter` interface that this deployment has no backing for
throw `SoothError({ kind: "NotImplemented" })` rather than returning empty
values: `readPortfolio`, `subscribeMarketEvents`, `subscribePositionEvents`,
`getCollateralBalance`, `buildApprove`. `buildTrade({ side: "sell" })` throws the
same way with a "use `buildSell()`" hint, mirroring the on-chain split of buy
and sell into separate instructions.

---

## 3. Request metadata

Every builder packs its instruction into `req.meta`:

```ts
type SoothRequestMeta = {
  ixProgramId: string;                 // base58
  ixData: string;                      // base64
  ixKeys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  userPk: string;                      // base58 — fee payer and first signer
  preIxs?: SerializedIx[];             // replayed verbatim on every attempt
  marketPda?: string;
  operation?: string;
  computeUnitLimit?: number;
};
```

It is deliberately JSON-serializable, so a request can cross a worker boundary
between build and submit.

`preIxs` carries the idempotent setup an instruction needs: ATA creates for the
user's venue-token and LP accounts, and a one-shot `init_market_fee_pool` added
only when the pool account is absent. They are replayed under each fresh
blockhash rather than folded into the main instruction, so a retry cannot land a
half-prepared transaction.

`SoothRequest.accounts` is populated even though the SDK builds legacy
transactions and uses no address lookup tables — it is there so a caller who
wants an ALT can build one.

---

## 4. Submission

`submit(req, signer, { maxAttempts? })` assembles, per attempt:

1. `setComputeUnitLimit({ units: meta.computeUnitLimit ?? 400_000 })`
2. `requestHeapFrame({ bytes: 262_144 })`
3. `setComputeUnitPrice({ microLamports })`
4. `meta.preIxs`
5. the main instruction

then sets `feePayer`, fetches a blockhash, serializes with
`{ verifySignatures: false, requireAllSignatures: false }`, and hands the raw
bytes to `signer.signTransaction`. It sends with `skipPreflight: false`.

**The heap frame is not optional.** `sooth_core` runs a custom 256 KB bump
allocator and the runtime maps that region only when the transaction requests
it; without the frame the first allocation aborts with "Access violation in heap
section". The adapter adds it on every path it builds — `buildTrade`, `submit`,
`preflight`, and `buildBookInitIxs` — and
`tests/heap-frame-contract.test.ts` asserts both directions: a transaction
without the frame faults, the same order with it succeeds. Any new build path
must add it too.

**Confirmation** polls `getSignatureStatus` once a second for up to 60 s and
bails when the block height passes `lastValidBlockHeight`. It deliberately does
not use `confirmTransaction`, which subscribes over a websocket: several RPC
providers serve HTTP reads fine and answer `-32601 Method not found` to
`signatureSubscribe`, and every write then hangs at "confirming".

**Retry** is bounded at `MAX_SUBMIT_ATTEMPTS = 5` with backoff
`[200, 400, 800, 1600, 3200] ms`. Only transient network failures retry;
a program error is always terminal, because replaying it just burns the user's
fee. The receipt reports `attempts`.

**Priority fees** come from `getRecentPrioritizationFees` scoped to the market
account, taken at the p50, cached 5 s per market, and capped at 50 000
microlamports. A monotonic 1..1000 salt keeps back-to-back identical
transactions from hashing to the same signature. Users pay their own priority
fees (decision D11).

`preflight(req)` mirrors the same assembly and calls `simulateTransaction`,
returning `{ ok: true, gasEstimate }` from `unitsConsumed` or a typed error with
the program logs attached. It exists so a UI can show cost and catch a revert
before the wallet popup.

---

## 5. Errors

`SoothError` carries a `kind` from a 22-member union and a `fields` bag; its
message renders per kind and appends the signature when there is one.

The submit-path classifier lives in `adapter.ts`, not `errors.ts`:

- `SOOTH_CORE_ERROR_TABLE` maps program codes 6000–6056 to `{ kind, msg }`.
- `extractFailingProgramId` scopes the lookup to the program that actually
  failed, so a foreign 6xxx code from the token program is not decoded as a
  Sooth error.
- `errorText` / `extractLogs` append the last six program log lines.
- `withHint` adds the human-readable cause for the two failures users hit most
  (no SOL for fees, insufficient token balance).

`orderbook/error-classifier.ts` is a separate, coarser classifier that buckets
errors as `validation | state | auth | protocol-internal | unknown` and marks
them retriable or not, for callers that want to decide about a retry without
switching on 57 codes.

Keeping the code table next to the builders is deliberate: when a new
instruction lands, its error codes are added in the same file, and the tests in
`error-classifier.test.ts` fail loudly if the table drifts from the program.

---

## 6. The book client

`book/index.ts` is a hand-written mirror of the program's zero-copy layout. It
does not go through Anchor, because the `Book` account is a raw bytemuck arena
with a custom discriminator (`"KooB\0\1\0\0"`).

Constants are duplicated from the Rust and must move together:

| | |
| --- | --- |
| `BLOCK_SIZE` | 64 |
| `BLOCKS_OFFSET` | 136 (8 discriminator + 128 header) |
| `MAX_ORDERS` | 4096 — a cap on **blocks**, shared by orders and seats |
| `NIL` | `0xffffffff` |
| `NUM_TICKS` | 1000; valid ticks `1..=999` |
| `SIDE_BID` / `SIDE_ASK` | 0 / 1 |
| `ONE_SHARE` | `1_000_000n` |
| `BOOK_INIT_HEAP_BYTES` | `256 * 1024` |
| `MAX_CANCELS_PER_TX` | 24 |

`bookLayoutSelfCheck()` runs at import and throws if the derived offsets stop
agreeing with each other — a cheap guard against editing one constant and not
the rest. `tests/book-constants.test.ts` pins them against the program.

`decodeBook` walks the arena into a `BookSnapshot { bids, asks, seats, … }` with
size, cycle, and overflow checks, so a corrupt or truncated account fails loudly
instead of yielding a plausible-looking book. `ladder` and `seatOf` are the
convenience views over it.

`buildBookCancelMany` sets `computeUnitLimit` to the 1 400 000 per-transaction
maximum, because each cancel scans the book, and caps the batch at
`MAX_CANCELS_PER_TX`.

`book/events.ts` decodes the `emit_cpi!` inner instructions the book emits.
Decoding is version-gated on `BOOK_EVENT_VERSION = 1` and rejects trailing
bytes, so a program-side layout change surfaces as a thrown error rather than
silently wrong fills.

### Changing the book layout

Any change to `OrderNode`, `SeatNode`, or `BookHeader` in the program is a
four-file change: the Rust struct, the constants in `book/index.ts`, the decoder
in the same file, and the event decoder if the payload moved. `book-constants`,
`book-client`, and `book-behaviour` tests are the ones that catch a partial
edit.

---

## 7. Math

`math/lmsr.ts` is a WAD (1e18) fixed-point port of the program's `math/lmsr.rs`
and `math/wad.rs`: `wadMul`, `wadDiv`, `expWad` (range-reduced by `ln 2`, twelve
Taylor terms, saturating below `−64·WAD` and throwing above `+64·WAD`), `lnWad`
(bit-length reduction plus a fourteen-term `atanh` series), `lmsrCost`
(shifted log-sum-exp), `costDelta`, `yesPriceWad`, and the two rounding helpers
`wadToUsdcCeil` / `wadToUsdcFloor`.

It exists so a caller can quote without a round trip, and it is exported for the
same reason. Its contract is that it agrees with the program bit for bit —
`tests/lmsr.test.ts` is a parity suite, not a spot check, and rounding direction
in particular must match (inflows ceil, outflows floor) or a quote will
disagree with the transaction it precedes.

---

## 8. PDAs

`pdas.ts` holds one helper per seed family, each asserting that `marketId` is
exactly 16 bytes. They are exported because tests and any future indexer derive
accounts without going through the adapter. The full seed table is in
[`./integrator-contract.md`](./integrator-contract.md).

One trap: `bookPda` — seeds `[b"book", market_id]`, exported from
`book/index.ts` — is the live book account. `marketBookPda`, `bookSidePda`, and
`orderbookPositionPda` in `pdas.ts` are from the per-tick book the program no
longer has, and are kept only for callers still reading old accounts.

---

## 9. Tests

Vitest 2 over LiteSVM 1.3.0: 39 test files plus four fixture modules, roughly
250 assertions. `vitest.config.ts` sets 60 s timeouts and `pool: "forks"` with
`singleFork: true`, because the fixtures share a validator.

```sh
anchor build                        # from the repo root — the tests load the .so
pnpm -F @sooth/sdk-solana test
```

`fixtures/svm.ts` boots LiteSVM, loads `target/deploy/sooth_core.so` (failing
fast with a "run `anchor build` first" message if it is absent), and presents a
`Connection`-shaped shim so Anchor and the adapter run unmodified against it. It
re-throws with `.logs` attached, which is what lets the error-classifier tests
exercise the real decode path rather than a mock.

Coverage clusters:

| Area | Files |
| ---- | ----- |
| Book | `book-client`, `book-behaviour`, `book-events`, `book-constants`, `book-cu-budget`, `book-init-heap`, `book-usdc-ata-preix` |
| Runtime contract | `heap-frame-contract`, `submit-failure`, `submit-priority-fee`, `preflight` |
| Errors | `error-classifier`, `orderbook-error-classifier` |
| Lifecycle | `create-market`, `market-question`, `graduation-gate`, `graduation-lp`, `read-graduation`, `adjudicator-flow`, `operator-request`, `market-close` |
| AMM | `smoke`, `sell`, `claim`, `claim-refund`, `lock`, `dismiss`, `amm-redeem`, `quote-direction`, `lmsr` |
| Venue / money | `venue-separation`, `venue-mint-defaults`, `distribute-fees`, `redeem-lp`, `solvency-invariant`, `protocol-pause` |

`tests/idl-freshness.test.ts` diffs the bundled `src/anchor/sooth_core.json`
instruction list against the freshly built `target/idl/sooth_core.json` and skips
itself when the built IDL is absent. Regenerate the bundled IDL whenever the
program's instruction surface changes.

---

## 10. Build

```sh
pnpm -F @sooth/sdk-solana build      # tsc → dist/
pnpm -F @sooth/sdk-solana typecheck
```

The package is ESM-only and its `exports` map has a single `"."` entry pointing
at `dist/`. Vitest hits `src/` directly, but any consumer — the demo, Pulse —
imports `dist/`. **After editing `src/`, build before reloading a frontend**, or
you will debug the previous version.

`files` ships `dist` plus `src/anchor/*.json`, since the IDL is a runtime asset.

---

## Related reading

- [`./integrator-contract.md`](./integrator-contract.md) — the public surface and its guarantees
- [`./orderbook-cancel-ux.md`](./orderbook-cancel-ux.md) — what cancel returns and when
- [`../../programs-core/docs/architecture.md`](../../programs-core/docs/architecture.md) — the program this package drives
- [`../../../docs/decision-log.md`](../../../docs/decision-log.md) — settled decisions
