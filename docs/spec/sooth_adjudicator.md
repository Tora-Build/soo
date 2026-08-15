# Adjudicator — resolution, veto, settlement

> Subsystem: `state/adjudicator.rs` and
> `instructions/{register_adjudicator, request_lock, lock_for_resolution,
> attest_outcome, dispute, settle}.rs`.
> Canon law: [`law/adjudicator.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/adjudicator.md).

---

## 1. What this covers

How a market's outcome is decided and finalized: who may attest it, how long
the attestation stays open to a veto, and who may close it out. Resolution
authority is a per-market `AdjudicatorEntry` PDA — there is no global
allowlist and no separate adjudicator program.

The trial-expiry path is different and runs elsewhere: a market that never
graduates is closed by `dismiss_market` and refunded through `claim_refund`
(see [`sooth_market.md`](./sooth_market.md)).

## 2. `AdjudicatorEntry` — one per market

**Seeds:** `[ADJUDICATOR_ENTRY_SEED, market]`.

| Field                | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `market`             | backlink to the `Market` PDA                                              |
| `authority`          | may call `request_lock` and `attest_outcome`; must be non-default          |
| `dispute_authority`  | may call `dispute`; defaults to `authority` at registration                |
| `attested_outcome`   | `Option<u8>` — `0=NO`, `1=YES`, `2=INVALID`                                |
| `attested_at`        | timestamp of the attestation                                              |
| `disputed`           | one-shot guard; a second dispute is rejected                              |
| `disputed_at`        | timestamp of the veto                                                     |

The account carries forward-compat padding, so adding a field consumes reserved
bytes instead of changing the account length — no migration.

## 3. The path

```text
register_adjudicator → request_lock → attest_outcome → [veto window] → settle
                                             ↑                  │
                                             └──── dispute ─────┘
```

1. **`register_adjudicator(authority)`** creates the entry. Who may sign depends
   on `ProtocolConfig.permissionless_adjudicators`: when set, the market's own
   creator registers; when clear, only `ProtocolConfig.authority` may. The flag
   means "the creator, not an admin" — never "anybody".
2. **`request_lock`** moves the market `Open → Locked`, and only once
   `now >= market.deadline`. Authority-gated. (`lock_for_resolution` is a second
   authority-gated path to the same transition; it emits `MarketLocked` but
   carries no deadline check.)
3. **`attest_outcome(winning_outcome)`** records the outcome on the entry and
   emits `OutcomeAttested`. It does **not** settle: the market stays `Locked`
   and enters the attested state for `ProtocolConfig.veto_period_secs`.
4. **`dispute(new_outcome)`** overrides the recorded outcome while the market is
   still `Locked` and the attestation is younger than the veto window. One shot
   per market. It does not settle either, so the lifecycle changes in exactly
   one place.
5. **`settle`** finalizes after the window closes, emits `MarketSettled`, and
   opens the redeem paths.

## 4. Why attest and settle are separate

`dispute` requires both an attested entry and a not-yet-settled market.
Collapsing attestation and settlement into one transaction leaves no market ever
in both states at once, so every dispute fails with `MarketAlreadySettled` or
`NotYetAttested` and the veto belongs to nobody. Splitting them makes the veto
real, and it matches the EVM contract, where `resolve` and a permissionless
`settle` sit either side of `vetoEndsAt`.

`settle` is **permissionless** and takes **no outcome argument**:

- Permissionless, because the outcome is already fixed on the entry and settle
  only moves the lifecycle. Requiring the adjudicator to return would make every
  redemption depend on one key staying live.
- No argument, because the attested value is the only thing that may be
  finalized. Accepting an outcome from the caller would make the veto window
  meaningless — you could dispute the attestation and settle something else
  anyway.

## 5. Constraints

- **`veto_period_secs` is a config field**, bounded `0 < x <= 30 days`. Zero is
  rejected rather than read as "no window", because an omitted `i64` encodes as
  `0`; a deployment that wants no delay passes `1`.
- **The veto is one key.** `dispute_authority` defaults to `authority`. Widening
  it to a guardian set is open work.
- **Resolution is two transactions with a wait between them.** Anything that
  attests and then redeems must call `settle` in between.
- **The heap frame is mandatory**, as on every `sooth_core` instruction — see
  [`README.md`](./README.md).

## 6. Out of scope

- zkTLS and other automated adjudicator variants. Only the manual path exists.
- Retroactive `T*` settlement and `invalidate()` parity.

## 7. Cross-references

- Decision log: D18 (attest split from settle behind a veto window)
- Sibling specs: [`sooth_market.md`](./sooth_market.md),
  [`sooth_launchpad.md`](./sooth_launchpad.md)
