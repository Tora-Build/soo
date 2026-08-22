# T\* voiding — refunding trades made after the event already happened

Status: implemented end to end — the `sooth_core` program side for BOTH venues
(AMM positions and book seats), and the resolver that computes the tree
(`infra/zk-resolver`, `--void`).

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
emits `BookFilled` with `taker` and `taker_side`, and per fill the `maker`,
`price_tick` and `amount`. Walking `getSignaturesForAddress` for the market and
decoding those events is the whole of it — the "who traded what, when" table is
public, reproducible, and needs no indexer. `readMarketTrades` /
`readMarketPlays` in `packages/sdk-solana/src/adapter.ts` already do that walk
for the price chart and the leaderboard.

The resolver runs its OWN walk rather than reusing `readMarketPlays`, and the
reason is small but decisive: that reader normalizes a play down to a wallet, a
size and a cost, dropping the `outcome` and the SIGN of `delta_shares` because
a leaderboard does not care which side of a market a wallet was on or whether
it was opening or closing. An entitlement is exactly those two facts. The
resolver also recovers a sell's moment from `PositionSold.unlock_at -
LOCK_DURATION_SECS` — the event carries no `ts` of its own, and that derivation
is the same one `LockEntry::sold_at()` performs, written at one site.

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
- **`redeem_book_seat`** takes the same PDA and an
  `Option<VoidedBookClaimArgs>` under exactly the same rule, against a BOOK
  leaf in the same tree.

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

The book's leaf is a second KIND of leaf in the same tree, separated by its own
domain byte:

```text
book leaf = sha256( 0x02 ‖ market(32) ‖ user(32)
                  ‖ valid_net(8 LE, signed) ‖ book_void_refund_usdc(8 LE) )
```

A wallet that traded both venues owns one leaf of each kind, and `leaf_count`
counts both. The domain byte is what stops an AMM entitlement being spent on a
seat, and it is also why adding the book leaf changed nothing about the AMM
one: every existing proof and every existing caller is untouched.

`valid_net` is signed because a seat's own net is — buying NO and selling YES
are one trade on a single price axis. What the chain enforces against the seat
is that the entitlement is the same SIDE and no larger, and that the refund
does not exceed the voided shares' face value (a book fill costs strictly less
than one unit per share). Together those mean a voided seat can never be paid
more than the unvoided rule would have paid it at most.

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
function of public data: the event tape, T\*, and the accounting convention
below. Publish the convention with the tree and the whole thing is reproducible
byte-for-byte — and the resolver does, stamping `sooth-tstar/fifo-v1` into
every artifact.

### The convention, stated exactly

Implemented in `infra/zk-resolver/src/void/entitlements.mjs` and pinned by its
tests. The first draft of this document said "FIFO over acquisitions, sells
retiring the earliest lots first" and left one thing open — whether a sale
after T\* returns shares to the pre-T\* pool. It does not. The rule in full:

- Every acquisition is a **lot** carrying `{shares, cost, ts}`. `ts` is fixed at
  acquisition and nothing later reclassifies it.
- A sell **retires the earliest lots first**, in acquisition order, regardless of
  when the sell happened. So a wallet that bought pre-T\*, bought again
  post-T\*, and then sold, is left holding its POST-T\* lots — which is the
  case the ambiguity was about.
- Of the lots still held: `ts <= T*` settles normally; `ts > T*` is voided, pays
  nothing, and its **cost** is refunded instead. The boundary is inclusive: a
  trade stamped exactly at T\* is honest.
- A partial sell shrinks a lot's shares and cost pro rata, floored, so the
  surviving basis is never overstated.
- The book is the same rule on its single signed axis: a fill closes existing
  opposite exposure before it opens anything (`split_delta`, mirrored) and only
  the opening part carries basis, priced at the party's own leg cost.

**Why FIFO and not the kinder alternative.** Retiring post-T\* lots first would
leave the honest pre-T\* holding intact through a post-T\* round trip. It also
hands the informed trader a free unwind: buy after T\*, sell after T\*, keep
the pre-T\* settlement AND the proceeds. FIFO cannot be gamed by adding trades,
which matters more here than being kind to the wallet that traded on both sides
of the line. It is admittedly harsh on the honest holder who trims a position
after T\* — they are refunded at cost for shares they had held since before it
— and that is the price of a rule with no exploitable direction.

**One more clamp, above the convention.** Every computed entitlement is capped
at the account the program will check it against: `valid_* <= held`,
`refund <= locked_cost_usdc`, and on the book same-side-and-no-larger with the
refund capped at the voided shares' face value. This is not defensive
decoration — `locked_cost_usdc` shrinks on a sell by the PROCEEDS, not the cost
basis, so a wallet that sold at a profit can carry a basis the field no longer
covers, and a leaf claiming it would verify against the root and then fail to
pay. Where a clamp bites, the resolver reports it, because the other reason for
it to bite is a tape that did not reach far enough.

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

1. **Post-T\* sells, on either venue.** An informed trader who *dumps* a
   soon-to-be-worthless position after T\* is still not caught, and this is
   the one gap that is only partly closeable in principle.

   On the AMM the proceeds went into a `LockEntry` at sell time, and
   `claim_unlocked` pays that out with no reference to any commitment. What is
   *not* missing is the evidence: `LockEntry::sold_at()` recovers the moment of
   the sell exactly (`unlock_at - LOCK_DURATION_SECS`, written at one site), so
   a claw-back needs no new state, no account-size change and no merkle leaf —
   only `require!(sold_at <= t_star)` against a live commitment, inside
   `claim_unlocked`.

   What bounds it is TIMING, not information. A commitment publishes inside the
   veto window after the attestation, which follows the lock, which follows
   every sell; `LockEntry::is_escrowed_at()` is the test. A gate therefore
   catches exactly the sells still inside their 24h cooldown when the
   commitment lands — all of them when the adjudicator locks, attests and
   publishes promptly, none of them when that takes longer than a day. So this
   is *partly* fixable, and honestly not more than that: money that has already
   matured is gone, and no on-chain gate reaches it.

   The book's version of the same thing is the seat's `credit`: USDC released
   by a closing fill or a cancel, which `redeem_book_seat` pays out untouched
   and `book_withdraw` can drain before settlement. Same shape, same limit.

2. **Solvency is bounded at publication, not proven forever.**
   `publish_resolution_commitment` now refuses a commitment whose ceilings the
   vaults cannot cover, per venue:

   ```text
   vault_amm  >= total_void_refund_usdc      + payout(outcome, q - seed)
   vault_book >= total_book_void_refund_usdc + book.total_obligations(outcome)
   ```

   The right-hand side is an upper bound on what the market can pay after
   voiding, because voiding only ever moves a share from "settles" to
   "refunded" and every refund is capped by the ceiling. A commitment that
   would not fit is refused, after which the market redeems unvoided — the same
   safe degradation as never publishing. The check is deliberately
   conservative: a voided share is counted twice, once at face in the
   outstanding ledger and again inside the ceiling, and the slack is bounded by
   the voided volume that a well-chosen T\* keeps small.

   What it does not do is hold that bound open afterwards. `reclaim_subsidy`
   and `redeem_lp` compute their residual from the share ledger alone and know
   nothing about a refund ceiling, so a creator reclaiming after publication
   can still take back the room this check found. Closing it means subtracting
   `void_refund_remaining()` inside those two instructions.

3. **Choosing T\* itself.** For a zkTLS market the Primus attestation carries a
   signed `timestamp` (`zk/primus.rs`, surfaced as `ZkOutcomeAttested
   .attestation_ts`), which is the attestor's observation time and is the
   natural T\* — but note it is when the *attestor looked*, not when the event
   occurred, so it is an upper bound on the true T\*, and a conservative one is
   fine here. `attest_outcome_zk` does not currently persist it, so the
   publisher supplies T\* and it is checked against the public event: the
   `ZkOutcomeAttested` log is right there for a disputer. For manual markets
   T\* is the adjudicator's judgement, evidenced off-chain and disputable like
   everything else. The program only enforces
   `market.start_time <= t_star <= min(attested_at, deadline)`.

4. **`AdjudicatorEntry` has one reserved byte left**, so none of this could
   live there, and `Market._reserved` was off-limits for this change. The
   consequence is the extra account on both redemption paths (see above). If a
   future change is already touching `Market`, a single
   `has_resolution_commitment` bit there would let both redeem instructions
   skip the `find_program_address` on the ~all markets that never void.

5. **A veto window shorter than a confirmation.** The devnet deployment's
   `ProtocolConfig.veto_period_secs` is **2**. Publication is only accepted
   while `now < attested_at + veto_period_secs`, so a resolver that attests and
   then starts replaying the tape has already missed the window — and no amount
   of speed fixes a bound that is shorter than a round trip.

   Two things follow, and neither is a workaround. The tree must be computed
   BEFORE the lock: trading stops there, so the tape is final from that moment
   and T\* is known before it. And attestation and publication must ride ONE
   transaction — `publish_resolution_commitment` reads `attested_at` from an
   account the instruction before it just wrote, and the window it checks is
   genuinely open at that instant.
   `infra/zk-resolver/scripts/void-dry-run-devnet.mjs --publish` does this, and
   it is how the commitment on devnet market
   `68MftdwT3drfS1bvHWQGdkTahPcKzj8Cxxi1p6vecGiE` was published.

   The deeper point is that a two-second veto window is not a veto window. It
   forecloses the scrutiny the whole trust model rests on — nobody replays a
   tape in two seconds — so on this deployment a published commitment is
   effectively final on arrival. Raising `veto_period_secs` toward the 24h the
   design assumes is a configuration change, not a code one, and it is the one
   thing that makes the accountability real rather than nominal.

### Closed since the first draft

- **The book.** `redeem_book_seat` now takes the commitment and a book leaf, so
  a post-T\* book *fill* is refunded at cost exactly as an AMM one is. See the
  leaf section above and `Book::take_settlement_voided`.
- **An unbounded published total.** Publication is now gated on the vaults
  covering it, per venue, as described in (2).

- **The resolver.** `infra/zk-resolver --void` replays the tape (AMM
  `PositionTraded` / `PositionSold` from the logs, `BookFilled` from
  `emit_cpi!` inner instructions), computes the convention above, builds the
  tree, and publishes. `--plan` behaviour is the default: it prints the table
  and the root and submits nothing. Proofs are written to
  `.state/resolutions/<market>.json`, indexed `byWallet`, in exactly the
  argument shape `redeem_amm_position` and `redeem_book_seat` take.

  Two things about it are worth recording here. A leaf is emitted for every
  POSITION and every SEAT, not for every wallet in the tape — once a commitment
  exists the claim argument is mandatory, so a position with no leaf could never
  redeem, and an all-zero leaf is the floor. And a run whose tree disagrees with
  the root already on chain refuses to overwrite the live proof file, because
  that would replace every live proof with proofs against a root nobody
  published.

  The encoding is proved against the verifier rather than asserted:
  `packages/sdk-solana/tests/t-star-voiding-resolver.test.ts` imports the
  resolver's own merkle and entitlement modules and hands their output to the
  real instructions on LiteSVM. A mismatch between the two leaf composers is the
  single most likely way to build a worthless tree, and nothing but running them
  against each other catches it.
