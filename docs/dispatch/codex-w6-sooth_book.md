# W6 dispatch — orderbook position lifecycle + SDK PDA helpers

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop after the
> acceptance gates pass; Claude reviews + pushes; do not push to
> origin from inside Codex.

W6 is mixed-language: 3 new Rust ix on `sooth_market` + substantial TypeScript work in `packages/sdk-solana` and `apps/demo`. The Rust side is small (lifecycle ix that mirror existing mint/merge/redeem against `OrderbookPosition` instead of `Position`); the TS side is the bigger lift — replacing the Monaco-era PDA helpers with the new `MarketBook` / `BookSide` / `OrderbookPosition` / `MarketFeePool` derivations.

Estimated runtime: 30–45 minutes. The TS work can fail in many small ways — leave room for fixture iteration.

---

## Context (read first, in this order)

1. **`docs/spec/sooth_book.md`**:
   - §3.4 (`OrderbookPosition` PDA — shipped W2a)
   - §3.5 (`MarketFeePool` — shipped W2a)
   - §4.1 user-facing ix table — focus on the three sooth_market rows: `mint_complete_set_for_orderbook` / `merge_complete_set_for_orderbook` / `redeem_orderbook`
   - §9.2 SDK rewrite scope — **`packages/sdk-solana/src/pdas.ts:462-630` is the deletion + replacement target**. Also `adapter.ts:2641-2718` cancel-path note — but that's W7, not W6
   - §9.3 sooth_market additions — the three new user-facing ix lifecycle
   - §10.3 cost model — `OrderbookPosition` rent refundable on `redeem_orderbook` post-settle close
   - §11 row W6 — acceptance
2. **Existing sooth_market mint/merge/redeem on the AMM `Position`** (NOT `OrderbookPosition`):
   - `packages/programs-core/programs/sooth_market/src/instructions/mint_complete_set.rs`
   - `packages/programs-core/programs/sooth_market/src/instructions/merge_complete_set.rs`
   - `packages/programs-core/programs/sooth_market/src/instructions/redeem.rs`
   - These are the structural templates. The W6 versions target `OrderbookPosition` (shipped W2a) and the lifecycle is parallel but independent of the AMM `Position`.
3. **EVM source mirrored**:
   - `/Users/danieltang/GitHub/sooth-alpha/packages/contracts-core/src/OrderEngine.sol:_mint` (line ≈ 680)
   - `_merge` (≈ 696), `settlePosition` (≈ 399)
   - The Solana version preserves the `INVALID` half-payout rule per §7 of `sooth_market.md` spec.
4. **`packages/sdk-solana/src/pdas.ts`** — read the whole file. Lines 462–630 carry the Monaco-era helpers that get deleted (`MarketLiquidities`, `MarketMatchingPool`, `MarketOrderRequestQueue`, `priceLadderPda`, `marketOutcomePda`). Replace with the new derivations.
5. **`apps/demo/e2e/helpers/sdk-helpers.ts:1028-1073`** — the demo seed helper paths that map to the same Monaco PDAs. Delete + rely on lazy-init.

---

## Scope

### A. `sooth_market` — three new user-facing ix

#### A.1 `mint_complete_set_for_orderbook(market, amount: u64)`

File: `programs/sooth_market/src/instructions/mint_complete_set_for_orderbook.rs`.

- Pulls `amount` USDC from user → market vault.
- Credits `amount` YES + `amount` NO on `OrderbookPosition` (NOT on `Position`).
- Gated on `lifecycle == Open` and deadline-before-now.
- `OrderbookPosition` `init_if_needed` (first-touch path) with payer = user.
- NOT a filler-only ix — direct user call, no parent-ix gate.

Structural twin of the existing `mint_complete_set` but writes to `OrderbookPosition` instead of `Position`. Same USDC pull pattern, same vault destination.

Per §3.1 ownership rule: `OrderbookPosition` is owned by `sooth_market`, so writing to it here is correct.

#### A.2 `merge_complete_set_for_orderbook(market, amount: u64)`

File: `programs/sooth_market/src/instructions/merge_complete_set_for_orderbook.rs`.

- Burns `amount` YES + `amount` NO from `OrderbookPosition`.
- Transfers `amount` USDC from market vault → user (signed by `vault_authority`).
- Gated on `lifecycle == Open`.
- Requires `yes_shares >= amount && no_shares >= amount`.

Structural twin of `merge_complete_set` for the orderbook position.

#### A.3 `redeem_orderbook(market)`

File: `programs/sooth_market/src/instructions/redeem_orderbook.rs`.

- Gated on `lifecycle == Settled`.
- Branches on `market.winning_outcome`:
  - YES (1): payout = `yes_shares` USDC, signed transfer from vault.
  - NO (0): payout = `no_shares` USDC.
  - INVALID (2): payout = `(yes_shares + no_shares) / 2` (floor, per spec §7 of sooth_market.md).
- Zero-out the `OrderbookPosition` shares after payout.
- **Close the `OrderbookPosition` PDA** when both `yes_shares == 0 && no_shares == 0`, rent refunded to user. Use Anchor `close = user` constraint on the post-settle path.

This mirrors `redeem.rs` but on `OrderbookPosition` and closes the PDA. The AMM `redeem.rs` does NOT close `Position` (locked_cost_usdc invariant) — the orderbook version DOES because `OrderbookPosition` has no locked-cost invariant.

#### A.4 `sooth-protocol-types` discriminators

Add three constants via `sha256("global:<ix>")[..8]`:

- `MINT_COMPLETE_SET_FOR_ORDERBOOK_DISCRIMINATOR`
- `MERGE_COMPLETE_SET_FOR_ORDERBOOK_DISCRIMINATOR`
- `REDEEM_ORDERBOOK_DISCRIMINATOR`

#### A.5 Rust tests

`programs/sooth_market/tests/orderbook_lifecycle.rs`:

1. **`mint_credits_both_sides`** — user mints 100 USDC worth, assert OrderbookPosition.yes_shares == no_shares == 100 \* WAD-conversion, vault credited.
2. **`merge_burns_both_sides`** — after mint, user merges 50 → OrderbookPosition.yes_shares == no_shares == 50 WAD remaining, vault debited.
3. **`merge_rejects_insufficient_shares`** — try to merge more than position holds → InsufficientShares (add error if needed).
4. **`redeem_yes_winner`** — settle market with winning_outcome=YES, redeem an OrderbookPosition holding (yes=100, no=50) → user receives 100 USDC, position closed.
5. **`redeem_no_winner`** — same shape, winning=NO → user receives 50 USDC.
6. **`redeem_invalid`** — winning=INVALID, position (yes=100, no=50) → user receives (100+50)/2 = 75 USDC.
7. **`redeem_post_settle_only`** — try redeem with lifecycle=Open → reject.
8. **`mint_post_settle_rejects`** — try mint with lifecycle=Settled → reject.

### B. SDK — `pdas.ts` rewrite (lines 462–630)

In `packages/sdk-solana/src/pdas.ts`:

**Delete** these helpers (Monaco-era):

- `marketLiquiditiesPda` / `marketLiquiditiesAddress`
- `marketMatchingPoolPda` (`MarketMatchingPool` per-(outcome × price × side))
- `marketOrderRequestQueuePda`
- `priceLadderPda`
- `marketOutcomePda`
- Any sister helpers in this line range (read the file end-to-end before deleting).

**Add** these helpers (new architecture):

```typescript
// MarketBook: one PDA per orderbook-enabled market, owned by sooth_book.
export function marketBookPda(marketId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_book"), Buffer.from(marketId)],
    SOOTH_BOOK_PROGRAM_ID,
  );
}

// BookSide: one PDA per populated (market, side, tick), owned by sooth_book.
// side: 0 = AGAINST, 1 = FOR.
export function bookSidePda(
  marketId: Uint8Array,
  side: 0 | 1,
  tick: number,
): [PublicKey, number] {
  const tickBuf = Buffer.alloc(2);
  tickBuf.writeUInt16LE(tick, 0);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("book_side"),
      Buffer.from(marketId),
      Buffer.from([side]),
      tickBuf,
    ],
    SOOTH_BOOK_PROGRAM_ID,
  );
}

// OrderbookPosition: one PDA per (market, user), owned by sooth_market.
export function orderbookPositionPda(
  marketId: Uint8Array,
  user: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook_position"), Buffer.from(marketId), user.toBuffer()],
    SOOTH_MARKET_PROGRAM_ID,
  );
}

// MarketFeePool: one TokenAccount per market, owned by sooth_launchpad.
export function marketFeePoolPda(marketId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market_fee_pool"), Buffer.from(marketId)],
    SOOTH_LAUNCHPAD_PROGRAM_ID,
  );
}
```

Tick + side encoding **must match Rust seed bytes exactly**. The `book_side` seed uses `&[side]` (single byte) + `tick.to_le_bytes()` (two bytes LE). Verify by deriving one address on both sides and comparing — add a vitest case for this.

Update any `pdas.ts` consumers (search for the deleted helper names across `packages/sdk-solana/src/*.ts`). Anywhere `marketLiquiditiesPda` etc. was called, replace with the appropriate new helper.

**Adapter changes are out of scope (W7).** Don't touch `adapter.ts:2641-2718` cancel path; don't touch `buildOrderbookBuy/Sell/Cancel` function bodies. The SDK signatures stay the same — only PDA derivation internals change.

### C. SDK vitest

`packages/sdk-solana/test/pdas.test.ts` (or extend existing):

1. **`market_book_pda_derives_correctly`** — derive with a known marketId, compare against a Rust-derived expected value (committed as a fixture, copied from `cargo test -p sooth_market` output once).
2. **`book_side_pda_tick_endianness`** — derive `bookSidePda(marketId, 1, 500)` and compare against the Rust derivation. If the byte order is wrong, this fails.
3. **`orderbook_position_pda_derives_correctly`** — same shape.
4. **`market_fee_pool_pda_derives_correctly`** — same shape.

The Rust-derived fixtures: write a small `#[test]` in `programs/sooth_book/src/state/book_side.rs` (or similar) that prints the derived PDAs for a fixed marketId, side, tick. Copy the printed pubkey into the TS test as a hardcoded expectation. Commit both sides.

### D. Demo — `sdk-helpers.ts` cleanup (lines 1028–1073)

In `apps/demo/e2e/helpers/sdk-helpers.ts`:

- Delete the Monaco-shape seed-path helpers in the 1028–1073 range. Any references to `priceLadder`, `marketLiquidities`, `marketOutcome`, `marketMatchingPool` in the demo's e2e helpers go away.
- The demo's `/portfolio` mint/merge buttons must call the new `mint_complete_set_for_orderbook` / `merge_complete_set_for_orderbook` ix. **W6 only wires the helpers — full SDK adapter wiring (the `buildOrderbookMint` builder etc.) is part of this dispatch.** Add `buildOrderbookMint(market, user, amount)` and `buildOrderbookMerge(market, user, amount)` to `adapter.ts` (NOT in the 2641–2718 cancel range — those are W7).

The buy/sell builders are out of scope for W6 — they need the matcher (W4) to be fully wired before they can construct the right `remaining_accounts` bundles.

### E. Demo update

In `apps/demo/src/.../portfolio` (path TBD by reading the existing portfolio component), replace any Monaco-era PDA references with the new SDK builders. Smoke test on Surfpool.

If the existing `/portfolio` UI does not yet expose mint/merge for the orderbook, defer the UI surface to W7 and only wire the SDK + e2e fixture in W6.

---

## Acceptance gates

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test -p sooth_market orderbook_lifecycle
NO_DNA=1 cargo test -p sooth_market
NO_DNA=1 anchor build

cd packages/sdk-solana && NO_DNA=1 pnpm test pdas
cd packages/sdk-solana && NO_DNA=1 pnpm typecheck
cd apps/demo && NO_DNA=1 pnpm typecheck
```

Round-trip test on Surfpool (mint → merge → redeem) is a stretch goal — if the demo's existing e2e harness supports orderbook flows, run it. Otherwise defer end-to-end Surfpool to W8 and document.

---

## Out of scope

- `adapter.ts:2641-2718` cancel-path rewrite → W7.
- Error classifier mapping → W7.
- `buildOrderbookBuy/Sell/Cancel` builders → W7 (depends on W4 matcher wiring).
- E2E full Surfpool sweep → W8.
- Devnet redeploy.

---

## Operational rules

- Branch: `feat/sooth_book-w6-orderbook-lifecycle` off current `main`.
- Suggested commit split:
  1. `feat(sooth-protocol-types): add orderbook lifecycle discriminators`
  2. `feat(sooth_market): mint_complete_set_for_orderbook ix`
  3. `feat(sooth_market): merge_complete_set_for_orderbook ix`
  4. `feat(sooth_market): redeem_orderbook ix (closes PDA post-settle)`
  5. `test(sooth_market): orderbook lifecycle round-trip + INVALID half-payout`
  6. `feat(sdk-solana): replace Monaco PDA helpers with new architecture`
  7. `feat(sdk-solana): buildOrderbookMint / buildOrderbookMerge builders`
  8. `test(sdk-solana): PDA derivation parity with Rust seeds`
  9. `chore(demo): drop Monaco-era e2e helpers, wire new orderbook builders`
- **Do NOT push, tag, amend, use `--no-verify`.** `NO_DNA=1` prefix.
- **Stop and ask** if:
  - The seed-byte layout for `BookSide` produces a mismatch between Rust and TS derivation. This is the load-bearing parity check.
  - The existing demo `/portfolio` UI structure doesn't have an obvious place to wire orderbook mint/merge (W6 wires the SDK; UI surface defers to W7 if structure is unclear).
  - The redeem-INVALID half-payout formula needs the `(yes + no) / 2` floor rule clarified — spec is unambiguous, but flag if existing AMM `redeem.rs` has a divergent convention.

## When done

Print one-line per-gate pass/fail summary. Stop. **Commit the work** — don't leave the working tree dirty after gates pass.
