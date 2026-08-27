# Adjudication roadmap — what Solana inherits from the EVM design

The EVM predecessor (sooth-alpha) accumulated a taxonomy of adjudication
mechanisms; this plan orders their inheritance onto Solana. Ordering forces:
demo value per hackathon week, one program change per week maximum (each
means redeploy + vendored-IDL refresh + VPS SDK rebuild, all append-only),
and composability with the reputation system shipped in week 3.

## Phase 1 — Bonded optimistic adjudication (first)

The biggest missing trust model, and the one whose design already exists
(EVM spec: round ids, pull-based bond withdrawal, conservation invariant
`deposited = returned + slashed + claimable`). Minimal viable scope:

- `OptimisticProposal` PDA per market — append-only, no existing account
  changes. `propose(outcome, bond)` permissionless post-deadline; USDC bond
  escrowed. `challenge(bond)` within a window escalates to the market's
  registered adjudicator as arbiter, riding the existing attest/settle
  rails. Unchallenged → `finalize`, bond returns. Challenged → arbiter
  rules, loser's bond pays the winner.
- Reputation integration is the point: a lost challenge is an ON-CHAIN
  wrongness verdict — the correctness signal manual vetoes cannot provide.
  New scored cases: proposalUpheld +8, proposalSlashed -15, challengeWon
  +10, challengeLost -10.
- Cut-line under time pressure: fixed bond, single round, no re-proposals.

## Phase 2 — Guardian hardening (one deploy, two changes)

- Guardian SET instead of the single `dispute_authority` (single point of
  capture today).
- Veto reverts to re-resolution instead of overriding to an outcome — the
  EVM guardian can reject, never decide. Safer power, and it completes the
  reputation model: a re-ruling agreeing with the veto vindicates it,
  giving manual markets the correct/wrong veto grading zk markets already
  have.

## Phase 3 — mainnet runway, in order

1. M-of-N attestation quorum (committee precondition; multi-attestor zkTLS)
2. Per-market frozen timeout buffers (no retroactive governance)
3. Adjudicator fee competition (the 1% vs 2.5% market from EVM)
4. T* retroactive settlement + Merkle payout root (the differentiator)
5. External adapters: UMA-style escalation, on-chain-event proofs

## Explicitly not inherited

EVM's pluggable adjudicator-CONTRACT architecture. Cross-program adjudicator
plugins would cost CPI complexity the modes-in-one-program design does not
need: every mechanism above fits as a mode.
