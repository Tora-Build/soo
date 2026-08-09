# Dual-token venues: the AMM in an instance token, the book in USDC

Status: design, 2026-08-09. No code yet.

Companion to the EVM initiative (`Tora-Build/sooth-alpha@7da01a7f`,
`docs/research/initiatives/EASTBOARD_DUAL_TOKEN_VENUES_2026-08-07.md`). This is
**not** a port of it. The two codebases have the same goal and the problem sits
in different places, so the work is different — §1 says where, and the rest of
this document stands on its own.

---

## 1. Why this is not the EVM plan

The EVM plan's Phase 1 is "build FeeVault", because there the fee layer is
split-brained: FeeRouter keeps counters while AMMEngine holds the money, and a
book fill physically transfers its USDC fee *into AMMEngine* where it is counted
as AMM collateral.

None of that is true here, and one thing that *is* true there is false here:

| EVM coupling (their §2) | Solana today |
|---|---|
| C3 — collateral pools already separate per venue | ✗ **One `market.vault` serves both venues.** 16 instructions touch it |
| C4 — book fee transferred into the AMM engine, counted as collateral | ✓ Absent. Book fees go to `market_fee_pool`, a different account |
| C5 — fee accounting held apart from fee custody | ✓ Absent. `market_fee_pool` holds the money it accounts for |
| C6 — book cannot exist before graduation | ✗ **`book_place` has no graduation gate.** Gating is UI-only |
| Graduation threshold diverges at p ≠ 0.5 | ✓ Absent. It is `b·ln(2)`, p-independent by construction |
| 50% of book fees grow the AMM's `b` | ✓ Absent. `book_place` never touches `amm_state` |

So their centre of gravity (fees) is largely already correct here, and our
centre of gravity (one shared collateral vault) does not exist there.

**What we take from their document:** the venue split itself, the
different-games ruling (no cross-venue arbitrage is designed for, and price
divergence between venues is acceptable and unbounded), and the graduation
threshold becoming a configured multiple of the creator's deposit.

**What we do not take:** the FeeVault architecture, the lifecycle state machine,
and the deliberate-breakage test list — all of which address defects we do not
have.

---

## 2. The constraint that shapes everything

**An SPL token account holds exactly one mint.**

In Solidity one contract holds many ERC20s and separating them is a discipline
you can get wrong. Here the runtime forbids mixing, so the separation is
enforced rather than maintained — but every account that names a vault has to
become two accounts.

Today:

```
market.vault  ── ONE account, holds USDC
   ├─ AMM collateral        (trade_positions, sell_positions, seed_lp, …)
   ├─ book collateral       (book_place, book_ops, redeem_book_seat)
   └─ complete-set backing  (mint/merge/redeem — being deleted, §4)
```

After:

```
vault_amm   ── holds AMM_TOKEN_MINT    (AMM only)
vault_book  ── holds BOOK_TOKEN_MINT   (book only)
```

Both stay under the existing `vault_authority` PDA — a signer-only PDA can own
one ATA per mint, so no new authority and no new seeds are needed for the
vaults. The fee pool is a seeded token account rather than an ATA, so that one
does need its mint in the seeds.

---

## 3. Token identity

Two compile-time constants replace one:

```rust
// constants.rs — today
#[cfg(feature = "mainnet")]
pub const BASE_TOKEN_MINT: Pubkey = USDC_MINT_MAINNET;
#[cfg(not(feature = "mainnet"))]
pub const BASE_TOKEN_MINT: Pubkey = USDC_MINT_DEVNET;

// after
pub const AMM_TOKEN_MINT:  Pubkey = /* per-deployment */;
pub const BOOK_TOKEN_MINT: Pubkey = /* per-deployment */;
```

Both are baked into the program binary. That is the strongest form of "set once
at deployment": not storage, not governance-writable — changing either means
recompiling and redeploying. Every market on a deployment uses the same pair.

**Naming.** The constants name the *role*, never the ticker. The AMM token is
per-deployment and its symbol is not the program's business.

**Devnet.** A mock SPL mint stands in for the instance token, exactly as
MockUSDC does for USDC today, selected by the same `#[cfg(feature = "mainnet")]`
split.

**Consequence to accept deliberately:** a `const` means **one program deployment
per instance**. Two instances with different instance tokens are two program
IDs and two audits of the same source. The alternative — both mints in
`ProtocolConfig` — makes one deployment serve every instance but turns the token
identity into governance-mutable state, which is a materially weaker guarantee
than the one asked for. We take the const.

---

## 4. Complete sets are deleted

The per-market YES/NO SPL mints and their five instructions are removed. This
lands **before** the token split (§8), because it shrinks everything after it.

**Why.** Measured: the trading paths do not touch them at all.

| | references to `yes_mint` / `no_mint` |
|---|---|
| `trade_positions`, `sell_positions` | 0 |
| `book_place`, `book_ops` | 0 |
| `redeem_amm_position`, `redeem_book_seat` | 0 |

They are a standalone third system — one pair of mints per market, seeds
`[b"mint", market_id, b"Y" | b"N"]` — with a fixed-rate entry
(`mint_complete_set`: 1 USDC → 1 YES + 1 NO), a fixed-rate exit
(`merge_complete_set`), and a settlement exit (`redeem`). No price, no
discovery, no connection to either venue: nothing converts a token into an AMM
`Position` or a book `SeatNode`, in either direction.

Their only real value would be as a *transferable, composable* form of a
position — a DEX listing, or use as collateral elsewhere. No such integration is
planned, so they are cost without return.

**Removing them also removes a question with no good answer.** Under two
tokens, an outcome token would have to be denominated in one of them, and would
become a third silo drawing on that vault.

**The rule that would have applied had we kept them**, recorded because it is
the kind of thing that gets built later by someone who does not know: a bridge
between an outcome token and a *book seat* is safe (both USDC); a bridge to an
*AMM position* is a hole. The latter converts a 1-USDC claim into a
1-AMM-token claim at a fixed 1:1, so the moment the instance token trades above
USDC, anyone mints sets and drains the AMM vault. Same currency, safe; crossing
currencies, never.

**What removal frees.** From `Market`: `yes_mint` (32) + `no_mint` (32) +
`yes_mint_bump` (1) + `no_mint_bump` (1) = **66 bytes**, on top of the existing
64 reserved. That is comfortably enough for the second vault address, which was
otherwise going to be tight.

Cost avoided per market: 2 mint accounts (~0.0029 SOL). Per holder: 2 ATAs
(~0.0041 SOL). CU saved on trading: **zero** — no trading path touches them.
The win is simplicity and one fewer ledger in `reclaim_subsidy`, not
performance.

---

## 5. Venue assignment

Every instruction that names a token, and which constant it takes.

**Book — `BOOK_TOKEN_MINT`**

| instruction | sites |
|---|---|
| `book_place` | `:21`, `:59` |
| `book_ops` (cancel, withdraw) | `:14`, `:85` |
| `redeem_book_seat` | `:50`, `:78` |

**AMM — `AMM_TOKEN_MINT`**

| instruction | sites |
|---|---|
| `trade_positions` | `:61` |
| `sell_positions` | `:95` |
| `seed_lp` | `:12`, `:85`, `:97` |
| `redeem_lp` | `:6`, `:55` |
| `redeem_amm_position` | `:41`, `:76` |
| `claim_unlocked` (sell-lock proceeds) | `:67` |
| `claim_refund` (dismissed-market refund) | `:10`, `:46`, `:63` |

**Both — needs one account per token**

| instruction | note |
|---|---|
| `create_market` `:85` | creates both vaults |
| `init_market_fee_pool` `:23` | creates both fee pools |
| `distribute_fees` `:33`, `distribute_fees_legacy` `:37` | splits each pool in its own token |
| `reclaim_subsidy` `:45`, `:103` | see §7 |

**Deleted (§4)** — `mint_complete_set`, `mint_complete_set_to_program_owned`,
`merge_complete_set`, `redeem`, `redeem_from_program_owned`.

`lock_vault` (AMM sell-locks) follows the AMM token.

---

## 6. Behaviour changes

### 6.1 The book is gated on graduation

Today `book_place` requires only `market.is_open()`. Graduation gating lives in
the UI, so the program permits book trading on an ungraduated market.

`book_place` does **not** hold `amm_state`, where `is_graduated` lives. Two ways
to fix that, and the choice matters:

- **Rejected — add `amm_state` to `BookPlace`.** Costs one account and 32 bytes
  on *every* order, permanently. The book redesign's headline property is that a
  fill costs zero extra accounts; spending that on a boolean is the wrong trade.
- **Chosen — mirror the flag onto `Market`.** `book_place` already loads
  `market`, so the check is free:

  ```rust
  require!(market.book_enabled, SoothCoreError::NotGraduated);
  ```

  `trade_positions` sets it once when graduation fires. It currently holds
  `market` read-only, so it becomes `mut` — the account is already loaded, so
  this costs a write, not a read. One byte from `Market`'s reserved space.

`book_init` stays ungated: an empty book account created early is harmless and
costs its creator their own rent. `book_cancel` and `book_withdraw` stay ungated
for the existing reason — an exit must always be available.

### 6.2 The graduation threshold becomes configurable

Today (`trade_positions.rs:226`):

```rust
let threshold_wad = wad_mul(amm.b, LN2_WAD)?;   // b · ln(2)
```

`b · ln(2)` is the LMSR's maximum loss and therefore exactly the creator's
deposit, so today's rule is "earn back 100% of capital at risk". Generalise:

```rust
threshold = deposit × graduation_bps / 10_000
```

with `graduation_bps` in `ProtocolConfig` (64 reserved bytes available). At
10 000 bps this is identical to today, so the change is inert until configured.

### 6.3 Fee rates split per venue

**Found while writing this, and it should be fixed regardless of dual tokens:**
the program charges a single `ProtocolConfig.fee_bps` for both venues and both
phases (`book_place.rs:114`, `trade_positions.rs:170`), while the UI displays
"5% bonding / 1% live" from a hardcoded `getFeeLabel`. The displayed rate is not
the charged rate.

Under two tokens the venues cannot share a rate anyway — they are the incubation
engine and the mature venue, in different currencies. Split into
`amm_fee_bps` and `book_fee_bps`, both from reserved space.

**Blocker on actually using differentiated rates.** The fields exist and the
program honours them, but every deployment is currently configured 1%/1%,
because setting the AMM rate meaningfully higher breaks selling. Two defects
compound:

1. `amm-bridge.ts::getPositionQuote` quotes a SELL as a BUY — it passes
   `abs(delta)` and says so in a comment. `readQuote` already handles a signed
   delta correctly (`costDelta` takes the sign), so the shim is discarding
   information it has. The quoted proceeds are therefore the cost of buying
   *more*, not of selling out, and they differ by price impact.
2. `SolanaChainAdapter.readQuote` computes `fee` only when `cost > 0`, so the
   sell branch reports a zero fee even once (1) is fixed.

The demo's ±5% slippage buffer absorbed error (1) while the fee was 1%. At 5%
the fee consumes the buffer and the approximation surfaces as `SlippageExceeded`
on a market that has not moved — which is how this was found.

This must be fixed before a deployment sets an AMM rate above roughly 4%, and
that is the entire point of the split. It is a demo/SDK defect, not a program
one: the program's `sell_positions` compares `net_proceeds >= min_proceeds`
correctly.

### 6.4 Two fee pools

`market_fee_pool` seeds go from `[b"market_fee_pool", market_id]` to
`[b"market_fee_pool", market_id, mint]`. `distribute_fees` runs per pool, in
that pool's own token, against the same four-way split
(`b_base`, `lp_yield`, `adjudicator`, `protocol`).

Note `b_base_share_bps` — the share that grows the AMM's `b` — is meaningless
for the book pool: growing an AMM-token `b` with book USDC is exactly the
cross-currency leak §4 warns about. **The book pool's `b_base` share must be
zero or rejected at config time**, not silently applied.

---

## 7. `reclaim_subsidy` — the one real rework

This is the only function that reasons across every ledger at once. It pays the
creator `vault − obligations` and is bounded by `posted − reclaimed`, counting
three ledgers today: outcome-token mint supply, AMM `q` above seed, and book
seats.

After §4 there are two ledgers; after the token split they are in **different
currencies and different vaults**, so it becomes two independent calculations:

- **AMM vault:** obligations = AMM `q` above seed. Pays the creator in the AMM
  token. This is the real subsidy reclaim — the deposit was in the AMM token.
- **Book vault:** obligations = book seats. The creator posted nothing here, so
  there is nothing to reclaim; the book is fully collateralised by construction
  (every matched pair's two legs sum to exactly 1.00).

The likely shape is that `reclaim_subsidy` becomes AMM-only. That must be
confirmed against the book's solvency proof before implementing, not assumed —
getting it wrong pays the creator out of traders' collateral.

---

## 8. Why each venue stays solvent

Separating the vaults does not create a hole, because each venue is already
independently collateralised:

- **AMM:** LMSR bounded loss, covered by the creator's `b·ln(2)` deposit.
- **Book:** every fill's bid and ask legs sum to exactly 1.00, so every share
  owed is fully backed.

They currently share a vault, but never share funds — no instruction moves value
from one ledger to another. Splitting the account makes an existing property
visible rather than changing it.

**The invariant to hold after the split:** each vault's balance ≥ that venue's
own obligations, checked independently. No instruction may read one vault to
satisfy the other.

---

## 9. Out of scope

Instance-token tokenomics; any cross-venue arbitrage bridge (the venues are
deliberately different games and unbounded price divergence is accepted); LMSR
mathematics; the pre-graduation fee-as-LP-equity mechanism; mainnet deployment.

---

## 10. Implementation plan

Each phase leaves the program building, tests green, and — except where noted —
deployable on its own.

### Phase 0 — delete complete sets

Standalone and shippable. Does not depend on anything below, and shrinks every
phase after it.

- Delete `mint_complete_set`, `mint_complete_set_to_program_owned`,
  `merge_complete_set`, `redeem`, `redeem_from_program_owned`
- `create_market`: stop creating the two mints (23 references)
- `Market`: drop `yes_mint`, `no_mint`, `yes_mint_bump`, `no_mint_bump`
  (+66 bytes reserved)
- `reclaim_subsidy`: drop the mint-supply ledger
- `events.rs`: `CompleteSetMinted`, `Redeemed`
- SDK: `types.ts`, `adapter.ts`, `index.ts`, regenerate the IDL
- Demo: delete `CompleteSetPanel.tsx`, edit `Portfolio.tsx` and `amm-bridge.ts`
- `settle-e2e.mjs`: drop the SPL leg (it covers code being deleted)

### Phase 1 — small independent behaviour changes

Neither touches tokens; both are worth landing before the split so the split's
diff stays purely about tokens.

1. Book graduation gate (§6.1) — `Market.book_enabled`, set in
   `trade_positions`, required in `book_place`
2. `graduation_bps` (§6.2) — inert at 10 000
3. `amm_fee_bps` / `book_fee_bps` (§6.3), and correct the UI's hardcoded label

### Phase 2 — the token split

Must land as one unit; a half-split vault is not a valid state.

1. `AMM_TOKEN_MINT` / `BOOK_TOKEN_MINT` + a devnet mock instance token
2. `Market`: `vault_book`, `vault_amm` (into the space Phase 0 freed)
3. `create_market` creates both vaults; `init_market_fee_pool` both pools
4. The ~30 remaining constraint sites pick a side, per the §5 table
5. `reclaim_subsidy` rework (§7)
6. `distribute_fees` per pool, with the `b_base` guard (§6.4)

### Phase 3 — off-chain and deploy

SDK builders and PDA derivations, demo dual-token display and faucet, fresh
deploy at a new program ID, reseed devnet.

### Testing

Phase 0 is a deletion — existing tests should pass unchanged or be deleted with
their subject; nothing new is needed.

Phases 1–2 need, at minimum:

- book_place rejected pre-graduation, accepted after (both directions)
- graduation at `graduation_bps` ≠ 10 000
- **a test per venue asserting the vault it draws on holds the right mint** —
  this is the class of bug that silently mixes currencies, and it will not
  surface any other way
- each venue's solvency checked against its own vault only
- `reclaim_subsidy` pays from the AMM vault and cannot touch the book's

---

## 11. Risks

- **The 30-odd constraint sites are the audit surface.** Each is one line, all
  are mechanical, and one wrong choice mixes currencies with no error. Hence the
  per-venue mint test above.
- **No migration.** Existing devnet markets are abandoned; this deploys at a new
  program ID. Consistent with Phase 5 of the orderbook redesign.
- **`reclaim_subsidy` is the one place real thought is needed.** Everything else
  is mechanical or small.
- **One deployment per instance** (§3), accepted deliberately.
