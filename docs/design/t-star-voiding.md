# T\* voiding — refunding trades made after the event already happened

Status: designed, partially implemented (`sooth_core` program side; SDK resolver
and book coverage outstanding).

## The problem

Every Sooth market asks "will X happen **by** time T". The event itself happens
at some **T\***, which is normally strictly earlier than the deadline T, and the
adjudicator only notices some time after that. `lock_for_resolution` therefore
lands at `T_lock > T*`, and the window `(T*, T_lock]` is a window in which the
answer is already public knowledge but the market is still trading.

Trades in that window are not predictions. They are withdrawals from the pool,
made by whoever refreshed the news fastest. The LMSR AMM is the counterparty, so
the money comes out of the creator's subsidy and the LPs; on the book it comes
out of whichever maker had not yet cancelled.

What we want: a trade made at `t <= T*` settles normally. A trade made at
`t > T*` is **voided** — the shares pay nothing and the trader gets their cost
back.

## The constraint

`Position` stores aggregates — `yes_shares`, `no_shares`, `locked_cost_usdc` —
not per-trade history. On-chain, at redemption time, the program cannot tell
which of a wallet's 40 YES shares were bought before T\* and which after. There
is no timestamp anywhere in `Position`, and there was never going to be one:
each trade would have to append to a growing per-wallet list.

## The insight

The chain does not need to store the per-trade record, because **it already
emits one**. Every AMM buy and sell emits `PositionTraded` / `PositionSold` with
`user`, `outcome`, signed `delta_shares`, `cost_wad` and `ts`; every book match
emits `OrdersFilled` with `taker`, and per fill the `maker`, `yes_tick`,
`amount` and `ts`. The SDK already replays exactly this tape —
`readMarketTrades` / `readMarketPlays` in `packages/sdk-solana/src/adapter.ts`
walk `getSignaturesForAddress` for the market and decode the events — so the
"who traded what, when" table is public, reproducible, and needs no indexer.

So the split is: **the resolver computes, the chain verifies a commitment to the
computation, and the existing veto window is the enforcement.** Any observer can
replay the same public events, recompute the commitment, and dispute a wrong one
before it becomes final. The resolver is accountable without being trusted.

## Options considered

### (a) Merkle root of per-wallet entitlements, proof-carrying redemption — CHOSEN

The resolver replays the event tape, computes for each wallet the shares it
still holds that were acquired at or before T\* plus the USDC it paid for
post-T\* acquisitions, builds a merkle tree over one leaf per wallet, and
publishes `{T*, root, leaf_count, total_void_refund}` on-chain in a single
`ResolutionCommitment` PDA. At redemption the wallet passes its leaf values and
a merkle proof; the program verifies the proof against the root and pays
`settle(valid_yes, valid_no) + void_refund` instead of `settle(all_shares)`.

This is the airdrop / merkle-distributor pattern, which is about as well-trodden
as Solana patterns get, and sha256 is a syscall.

Costs, honestly:

- **Rent**: one PDA per market, 165 bytes, ≈0.0036 SOL. Flat in the number of
  traders. Paid by the publisher, refunded on `revoke`.
- **CU**: one sha256 per proof node. A tree over 4,000 wallets is 12 deep —
  ≈1.5k CU of hashing on top of `redeem_amm_position`'s existing cost. A tree
  over a million wallets is 20 deep. This is noise against the 200k default.
- **Proof size**: 32 bytes per level. 12 levels = 384 bytes, 20 levels = 640
  bytes, inside a 1232-byte transaction alongside eight accounts.
- **UX**: the redeeming wallet must *fetch* its leaf and proof from somewhere.
  The tree is reproducible from public events, so a client can rebuild it
  locally in the worst case, but in practice it fetches a JSON the resolver
  published. That is a real off-chain dependency for a redemption that used to
  need nothing but the wallet.
- **If the resolver never publishes**: the market redeems exactly as it does
  today — full payout, no voiding. Nothing is frozen, no funds are stranded, and
  no user is blocked on a file that never appeared. That is a deliberate choice
  (see "Liveness" below) and it is also the design's main weakness: voiding is
  opt-in by the resolver, so a lazy adjudicator simply doesn't do it.
- **If the resolver publishes a wrong tree**: bounded, then disputable — see
  "Trust model".

### (b) Per-trade on-chain records

Give every trade its own PDA (`[b"trade", position, nonce]`) carrying `{ts,
outcome, delta_shares, cost}`, and have redemption walk them.

- **Rent**: ≈0.0029 SOL per trade at 80 bytes. A market with 5,000 trades burns
  ≈14.5 SOL in rent that nobody wants to pay, and reclaiming it means a close
  instruction per trade.
- **CU / transaction shape**: redemption must pass every one of a wallet's trade
  accounts. A wallet with 40 trades exceeds the 64-account transaction limit
  before it exceeds anything else, so redemption becomes multi-transaction with
  its own partial-progress state.
- **Write amplification**: it makes the hot path (`trade_positions`) pay for a
  cold path (voiding), on every trade of every market, including the ~all of
  them that never need voiding.
- It is the only option that needs no resolver at all, and that is genuinely
  worth something. It is not worth 14.5 SOL and an account-limit rewrite of
  redemption.

### (c) Store T\* only; void the whole position if any trade falls after it

Publish just `T*`. Any wallet whose *last* trade is after T\* gets refunded at
cost and paid nothing; everyone else settles normally. Requires one timestamp on
`Position` (12 bytes of its 32 reserved).

- **Cheap**: no tree, no proof, no off-chain artifact, no resolver publication
  beyond one integer. Redemption keeps its current transaction shape.
- **Wrong**: it punishes the honest holder who bought a year ago and topped up
  one share after T\*, and it hands a free option to anyone who wants their
  losing position refunded — buy one share for a cent after T\* and the whole
  losing book is refunded at cost. That is not a rough edge, it is an arbitrage
  strictly better than the informed trade we set out to stop.
- It also does not touch `sell_positions`, so the informed trader dumps instead
  of buying and nothing catches it.

### Why (a)

(b) is correct and unaffordable. (c) is affordable and creates a worse exploit
than the one it closes. (a) puts the per-trade work where the per-trade data
already is — off-chain, in the event log — and pays only for a 32-byte
commitment on-chain. The property that makes it safe is not that the resolver is
honest; it is that the resolver's claim is (i) *bounded* by on-chain state and
(ii) *checkable* by anyone during the veto window.

## Mechanism

### Accounts and instructions

- **`ResolutionCommitment`** (`state/resolution.rs`), seeds
  `[b"resolution", market]`. Holds `market`, `merkle_root`, `t_star`,
  `leaf_count`, `total_void_refund_usdc`, `void_refund_paid_usdc`, `publisher`,
  `published_at`, `bump`. One per market, created once.
- **`publish_resolution_commitment`** (`instructions/publish_resolution.rs`).
  Signed by `adjudicator_entry.authority`. Callable only while the market is
  `Locked`, the outcome is attested, and the veto window is still **open** — so
  the commitment is always exposed to the same 24h scrutiny as the outcome it
  accompanies, and always lands before `settle`.
- **`revoke_resolution_commitment`** (same file). Signed by
  `adjudicator_entry.dispute_authority`, callable only inside the veto window,
  closes the PDA and returns the rent to the publisher. This is what gives the
  veto teeth over the commitment specifically: `dispute` can already flip a
  wrong *outcome*, and `revoke` now removes a wrong *entitlement tree*, after
  which the market redeems exactly as it does today.
- **`redeem_amm_position`** takes the commitment PDA as an additional account
  and an `Option<VoidedClaimArgs>`. Empty PDA → today's behaviour, and the
  option must be `None`. Live PDA → the option is required and verified.

### Why redemption has to take the account

A program cannot detect an account it was not handed. Making the commitment
account optional, or adding a separate "voided redeem" instruction alongside the
untouched original, both leave the original as a bypass: a wallet that wants its
full payout simply calls the version that does not know about the commitment.
The one place the check cannot be routed around is inside the only instruction
that pays an AMM position, with the PDA address pinned by seeds. So
`redeem_amm_position` gains one account and one argument. That is an ABI change
for callers (the SDK adapter must pass the PDA and a `None`); it is *not* a
behaviour change for any market without a commitment.

The account is `UncheckedAccount` with a `seeds` constraint and no stored bump,
because the honest case is that it does not exist. Non-existence is what
`data_is_empty()` reports, and a `find_program_address` (≈1.5k CU) is the price
of being able to distinguish "absent" from "substituted".

### The leaf

```text
leaf = sha256( 0x00 ‖ market(32) ‖ user(32)
             ‖ valid_yes_wad(16 LE) ‖ valid_no_wad(16 LE)
             ‖ void_refund_usdc(8 LE) )
node = sha256( 0x01 ‖ min(a,b) ‖ max(a,b) )
```

Sorted pairs, so a proof carries no direction bits. Distinct domain-separation
bytes for leaves and internal nodes, so no leaf preimage can be passed off as an
internal node — with sorted pairs and an odd-node-promotes rule that is the
property doing the work.

`market` is inside the leaf as well as in the seeds: it makes a proof from one
market's tree unusable against another's root even if the roots were ever
confused.

### What the payout becomes

```text
payout = settle(outcome, valid_yes_wad, valid_no_wad) + void_refund_usdc
```

with `settle` being the existing rule (winning side pays 1:1, INVALID splits).
All of the position's shares are still retired and still decremented from
`AmmState.q_*`, so `q = seed + Σ positions` holds and `sweep_residual` still
terminates; the voided shares' backing simply stays in the vault as residual.

## Trust model

**What an honest resolver publishes**: T\*, the root, the leaf count, the total
void refund — on-chain — plus, off-chain, the full leaf table (wallet →
`valid_yes`, `valid_no`, `void_refund`) and the proofs. The leaf table is a pure
function of public data: the event tape from `readMarketPlays`, T\*, and a
stated accounting convention (FIFO over acquisitions, sells retiring the
earliest lots first). Publish the convention with the tree and the whole thing
is reproducible byte-for-byte.

**What a dishonest resolver cannot do**, because the chain checks it at
redemption:

- *Pay a wallet more shares than it holds.* `valid_yes_wad <=
  position.yes_shares` and `valid_no_wad <= position.no_shares` are checked
  against the position being consumed.
- *Refund a wallet more cash than it put in.* `void_refund_usdc <=
  position.locked_cost_usdc`, the same field `claim_refund` pays from.
- *Refund more in total than it declared.* Every redemption accumulates into
  `void_refund_paid_usdc` and fails past `total_void_refund_usdc`, so the
  published total is a hard ceiling on the cash the void path can move — and it
  is published *before* the veto window closes, where anyone can compare it to
  the vault.
- *Invent a wallet.* A leaf only pays the `user` inside it, and that user must
  sign.
- *Publish late, or after settlement.* The window guard rejects it.
- *Publish twice, or amend.* The PDA is created once.

**What a dishonest resolver can do**: under-pay. It can set a wallet's
`valid_yes` to zero, or its `void_refund` to zero, or pick a T\* that is
absurdly early and void half the market's honest trading. Nothing on-chain
distinguishes a wrong-but-bounded tree from a right one — the chain does not
know the event tape.

**That is what the veto window is for.** The commitment is only publishable
while `now < attested_at + veto_period_secs`, and `settle` refuses until that
window closes. In between, anyone — not just the dispute authority — can replay
the same public events, recompute the root, and see that it differs from the one
on-chain. A wrong root is *provably* wrong to a third party, because the inputs
are public and the function is deterministic. The dispute authority then calls
`revoke_resolution_commitment` and the market pays out as if voiding had never
been attempted, or `dispute` if the outcome itself is wrong.

So the resolver is not trusted; it is *accountable*, in the same sense and by
the same mechanism as it already is for the outcome. The design deliberately
adds no new trusted role and no new trust window — it reuses the one the
protocol already runs.

## Liveness: what happens if nobody publishes

Nothing. The market settles and redeems exactly as it does today. This is
chosen over the alternative (block `settle` until a commitment exists), because
the alternative makes every redemption in the protocol depend on an off-chain
computation that one key is responsible for producing. A missing commitment
should degrade to the status quo, not to frozen funds.

The cost of that choice is that voiding is discretionary: an adjudicator who
cannot be bothered simply never publishes, and the informed-trading window stays
open. Making it mandatory is a policy change (require the commitment before
`settle` for markets flagged at creation), and it belongs in the same change
that gives markets a per-market voiding policy flag.

## What this does NOT solve

1. **The book.** `redeem_book_seat` pays out seat positions and is untouched, so
   a post-T\* *book* trade is not voided. The event data is there
   (`OrdersFilled` carries per-fill `maker`, `taker`, `ts`), and the same
   commitment can gate it — the leaf just needs a book net alongside the AMM
   legs. It needs edits to `redeem_book_seat` plus seat accounting in `book/`.
2. **Post-T\* sells.** An informed trader who *dumps* a soon-to-be-worthless
   position after T\* is not caught. Their proceeds went into a `LockEntry` at
   sell time, and `claim_unlocked` pays that out with no reference to any
   commitment. Clawing it back means gating `claim_unlocked` on the commitment
   and letting a leaf carry a negative adjustment — which needs
   `instructions/sell_positions.rs` and `state/lock_entry.rs`, and is a bigger
   change than the buy side because the money has already left the AMM vault's
   accounting.
3. **Vault solvency under heavy voiding.** Refunding a voided buyer at cost while
   retiring their shares is the right economics — it undoes the trade — but LMSR
   is only path-independent for the *pool*, not for a mid-path unwind at
   historical cost. If the voided trades moved the price a long way, refunds at
   cost plus payouts to valid winners can in principle exceed what the vault
   holds, and the shortfall lands on the subsidy that `reclaim_subsidy` would
   otherwise return. `total_void_refund_usdc` bounds the exposure and makes it
   inspectable before settlement, but the program does not *prove* solvency. A
   proof needs a void-refund pool tracked in `AmmState`, sized at publish time
   out of the residual.
4. **Choosing T\* itself.** For a zkTLS market the Primus attestation carries a
   signed `timestamp` (`zk/primus.rs`, surfaced as `ZkOutcomeAttested
   .attestation_ts`), which is the attestor's observation time and is the
   natural T\* — but note it is when the *attestor looked*, not when the event
   occurred, so it is an upper bound on the true T\*, and a conservative one is
   fine here. `attest_outcome_zk` does not currently persist it, so the
   publisher supplies T\* and it is checked against the public event: the
   `ZkOutcomeAttested` log is right there for a disputer. For manual markets T\*
   is the adjudicator's judgement, evidenced off-chain and disputable like
   everything else. The program only enforces
   `market.start_time <= t_star <= min(attested_at, deadline)`.
5. **`AdjudicatorEntry` has 2 reserved bytes**, so none of this could live
   there, and `Market._reserved` was off-limits for this change. The
   consequence is the extra account on redemption (see above). If a future
   change is already touching `Market`, a single `has_resolution_commitment`
   bit there would let `redeem_amm_position` skip the `find_program_address` on
   the ~all markets that never void.
