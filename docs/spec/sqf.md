# SQF — Sooth Question Format (Solana mapping)

> Status: **shipped (TS)**; on-chain question-string mapping deferred.
> Canon law: [`law/question-format.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/question-format.md).
> Reference implementation: [`apps/demo/src/lib/sqf.ts`](../../apps/demo/src/lib/sqf.ts).
> Companion: shared with EVM via canon; the EVM-side parser is the demo's vendored copy.

---

## 1. What this spec covers

SQF is the canonical structured encoding for human-readable market metadata
— question text, resolution rule, event id, category, and free-form meta —
that travels with every market. It is host-neutral: the same parser and
emitter work on EVM, Solana, and TON.

This Solana-side spec describes:

- The local implementation (parser + generator + safe parse + extract).
- The on-chain storage path (currently `question_hash` only; full-string
  storage deferred).
- The deviations from canon law and how the SDK + demo work around them.

For the format itself (grammar, section semantics, parser/generator rules,
canon field mapping), refer to canon `law/question-format.md`. This
document does NOT restate the format — it documents the Solana host's
implementation of it.

## 2. Status

| Surface                                | Status                                         |
| -------------------------------------- | ---------------------------------------------- |
| Parser (`parseSQF`)                    | shipped in `apps/demo/src/lib/sqf.ts:24-93`    |
| Generator (`generateSQF`)              | shipped in `apps/demo/src/lib/sqf.ts:98-139`   |
| Safe parse (`parseSQFSafe`)            | shipped — accepts legacy plain-text questions  |
| Extract question (`extractQuestion`)   | shipped — first-line accessor for UIs          |
| SDK adapter integration                | not yet — adapter currently passes raw string  |
| On-chain full SQF in `Market.question` | not yet — `Market` stores `question_hash` only |
| Off-chain SQF registry / cache         | not yet — apps render from off-chain feed      |

## 3. Solana implementation

### 3.1 File location

`apps/demo/src/lib/sqf.ts` is the production Solana implementation. It is
vendored from the EVM reference. The two files MUST stay byte-identical
within the grammar handling — diverging silently is the worst-case bug
(canon's "host leakage rule" forbids unilateral SQF parser changes).

### 3.2 Surface

```ts
interface SQFRule {
  description?: string;
  [key: string]: string | undefined;  // arbitrary lowercase ASCII keys
}

interface SQFData {
  question: string;
  rule: SQFRule;
  event?: string;
  category?: string;
  meta?: Record<string, string>;
}

parseSQF(raw: string): SQFData
parseSQFSafe(raw: string): SQFData    // backwards-compat for plain-text
generateSQF(data: SQFData): string
extractQuestion(raw: string): string  // first §question line, or raw if untagged
```

All four functions are pure. No state, no async, no IO.

### 3.3 Parser disambiguation rule

The single non-obvious rule (per `apps/demo/src/lib/sqf.ts:52-54`):

```ts
if (
  colonIdx > 0 &&
  !line.startsWith("http") &&
  /^[a-z][a-z0-9-]*:/.test(line)
) {
  // key:value line
}
```

A line is a `§rule` key-value only when it matches `^[a-z][a-z0-9-]*:`
**and** does not begin with `http`. Otherwise it is treated as part of
`rule.description`. This protects URLs (which contain `:`) from being
split by the parser. Per canon law, this disambiguation is canonical.

## 4. On-chain storage model

### 4.1 Current state

`sooth_market::Market` stores **`question_hash`**, not the full SQF string.
The hash is a 32-byte keccak256 of the original question text, computed
off-chain at market creation and committed in
`sooth_market::instructions::initialize_market`.

```rust
// packages/programs-core/programs/sooth_market/src/state/...
pub struct Market {
    // ...
    pub question_hash: [u8; 32],
    // ...
}
```

This is a deliberate Solana-side decision: Solana account rent is paid
per byte, and storing the full SQF string (typically 100–500 bytes) would
add per-market rent without on-chain semantic value (the chain never
reads the question text).

### 4.2 Deviation from canon

Canon `law/question-format.md` says "Hosts must serialize the
`market.question` storage field as the full SQF string. Hosts must not
split SQF sections across multiple storage fields."

Solana's `question_hash`-only model is a **`partial-conformance`
deviation**:

| Field             | Canon expected                        | Solana actual       |
| ----------------- | ------------------------------------- | ------------------- |
| `market.question` | Full SQF string on-chain              | 32-byte keccak hash |
| `market.rule`     | Parsed from `§rule` in stored SQF     | Off-chain only      |
| `market.event_id` | Parsed from `§event` in stored SQF    | Off-chain only      |
| `market.category` | Parsed from `§category` in stored SQF | Off-chain only      |
| `market.meta`     | Parsed from `§meta` in stored SQF     | Off-chain only      |

The deviation should be filed in `host-kb/solana/deviations.json` once
that file exists. Severity: `accepted-tradeoff`. Justification: Solana
rent-per-byte makes on-chain string storage economically wasteful when
indexers can serve the full string off-chain. Remediation plan:
`track-for-future-canon-change` (canon may want to formalize a
hash-on-chain + string-off-chain split as a host-allowed configuration).

### 4.3 Off-chain feed (recommended path forward)

When the full-SQF-on-chain gap is closed via an off-chain feed, the
expected shape is a registry account or indexer endpoint keyed by
`market_id`:

```text
GET /markets/{market_id}/question  →  full SQF string
```

The on-chain `question_hash` then verifies the off-chain string:
`keccak256(string) == on_chain_hash`. Apps that don't trust the feed can
recompute and compare. This preserves canon's spirit (full SQF available
to UIs) without paying rent for unread bytes.

This feed does not yet exist. Open work item per `docs/roadmap.md`.

## 5. SDK adapter integration

### 5.1 Current state

`packages/sdk-solana` currently reads `Market.question_hash` and exposes
it raw in market snapshots. The adapter does NOT parse SQF — that
happens in `apps/demo` (the consumer).

### 5.2 Expected post-feed integration

Once the off-chain feed lands:

```ts
// packages/sdk-solana/src/adapter.ts (planned)
async readSnapshot(marketRef: MarketRef): Promise<Snapshot> {
  // ... existing reads ...
  const rawSqf = await this.questionFeed?.fetch(marketRef.marketId);
  const parsed = rawSqf ? parseSQFSafe(rawSqf) : undefined;
  return {
    // ...
    question_hash: market.question_hash,
    question: parsed?.question,
    rule: parsed?.rule,
    event_id: parsed?.event,
    category: parsed?.category,
    meta: parsed?.meta,
  };
}
```

The `parseSQFSafe` path preserves backwards compatibility: untagged
plain-text questions pass through as `{ question: raw, rule: {} }`.

## 6. Cross-host parity

| Concern                     | EVM                                            | Solana                         | TON                                                                         |
| --------------------------- | ---------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Storage of full SQF         | on-chain string in `TruthMarket.question`      | off-chain feed (hash on-chain) | `offchainMetadata.{question, deadline}` flat sidecar; SQF migration pending |
| Parser canonicalness        | `apps/demo` TS impl (shared via `sooth-alpha`) | same TS impl, vendored         | TS impl in `sooth-ton` SDK; not yet aligned                                 |
| Legacy plain-text questions | accepted via `parseSQFSafe`                    | accepted via `parseSQFSafe`    | accepted (no SQF parsing yet)                                               |

The three hosts agree on the parser; they differ on storage. Canon's
host-leakage rule explicitly allows this kind of storage divergence as
long as the wire format (the SQF string itself) round-trips identically.

## 7. Forbidden shortcuts

- Do **not** modify `apps/demo/src/lib/sqf.ts` parser semantics
  unilaterally. The parser is canon-owned (per
  `law/question-format.md`); changes require a canon edit and synchronized
  updates across all hosts.
- Do **not** store SQF fields split across multiple Solana account
  fields (e.g. a separate `rule` PDA). Canon forbids this.
- Do **not** drop the `parseSQFSafe` backwards-compat path. Legacy
  plain-text questions must continue to work.
- Do **not** lowercase keys silently in `meta` when re-emitting. Preserve
  insertion order and case per canon's parser rules.
- Do **not** treat `question_hash` as opaque without recomputing against
  the off-chain string when present. The hash is a verification anchor,
  not a substitute.

## 8. Out of scope

- On-chain full-string storage (will require a separate `MarketMetadata`
  PDA or string-bearing extension; rent-cost analysis owed)
- Pluggable adjudicator metadata fields (`§rule adjudicator:<type-id>`
  conventions). Reserved for future canon extension.
- Cross-host meta-key namespace (`§meta source:`, `§meta ui-color:`).
  Canon does not yet standardize these; hosts may emit and consume
  freely.

## 9. Cross-references

- Canon law: [`law/question-format.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/question-format.md)
- Implementation: [`apps/demo/src/lib/sqf.ts`](../../apps/demo/src/lib/sqf.ts)
- Canon decision: `sooth-canon` `DECISIONS.md` 0013 (SQF promotion to canon law)
- Market storage: [`sooth_market.md`](./sooth_market.md) §3.2 (`Market.question_hash`)
