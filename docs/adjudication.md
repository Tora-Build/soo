# Adjudication — the four ways a Soo market learns the truth

Every market answers one question at the end of its life: *what happened?*
Soo ships four resolution modes, each with a different trust model, all
converging on the same tail — an attestation, a veto window, a permissionless
settle. This document says how each works, who may act when, and where every
action lives in the UI.

## The modes

### Automatic (zkTLS)
A machine-checkable rule (API endpoint + threshold) is committed on-chain at
creation; the resolver watches the feed and, the moment the rule is
satisfied, submits a Primus zkTLS proof — a cryptographic receipt of what
the source served. The market locks and attests itself, **before the
deadline** when the answer is already known. The creator retains a manual
override, and the guardian veto applies to proofs exactly as to human
rulings (it can *reject* a proof's verdict, forcing re-resolution; it can
never substitute its own).

### Adjudicated
A named human rules: the creator by default, or any authority delegated at
creation — picked from the reputation directory, or pasted by address. Every
ruling, veto, response time and bonded outcome an authority has ever
produced is folded into a public score (see `/adjudicators`), so trust is a
record, not a reputation.

### Optimistic (bonded)
No one is appointed. After the deadline, **anyone** may assert the outcome
by posting a USDC bond. Silence for the challenge window (600s on devnet)
makes the assertion final and returns the bond. A matching counter-bond
escalates to the **arbiter** — the adjudicator named at creation, who does
nothing on the happy path — and the loser's bond pays the winner. Eligibility
is structural: only markets with **no registered adjudicator entry** accept
proposals, so a proposer can never race an owned resolution path. One
proposal per market; a market dismissed mid-proposal still pays its bonds
out (settlement no-ops, money flows).

### Committee (M-of-N quorum)
The adjudicator convenes up to 5 attestors with a threshold M. Members cast
public, mutable ballots; the ballot that brings agreeing votes to M writes
the attestation — indistinguishable downstream from a single-key ruling.
Additive: the convening authority keeps their unilateral attest (a committee
that distrusts its convener should *be* the authority via multisig). Note:
standing votes persist through a guardian veto; members re-cast to
re-trigger quorum, and an unchanged stale majority can re-affirm instantly —
committees that change their mind must change their votes.

## The guardian layer (applies to every mode)

- The **veto rejects; it never decides.** During the window after any
  attestation, the dispute authority — or any deputized guardian — may clear
  the ruling. The adjudicator must rule again, and the fresh ruling gets its
  own full window. The vetoer's claimed outcome is emitted on the event as a
  public statement only.
- **Capped at 3 vetoes per market**, so a guardian cannot filibuster. A
  market whose adjudicator never re-rules falls to the forced-invalid hatch.
- **Guardians may be added at ANY time** before settlement — there is no
  lifecycle gate on roster changes — by the dispute authority (up to 5).
  They can also be listed at market creation in the Forge, and each is
  deputized immediately after the market lands.

## Where everything lives (UI map)

| Action | Who sees it | Where | When it shows |
|---|---|---|---|
| Pick mode / adjudicator / guardians | creator | Forge | at creation; guardians field only when the creator rules |
| Rule (attest, one signature incl. early lock) | entry authority | Locker row | market open (early) or locked |
| Veto (reject ruling) | dispute authority + guardians | Locker row | only while a veto window is running |
| Manage guardians | dispute authority | Locker row (`Guardians n/5`) | any time before settlement |
| Convene/manage committee | entry authority | Locker row (`Committee M-of-N`) | any time before settlement |
| Cast committee ballot | roster members | Locker row | market locked and unattested |
| Assert with bond / challenge / finalize | anyone | market page (Bonded resolution panel) | eligible market past deadline, or live proposal |
| Arbitrate a challenge | designated arbiter | market page | only when challenged |
| Everything above, scripted | anyone | Geek terminal | `attest`, `veto`, `guardians`, `attestors`, `vote`, `propose`, `challenge`, `finalizeprop`, `arbitrate`, `proposal` |

The Locker lists **creations and duties**: markets you created, plus markets
where you are the adjudicator, dispute authority, or designated arbiter
(badged `YOUR RULING` / `YOUR DUTY`). Guardian and committee rosters live in
side accounts the Locker's poll doesn't enumerate, so members who hold *only*
a roster seat act from the market page or Geek.

## Reputation

All of it is scored — rulings (+10 clean, −20 vetoed, −12 forced-invalid,
−5 unresponsive, +2 prompt), vetoes (graded only where ground truth exists:
overriding a zk proof costs −10; manual vetoes are counted, displayed, and
deliberately unscored), and bonds (+8 upheld, −15 slashed, +10/−10 per
challenge) — as a pure fold over public chain state. `/adjudicators` ranks
everyone; the Forge's picker reads from the same fold. Bonded cases are the
strongest signals in the system because they are the only ones paid for in
money.

## Market stages — the shared vocabulary

Resolution decides *what happened*; these words decide *what a market is
doing right now*, and every surface uses them identically.

| Word | Means | Tradeable |
|---|---|---|
| **Live** | accepting trades on either venue — the union below | yes |
| **Bonding** | trading on the AMM bonding curve; fees accumulate toward graduation | yes |
| **Orderbook** | graduated; trades on the on-chain book (the AMM stays open too) | yes |
| **Ended** | deadline passed, or Locked mid-resolution: adjudicator ruling, veto window, awaiting settle | no |
| **Settled / Finalized** | outcome final; redeem | no |
| **Dismissed** | cancelled; refunds only | no |

"Live" is deliberately a SUPERSET of Bonding and Orderbook: it answers
"can I trade this", while the venue words answer "where". The earlier
vocabulary used "live" to mean *graduated*, which let a graduated market
whose deadline had passed match the LIVE filter while its own card said
trading was closed — a filter and a card describing different worlds.

Tradeability is never inferred from the venue: it is lifecycle (Open) AND
deadline (ahead), mirroring the program's `TradingClosed` gate, so a Locked
market with a week left on its clock reads as Ended everywhere.
