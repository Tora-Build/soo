# `@sooth/sdk-solana` — Integrator Contract

> The public surface of the package and what you can rely on from it.
> Audience: anyone building on Sooth's Solana deployment — frontends, bots,
> aggregators, portfolio trackers.
>
> Status: shipped. The surface below is what `src/index.ts` exports today; the
> in-repo frontend (`apps/demo`) is built on it.

---

## 1. What you get

One package, one program, one import path:

```ts
import { SolanaChainAdapter, encodePubkeyRef, OUTCOME } from "@sooth/sdk-solana";
```

`@sooth/sdk-solana` is ESM-only and speaks to a single Anchor program,
`sooth_core`. It gives you:

- **Reads** — market, AMM state, position, quotes, the order book, graduation
  progress, adjudicator state, and recent trade/fill history, straight from
  accounts and transaction data. No indexer is required or assumed.
- **Instruction builders** — one `build*` method per protocol action, each
  returning a serializable request you submit whenever you like.
- **Submission** — `submit` and `preflight`, which handle the compute budget,
  the heap frame, priority fees, blockhash refresh, confirmation, and bounded
  retry.
- **Math** — the same WAD fixed-point LMSR the program runs, so you can quote
  without a round trip.
- **Errors** — one `SoothError` type with a `kind` you can switch on.

What it does **not** do: hold keys, subscribe to live events, or aggregate a
cross-market portfolio. Those are named explicitly in §8.

---

## 2. Constructing the adapter

```ts
const adapter = new SolanaChainAdapter({
  node: {
    id: "solana-devnet",
    chainKind: "solana",
    chainId: "solana:devnet",
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    programs: {
      soothCore: "EwiENXxrU3PEdmzCttJp9viCR6JZaFnFs3aW9n9a3EWw",
      usdcMint: "ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX", // book venue
      ammMint: "CUsiEVc29hQa9xLBFB7nPQxP1aEiWq1cZkdfn8ATFHBu",  // AMM venue
    },
  },
});
```

`SolanaAdapterOptions` also accepts `programIds`, `bookMint`, `ammMint`, and a
prebuilt `connection`. Everything is optional but `node`: omit the program and
mint fields and you get the compiled-in devnet defaults.

Two things to know about `node.programs`:

- `usdcMint` names the **book** venue's token. The field name predates the
  two-token split; it is kept because node descriptors in the wild already set
  it.
- `soothAmm`, `soothMarket`, and `soothBook` still typecheck and are ignored.
  There is one program now.

`chainKind` is `"solana"`. `MarketRef`, `AddressRef`, and `TxId` are all strings
of the form `sol:<base58>` — use `encodePubkeyRef` / `decodePubkeyRef` /
`encodeSignatureRef` rather than concatenating by hand.

---

## 3. Reads

| Method | Returns |
| ------ | ------- |
| `readSnapshot(market, user?)` | `SoothCoreSnapshot { market: MarketInfo, position? }` |
| `readSnapshots(markets[], user?)` | `SoothCoreSnapshot[]` |
| `readQuote(market, outcome, deltaShares)` | `TradeQuote` — off-chain LMSR, no round trip to the program |
| `readPosition(market, user)` | `Position` |
| `readAmmState(market, user?)` | raw LMSR cursor: `qYes`, `qNo`, `b`, fee accumulator, flags |
| `readGraduationProgress(market)` | `{ feesAccumulatedWad, thresholdWad, isGraduated, progressBps }` |
| `readVenueFeeBps()` | `{ amm, book }` — the two venue fee rates from `ProtocolConfig` |
| `readBook(market)` | `BookSnapshot` — both ladders plus every seat |
| `readAdjudicator(market)` | authority, dispute authority, attested outcome, disputed flag |
| `readPendingUnlocks(market, user)` | matured and pending `LockEntry` records |
| `readLpRedemption(market, user)` | LP balance and its pro-rata claim |
| `readMarketQuestion(market)` | the question text, recovered from `MarketCreated` |
| `readMarketTrades(market, …)` | recent AMM trades from transaction history |
| `readBookHistory(market, …)` | recent book fills and cancels |
| `getMarketVaultUsdcRaw(market)` | the book vault balance in base units |

### Key shapes

```ts
interface MarketInfo {
  market: MarketRef; question: string; deadline: bigint;
  isLive: boolean; isSettled: boolean; outcome?: 0 | 1 | 2;
  qYes: bigint; qNo: bigint; b: bigint; isGraduated: boolean;
}

interface Position {
  yesShares: bigint; noShares: bigint;          // WAD
  lockedCostUsdc?: bigint;
  lockedYes?: bigint; lockedNo?: bigint; unlockableAt?: bigint;
}

interface TradeQuote {
  cost: bigint;         // WAD, signed — negative on a sell
  fee: bigint;          // WAD, non-negative
  netCost: bigint;      // cost + fee
  newYesPrice: bigint;  // WAD probability after the trade
  priceImpact: bigint;  // WAD delta
}

interface BookSnapshot {
  market: string; nextSeq: bigint;
  orderCount: number; blockCount: number; capacity: number;
  bids: BookOrder[];   // best first: highest price, then earliest
  asks: BookOrder[];   // best first: lowest price, then earliest
  seats: BookSeat[];
}
```

`readMarketQuestion` walks transaction history because the program stores only
`sha256(question)` on the `Market` account and re-emits the text in
`MarketCreated`. That is what makes titles render with no indexer.

---

## 4. Builders

Every builder returns a `SoothRequest`. Builders are pure — they perform the
reads they need and then do no network work, so a request can be built once,
inspected, serialized across a worker boundary, and submitted later.

### AMM

| Method | Args |
| ------ | ---- |
| `buildTrade(market, args)` | `TradeArgs { outcome: 0\|1, deltaShares, maxCostWad, side: "buy" }` |
| `buildSell(market, args)` | `{ outcome: 0\|1, deltaShares, minProceedsWad?, user }` |
| `buildClaim(market, args)` | `ClaimArgs { outcome } & { user, lockEntry? }` |
| `buildClaimRefund(market, { user })` | refund from a dismissed market |
| `buildDismissMarket(market, { user })` | creator-only, after the trial window |
| `buildRedeemAmmPosition(market, { user })` | post-settlement payout |

`buildTrade` is buy-only; passing `side: "sell"` throws with a "use
`buildSell()`" hint. That mirrors the program, where buy and sell are separate
instructions so a buyer never pays rent for a sell-cooldown escrow account.

### Order book

| Method | Args |
| ------ | ---- |
| `buildBookPlace(market, args)` | `PlaceArgs { side, limitTick, amount, matchLimit, postRemainder } & { user }` |
| `buildBookCancel(market, { user, orderSeq })` | cancel one resting order |
| `buildBookCancelMany(market, { user, orderSeqs })` | up to `MAX_CANCELS_PER_TX` (24) |
| `buildBookWithdraw(market, { user })` | move seat credit to a token account |
| `buildRedeemBookSeat(market, { user })` | post-settlement seat payout |

`side` is `SIDE_BID` (0, buy YES) or `SIDE_ASK` (1, sell YES / buy NO).
`limitTick` is `1..999` on a single YES price axis — a NO order at price `p` is
a YES order at `1 − p`. `amount` is in book-token base units, where
`ONE_SHARE = 1_000_000n`. `matchLimit` bounds compute, not correctness.

Matching happens on chain. You do not read the book, predict a crossing
sequence, and pass maker bundles in; there is nothing to go stale between your
read and your submit.

### Lifecycle, fees, LP

| Method | Args |
| ------ | ---- |
| `buildCreateMarket(args)` | `CreateMarketArgs` — see below |
| `buildSeedLp(market, { creator })` | posts the `b·ln(2)` LMSR subsidy |
| `buildRedeemLp(market, { user, lpAmount })` | burn LP for pro-rata yield |
| `buildDistributeFees(market, { venue, cranker })` | `venue: "amm" \| "book"` |
| `buildRequestLock(market, { user })` | move `Open → Locked` |
| `buildAttestOutcome(market, { user, winningOutcome })` | `0 \| 1 \| 2` |
| `buildSettle(market, { user })` | permissionless, after the veto window |
| `buildReclaimSubsidy(market, { creator })` | repeatedly callable |
| `buildSweepResidual(market, { cranker })` | dust to treasury |
| `buildCloseMarket(market, { creator })` | reclaim rent, leave a tombstone |

```ts
interface CreateMarketArgs {
  question: string;
  deadline: bigint;
  user: string;             // creator + fee payer; required in practice
  marketId?: Uint8Array;    // 16 bytes; default sha256(question).slice(0, 16)
  questionHash?: Uint8Array;// 32 bytes; default sha256(question)
  startTime?: bigint;       // default: current chain time
  adjudicator?: string;     // default: the creator
  initialB?: bigint;        // WAD; default 1000 * 1e18
}
```

`marketIdForQuestion(question)` is exported so you can derive the default id —
and therefore every per-market PDA — before the market exists.

Creating a market is not free: `seed_lp` requires the creator to post at least
`b·ln(2)` as the LMSR subsidy, which is roughly 693 units at `b = 1000`.

---

## 5. Submission

```ts
const req = await adapter.buildBookPlace(market, {
  side: SIDE_BID, limitTick: 620, amount: 50n * ONE_SHARE,
  matchLimit: 64, postRemainder: true,
  user: encodePubkeyRef(wallet.publicKey),
});

const sim = await adapter.preflight(req);
if (!sim.ok) throw sim.error;

const receipt = await adapter.submit(req, {
  publicKey: wallet.publicKey.toBase58(),
  signTransaction: async (bytes) => {
    const tx = Transaction.from(bytes);
    const signed = await wallet.signTransaction(tx);
    return signed.serialize();
  },
});
```

**The adapter never holds a key.** You pass a `SolanaSigner` — `publicKey` plus
`signTransaction` (or `signAllTransactions`) over raw bytes.

`submit(req, signer, options?)` resolves on confirmation, or throws a
`SoothError` after retries are exhausted. It returns:

```ts
interface SubmitReceipt {
  txId: TxId;            // "sol:<signature>"
  confirmedAt: bigint;   // Unix ms
  fills: Fill[];
  attempts?: number;     // 1..5
}
```

Guarantees:

- **The compute budget and heap frame are handled for you.** Every path the
  adapter builds prepends `setComputeUnitLimit`, `requestHeapFrame(256 KB)`, and
  `setComputeUnitPrice`. The program runs a custom 256 KB allocator and aborts
  without the frame — if you hand-roll a transaction against `sooth_core`, you
  must add it yourself.
- **Retry is bounded and never doubles a trade.** Up to five attempts with
  exponential backoff, and only for transient network failures. A program error
  is terminal; a rejected trade is not retried into a filled one.
- **Priority fees are estimated, capped, and paid by the user.** The p50 of
  recent fees on the market account, cached briefly, capped at 50 000
  microlamports (decision D11).
- **Confirmation is HTTP-only.** Deliberately polled rather than subscribed:
  several providers serve reads but answer `-32601` to `signatureSubscribe`, and
  a subscription-based confirm hangs forever against them.

`preflight(req)` mirrors the same assembly and simulates, returning
`{ ok: true, gasEstimate }` from `unitsConsumed` or a typed error with program
logs attached. Run it before the wallet popup if you want to show cost or catch
a revert early.

---

## 6. Errors

Everything the SDK throws is a `SoothError` with a `kind` you can switch on:

```
InsufficientShares · OrderNotActive · MarketNotActive · InvalidTick ·
SlippageExceeded · InsufficientApproval · BookMoved · ProgramError ·
NetworkError · NotImplemented · AccountNotFound · TradingNotStarted ·
TradingClosed · SellNotImplemented · LockNotElapsed · LockVaultMismatch ·
TrialNotExpired · AlreadyGraduated · AlreadyDismissed · MarketNotDismissed ·
NotGraduated
```

Anchor errors and raw RPC failures do not escape. The classifier scopes program
codes to the program that actually failed, so a foreign `6xxx` from the token
program is not mistaken for a Sooth error, and it appends the last few program
log lines to the message. Two common causes — no SOL for fees, insufficient
token balance — get a plain-language hint.

`classifyOrderbookError` is a coarser second classifier that buckets an error as
`validation | state | auth | protocol-internal | unknown` and marks it retriable
or not, for callers deciding about a retry without switching on every code.

`NotGraduated` is the one worth handling explicitly: the book is closed until
the market graduates, and the program enforces it.

---

## 7. Constants, math, and PDAs

```ts
import {
  OUTCOME, WAD, WAD_TO_USDC_SCALAR, LN2_WAD,
  NUM_TICKS, SIDE_BID, SIDE_ASK, ONE_SHARE, MAX_ORDERS,
  MAX_CANCELS_PER_TX, BOOK_INIT_HEAP_BYTES,
} from "@sooth/sdk-solana";
```

| Symbol | Value |
| ------ | ----- |
| `OUTCOME` | `{ NO: 0, YES: 1, INVALID: 2 }` |
| `WAD` | `10n ** 18n` |
| `WAD_TO_USDC_SCALAR` | `10n ** 12n` — both venue mints are 6-decimal |
| `LN2_WAD` | `693147180559945309n` |
| `NUM_TICKS` | `1000`; valid ticks `1..999` |
| `ONE_SHARE` | `1_000_000n` book-token base units |
| `MAX_ORDERS` | `4096` — a cap on **blocks**, shared by resting orders and seats |
| `MAX_CANCELS_PER_TX` | `24` |

**Math.** `costDelta`, `lmsrCost`, `yesPriceWad`, `expWad`, `lnWad`, `wadMul`,
`wadDiv`, `wadToUsdcCeil`, `wadToUsdcFloor` are exported and match the program
bit for bit — including the rounding asymmetry, where inflows ceil and outflows
floor. Use them to quote locally; a quote computed any other way will disagree
with the transaction it precedes.

**PDAs.** One helper per seed family, all exported:
`deriveMarketPda`, `deriveAmmStatePda`, `derivePositionPda`,
`deriveVaultAuthorityPda`, `deriveLockAuthorityPda`, `deriveLockEntryPda`,
`deriveAdjudicatorEntryPda`, `deriveLpYieldAuthority`, `deriveMarketVaultAta`,
`deriveLockVaultAta`, `deriveUserUsdcAta`, `feePoolAmmPda`, `feePoolBookPda`,
plus `bookPda` for the book account itself.

`bookPda` — seeds `["book", market_id]` — is the live book. `marketBookPda`,
`bookSidePda`, and `orderbookPositionPda` are left over from the per-tick book
the program no longer has; do not derive against them for new work.

**Book client.** `decodeBook`, `ladder`, `seatOf`, `bookSpace`, and the raw
instruction builders (`buildBookInit`, `buildBookInitIxs`, `buildBookGrow`,
`buildBookPlace`, `buildBookCancel`, `buildBookWithdraw`) are exported for
callers who want to work below the adapter.

**Events.** `decodeBookEvent` and `decodeBookEventsFromInner` parse the book's
`emit_cpi!` inner instructions into `BookOrderPlacedEvent`, `BookFilledEvent`,
and `BookOrderCancelledEvent`. Decoding is version-gated on
`BOOK_EVENT_VERSION` and rejects trailing bytes, so a layout change fails loudly
rather than yielding wrong fills.

**IDL.** `soothCoreIdl` is exported so you can build your own Anchor `Program`
for read paths the adapter does not expose.

---

## 8. Not implemented

These throw `SoothError({ kind: "NotImplemented" })` rather than returning empty
values, so you find out at the call site:

| Method | Why |
| ------ | ---- |
| `readPortfolio` | needs cross-market enumeration; there is no Solana indexer. Build it from `readSnapshots` + `readPosition` + `readPendingUnlocks`. |
| `subscribeMarketEvents`, `subscribePositionEvents` | no live event stream. Poll, or decode `emit_cpi!` inner instructions from transaction history. |
| `getCollateralBalance`, `buildApprove` | SPL has no allowance step in these flows; read the token account directly. |
| `buildTrade({ side: "sell" })` | deliberate — use `buildSell`. |

Also absent, because the protocol does not have them: complete-set mint/merge,
outcome-token mints, three-outcome markets, off-chain signed orders, and zkTLS
adjudication.

---

## 9. Versioning

The package is `private` and versioned with the repo rather than published to a
registry; both in-repo frontends consume it through the pnpm workspace. Treat
the surface as stable-but-not-frozen: it moves with the program, and the program
and the SDK change in the same commit.

Two mechanical guards exist for anyone extending it:
`tests/idl-freshness.test.ts` fails when the bundled IDL drifts from the built
one, and `bookLayoutSelfCheck()` runs at import and throws if the book layout
constants stop agreeing.

---

## Related reading

- [`./implementation-guide.md`](./implementation-guide.md) — how the package is built, for contributors
- [`./orderbook-cancel-ux.md`](./orderbook-cancel-ux.md) — what cancel returns and when
- [`../../programs-core/docs/architecture.md`](../../programs-core/docs/architecture.md) — the program underneath
- [`../../../docs/decision-log.md`](../../../docs/decision-log.md) — settled decisions and open questions
- [`../../../docs/glossary.md`](../../../docs/glossary.md) — WAD, OUTCOME, tick, CU, PDA, ATA
