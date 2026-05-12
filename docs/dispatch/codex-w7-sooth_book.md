# W7 dispatch — SDK adapter cancel-path rewrite + error classifier + multi-tx matching driver

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop ONLY after
> all acceptance gates pass AND all commits are made — do not stop
> with a dirty working tree. Print one-line per-gate summary. Do NOT
> push, tag, --no-verify, amend.

W7 is the TypeScript-heavy catchup wave. Until W7 lands, the SDK + demo are broken against the new program ABI (W2a's `TradePositions` accounts struct change, W2b's `SellPositions` change, W3's new orderbook PDA shapes, W6's mint/merge/redeem builders, and W4's matcher account bundle). W7 closes the gap.

**W7 has a hard dependency on W4** being on `main` (matcher complete + `set_return_data` accumulator wired) because the multi-tx matching driver needs to know the exact account-bundle shape the matcher consumes. Do NOT launch W7 before W4 merges.

Estimated runtime: 35–55 minutes — SDK + TS work spans a lot of files.

---

## Context (read first, in this order)

1. **`docs/spec/sooth_book.md`**:
   - §4.1 user-facing ix table — every row the SDK must build a transaction for
   - §6.1 `remaining_accounts` bundle layout — the 5-account-per-fill structure the SDK builds when constructing buy ix
   - §9.2 SDK rewrite scope — explicit deletion list at `adapter.ts:2641-2718` (cancel paths) and `pdas.ts:462-630` (already done in W6)
   - §11 W7 row — acceptance: every new error code has an asserted-against SDK test, messages reviewed by a non-engineer (skip the non-engineer review; we'll do that in code review), demo orderbook flows pass Surfpool smoke
   - §12 risks "match_limit=3 insufficient for realistic depth" — **the SDK's multi-tx retry orchestration is the user-facing solution**
2. **`packages/sdk-solana/src/adapter.ts:2641-2718`** — the Monaco-era cancel paths to rewrite. Read the surrounding context too (the file is 4271 lines; the cancel block is one section among many).
3. **`packages/sdk-solana/src/pdas.ts`** — W6 already rewrote this. Use the new helpers.
4. **`apps/demo/src/lib/chain-shim/`** — the wagmi-equivalent shim that bridges upstream demo's chain layer to `@sooth/sdk-solana`. Read the existing orderbook hooks (`useOrderbook.fetchOrderbook` is critical — there's a known load-bearing `useMemo` constraint in the chain-shim's `usePublicClient` that breaks spec 21 if removed).
5. **`packages/programs-core/programs/sooth_book/src/error.rs`** — the CoreError enum. Every variant in `{BookSideFull, MissingCrossingBookSide, MakerAccountMismatch, WrongBundleArity, AccumulatorNotReset, OrderIdSeedMismatch}` plus the AMM/market errors that surface during orderbook flows (`MarketNotGraduated`, `Slippage`, `MathOverflow`).
6. **`packages/sdk-solana/src/errors.ts`** — existing error-classifier module if it exists; if not, create one in this dispatch.

---

## Scope

### A. Adapter cancel-path rewrite (`adapter.ts:2641-2718`)

Replace the Monaco `Order` PDA reads with the new architecture:

- Old: SDK looked up an Anchor `Order` PDA at `[b"order", market_id, side, tick, index]` to find the order to cancel.
- New: SDK either uses `cancel(market, side, tick)` (linear scan from head finds first signer-owned order) OR `cancel_by_id(order_id, side, tick)` if the caller has the composite id.

`buildOrderbookCancel(market, side, tick, { byId?: bigint })` signatures:

- Without `byId`: uses the linear-scan `cancel` ix; SDK fills no remaining_accounts.
- With `byId`: uses `cancel_by_id`; SDK does `decode_order_id(byId)` client-side to recover `(side, tick, seq)` and asserts they match the args passed.

Both call paths CPI through `sooth_market::credit_shares_for_order` (escrow refund) or `withdraw_for_order` (USDC refund) per spec §8.3. The SDK doesn't need to compose these — it's program-internal.

Update any `cancel`-adjacent helpers in adapter.ts that referenced the deleted Monaco PDAs. Search for `Order`, `OrderStatus`, `marketOrderRequestQueue`, `marketMatchingPool` references in the adapter.

### B. Multi-tx matching driver

New module `packages/sdk-solana/src/orderbook/matching-driver.ts`:

```typescript
export interface MatchSimulation {
  taker: { side: 0 | 1; tick: number; amount: bigint; escrow: boolean };
  predictedFills: Array<{
    makerTick: number;
    makerOrderId: bigint;
    fillAmount: bigint;
  }>;
  remainingAmount: bigint; // 0 if fully matchable
  bundlesNeeded: number; // 1 bundle per maker fill
}

export async function simulateMatch(
  client: SoothSolanaClient,
  market: MarketRef,
  taker: { side; tick; amount; escrow },
): Promise<MatchSimulation>;

export async function buildOrderbookBuyMultiTx(
  client: SoothSolanaClient,
  market: MarketRef,
  taker: { side; tick; amount; escrow; matchLimitPerTx: number },
): Promise<Array<TransactionInstruction[]>>;
```

The driver:

1. Reads `MarketBook.bitmap_for` / `bitmap_against` for the opposite side.
2. Walks the bitmap downward from `NUM_TICKS - 1` (taker is buying — matches against opposite side ticks from highest downward).
3. For each crossing tick, reads `BookSide` and walks `head_index` forward to enumerate live orders.
4. Constructs the 5-account-per-fill bundles per spec §6.1.
5. Splits into multiple transactions when `bundlesNeeded > matchLimitPerTx` (default 3).
6. Each tx's `match_limit` arg is `matchLimitPerTx` (so the matcher exits cleanly after that many fills).
7. Returns a list of ix arrays — one per tx. Caller signs + sends in order; each tx waits for the previous to confirm.

**Critical correctness rule:** between txs, the matcher's bitmap state may shift (other takers may have filled or cancelled). The driver must re-read the bitmap before each subsequent tx and re-compute the bundles. Don't trust the simulation from tx 0 for tx 1+.

### C. Error classifier

`packages/sdk-solana/src/orderbook/error-classifier.ts`:

```typescript
export interface ClassifiedError {
  code: string; // canonical machine-readable
  message: string; // user-facing prose
  retriable: boolean; // SDK should retry vs surface to user
  category: "validation" | "state" | "auth" | "protocol-internal" | "unknown";
}

export function classifyError(
  err: SendTransactionError | AnchorError,
): ClassifiedError;
```

Map at minimum these codes (all from `sooth_book::CoreError` plus sister programs):

| Code                              | Category          | User message                                                                                    | Retriable |
| --------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- | --------- |
| `BookSideFull`                    | state             | "This price level is full (50 orders max). Try a different tick or wait for someone to cancel." | no        |
| `MissingCrossingBookSide`         | protocol-internal | "Stale state detected. Retrying with fresh order-book data..."                                  | yes       |
| `MakerAccountMismatch`            | protocol-internal | "Stale state detected. Retrying with fresh order-book data..."                                  | yes       |
| `WrongBundleArity`                | protocol-internal | "Internal SDK error. Please report this."                                                       | no        |
| `AccumulatorNotReset`             | protocol-internal | "Internal program invariant violated. Please report."                                           | no        |
| `OrderIdSeedMismatch`             | validation        | "The order ID you provided doesn't match the side/tick. Check your order ID."                   | no        |
| `MarketNotGraduated`              | state             | "This market hasn't graduated yet. Use the AMM to trade."                                       | no        |
| `Slippage`                        | validation        | "Price moved against you. Adjust your slippage tolerance or wait for stable prices."            | no        |
| `InvalidParentInstruction`        | auth              | "Internal: parent-ix gate rejected. Please report."                                             | no        |
| `WrongBaseMint` / `BaseMintDrift` | protocol-internal | "Mint mismatch detected. Please report."                                                        | no        |

Any uncatalogued error → `{ category: 'unknown', message: raw program log, retriable: false }`.

### D. Demo chain-shim verification

In `apps/demo/src/lib/chain-shim/`:

- Audit every hook (`useOrderbook`, `useMarket`, `usePortfolio`, etc.) for references to deleted Monaco PDA helpers.
- Replace with the new `pdas.ts` derivations (already shipped in W6).
- **Preserve the `usePublicClient` `useMemo` wrap** — per project memory, removing it causes `useOrderbook.fetchOrderbook`'s useCallback deps to thrash and `isLoading` stays true forever. The dispatch flags this explicitly.
- Wire the new `orderbook/matching-driver.ts` into the chain-shim's "buy" hook so the demo automatically does multi-tx for deep crosses.
- Smoke-test the demo against Surfpool: connect wallet → graduate AMM → place orderbook buy that requires a 4-fill cross → assert all 4 fills land across 2 txs.

### E. SDK tests

`packages/sdk-solana/test/orderbook-error-classifier.test.ts`:

- Each of the 10 codes in the table above gets an explicit `expect(classifyError(simulatedErr).code).toBe('BookSideFull')`-style assertion.
- One test per code; clear test names.

`packages/sdk-solana/test/matching-driver.test.ts`:

- **`simulate_match_walks_bitmap_in_correct_order`** — set up a mock client with a bitmap that has bits at ticks 100, 500, 800; taker buying with `tick=1000` (matches against any opp_tick ≥ 0); assert simulation walks 800 → 500 → 100 in order.
- **`simulate_match_respects_min_opp_tick_boundary`** — taker `tick=600` means `min_opp_tick = NUM_TICKS - 600 = 400`; bitmap has bits at 200, 500, 800; simulation should walk 800 → 500 and STOP at the 400 boundary (200 is out of crossing range).
- **`build_multi_tx_splits_at_match_limit_per_tx`** — 7 maker fills, `matchLimitPerTx=3` → returns 3 tx arrays (3 + 3 + 1 fills).
- **`build_multi_tx_zero_fills_for_no_cross_order`** — bitmap empty; simulation returns 0 bundles, 0 txs from driver; SDK falls back to single resting-order tx.
- **`build_multi_tx_re_reads_bitmap_between_txs`** — mock the client to mutate the bitmap between simulations; assert second tx's bundles reflect the new state, not the stale tx-0 simulation.

### F. Existing test fixture updates

The existing 19 orderbook e2e specs in `apps/demo/e2e/` reference Monaco-era SDK builders. Update them to use the new architecture. This is the bulk of the test diff.

Don't add new e2e specs in W7 — that's W8's job. Just fix the existing 19 to compile and pass against the new SDK.

---

## Acceptance gates

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet

cd packages/sdk-solana && NO_DNA=1 pnpm typecheck
cd packages/sdk-solana && NO_DNA=1 pnpm test orderbook-error-classifier
cd packages/sdk-solana && NO_DNA=1 pnpm test matching-driver
cd packages/sdk-solana && NO_DNA=1 pnpm test

cd apps/demo && NO_DNA=1 pnpm typecheck

# Demo smoke (Surfpool boot + 4-fill cross)
cd apps/demo && NO_DNA=1 pnpm e2e -- --grep "orderbook"
```

The demo e2e smoke is the load-bearing gate — if the 19 existing specs don't pass, the SDK rewrite is incomplete.

---

## Out of scope

- New e2e specs (escrow, dust, per-market fee distribution, per-tick cap) — W8.
- CU + writable-account measurement — W8.
- Devnet redeploy — W9.

---

## Operational rules

- Branch: `feat/sooth_book-w7-sdk-catchup` off current `main`.
- Suggested commit split:
  1. `feat(sdk-solana): error classifier for orderbook ix codes`
  2. `feat(sdk-solana): matching-driver — bitmap simulation + multi-tx orchestration`
  3. `feat(sdk-solana): rewrite adapter.ts cancel paths for composite order_id`
  4. `feat(sdk-solana): replace remaining Monaco-era builder references in adapter.ts`
  5. `test(sdk-solana): error classifier + matching driver vitest suites`
  6. `chore(demo): update chain-shim for new SDK PDA surface (preserve usePublicClient useMemo)`
  7. `chore(demo): update 19 existing orderbook e2e specs for new SDK builders`
- **Do NOT push, tag, amend, use `--no-verify`.** `NO_DNA=1` prefix.
- **Stop and ask** if:
  - The `usePublicClient` `useMemo` constraint conflicts with something else in the chain-shim (it's load-bearing per memory — don't touch its memoization).
  - The error-classifier's user-facing messages need a different tone than the table above (these are first drafts).
  - The matching driver's bitmap simulation diverges from the on-chain matcher's behavior (correctness invariant: simulation predicts the actual fills; mismatch = SDK bug).

## When done

Print one-line per-gate pass/fail summary. **Commit the work** — don't leave the working tree dirty. Stop.
