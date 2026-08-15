# SQF — Sooth Question Format on Solana

> Subsystem: market question text — `create_market` argument, `MarketCreated`
> event, and the TypeScript parser/generator.
> Canon law: [`law/question-format.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/question-format.md).

---

## 1. What this spec covers

SQF is the structured encoding for human-readable market metadata — question
text, resolution rule, event id, category, free-form meta — carried in a single
string. It is host-neutral: the same grammar is used on EVM and Solana.

This spec covers the Solana host's handling of that string: how it reaches the
chain, how it is proven, where it can be read back from, and where the parser
lives. It does not restate the grammar; canon `law/question-format.md` owns
that.

## 2. On-chain model

`create_market` takes the question **text**, not just a hash:

```rust
pub struct CreateMarketArgs {
    pub market_id: [u8; 16],
    pub question: String,
    pub question_hash: [u8; 32],
    pub start_time: i64,
    pub deadline: i64,
    pub adjudicator: Pubkey,
    pub initial_b: u128,
}
```

The handler enforces two things before anything is written
(`instructions/create_market.rs`):

```rust
require!(
    !args.question.is_empty() && args.question.len() <= MAX_QUESTION_LEN,
    SoothCoreError::InvalidQuestion
);
require!(
    hash(args.question.as_bytes()).to_bytes() == args.question_hash,
    SoothCoreError::QuestionHashMismatch
);
```

`hash` is `solana_program::hash::hash`, i.e. **sha256**. `MAX_QUESTION_LEN` is
`300` bytes (`constants.rs`) — the text rides in the instruction and again in
the event, so it is bounded twice over: to keep the transaction inside its size
limit and the event inside what a client can read back off the creation
transaction.

Where the text ends up:

| Location                | Content                             |
| ----------------------- | ----------------------------------- |
| `Market.question_hash`  | 32-byte sha256 digest               |
| `MarketCreated.question` | the full string                    |
| `Market` account body   | nothing else — the text is not persisted |

The `Market` account stores only the digest; rent is paid per byte and the
program never reads the text. The `MarketCreated` event is the one place on
chain where the words exist, and the hash check above is what makes that event
trustworthy: without it a creator could commit the hash of one question and
broadcast the text of another.

### 2.1 Deterministic market ids

The SDK derives `market_id` from the question by default: the first 16 bytes of
`sha256(question)` (`sdk-solana/src/adapter.ts`, `buildCreateMarket`). One
question, one market — a second create of the same text fails at account init,
and any client can derive the market PDA from the words alone, which makes
wizard-created markets discoverable without a registry or indexer. Callers that
genuinely want two markets with identical text pass an explicit `marketId`.

`buildCreateMarket` rejects a missing question outright: a market created from a
bare hash has no recoverable title.

## 3. Reading the question back

`SolanaChainAdapter.readMarketQuestion(market, { maxPages })`:

1. Walks `getSignaturesForAddress` on the market PDA to the **oldest**
   signature (creation is the oldest write to that account).
2. Fetches that transaction and scans `Program data:` log lines for a decoded
   `MarketCreated` event.
3. Recomputes `sha256(question)` and compares against the stored
   `question_hash`, returning the text only on a match.

Step 3 is not redundant. Decoding an event of a different layout against this
schema does not fail — it reads a length prefix out of unrelated bytes and hands
back binary garbage that is still a `string`. The stored hash is an independent
witness.

This is a transaction-history read, not an index. It is bounded by `maxPages`
(default 5 × 1000 signatures); a market with more traffic than that returns
`undefined` rather than a wrong answer, and callers should cache what they find.

## 4. Parser and generator

`apps/demo/src/lib/sqf.ts` is the TypeScript implementation, vendored from the
EVM reference:

```ts
interface SQFRule {
  description?: string;
  [key: string]: string | undefined; // arbitrary lowercase ASCII keys
}

interface SQFData {
  question: string;
  rule: SQFRule;
  event?: string;
  category?: string;
  meta?: Record<string, string>;
}

parseSQF(raw: string): SQFData
parseSQFSafe(raw: string): SQFData    // untagged plain text → { question: raw, rule: {} }
generateSQF(data: SQFData): string
extractQuestion(raw: string): string  // first §question line, or raw if untagged
```

All four are pure — no state, no async, no IO. `generateSQF` is what the demo's
market-creation wizard feeds into `buildCreateMarket`; `parseSQFSafe` is what
rendering paths call, so plain-text questions keep working.

### 4.1 Parser disambiguation rule

The one non-obvious rule: a line inside `§rule` is a key-value pair only when it
matches `^[a-z][a-z0-9-]*:` **and** does not start with `http`. Otherwise it
joins `rule.description`. This is what keeps URLs (which contain `:`) from being
split. The rule is canon-owned; the two host copies must not diverge.

## 5. Constraints

- The 300-byte cap applies to the **whole SQF string**, not just the first line.
  A verbose `§rule` section can push a question over the limit; the wizard has to
  budget for it.
- The parser is canon-owned. Changing `sqf.ts` grammar handling unilaterally
  forks the format; it requires a canon edit and a synchronized update on every
  host.
- `parseSQFSafe`'s plain-text fallback is load-bearing for markets created
  before the wizard emitted SQF.
- Treating `question_hash` as authoritative and the event text as advisory is
  the correct trust order — always verify the text against the hash before
  displaying or caching it.

## 6. Cross-references

- Canon law: [`law/question-format.md`](https://github.com/Tora-Build/sooth-canon/blob/main/law/question-format.md)
- Parser: [`apps/demo/src/lib/sqf.ts`](../../apps/demo/src/lib/sqf.ts)
- Creation path: [`sooth_launchpad.md`](./sooth_launchpad.md) §3
- Decision log: D24 (the question text lives on chain)
