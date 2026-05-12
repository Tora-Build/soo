# W9 dispatch — Codex review pass + audit-prep + status update

> Hand this prompt verbatim to Codex in a tmux session started with
> `codex --dangerously-bypass-approvals-and-sandbox`. Stop ONLY after
> all acceptance gates pass AND all commits are made. Print one-line
> per-gate summary plus the final review verdict. Do NOT push, tag,
> --no-verify, amend.

W9 is the audit-prep wave. No new program features. It is a focused review pass over the entire W1–W8 work + the production of audit-ready documentation. The "0 critical / 0 high" verdict per spec §11 W9 is the bar.

**W9 has a hard dependency on W1–W8 all being merged to `main`.** Do NOT launch W9 before then.

Estimated runtime: 40–60 minutes (review reading is dense; documentation writing is precise).

---

## Context (read first, in this order)

1. **`docs/spec/sooth_book.md`** §11 W9 acceptance: "Codex re-review reports 0 critical / 0 high; founder sign-off". §12 risks table is the input — every "Mitigation" column claim must be verifiable against the merged code.
2. **`docs/decision-log.md`** D13–D16 — already committed in earlier waves; W9 verifies they still align with shipped state.
3. **`docs/archive/sooth_book-fork-plan.md`** — already superseded; W9 verifies no new content references it as active.
4. **`docs/status.md`** — needs updating with the v0.4 milestone summary.
5. **Whole merged surface across `main`:**
   - `programs/sooth_book/` — bitmap, matching, MarketBook, BookSide, buy/cancel/compact/close
   - `programs/sooth_market/` — orderbook custody primitives (5 filler-only ix), OrderbookPosition lifecycle (mint/merge/redeem), parent-ix gates (single-load + scan-window helpers, the two together)
   - `programs/sooth_launchpad/` — per-market `distribute_fees` + `distribute_fees_legacy`, `init_market_fee_pool`
   - `programs/sooth_amm/` — buy + sell path fee redirect to per-market pools
   - `packages/sdk-solana/` — adapter cancel rewrite, matching driver, error classifier, PDA helpers
   - `apps/demo/` — chain-shim updates, e2e specs (24 orderbook specs total)

---

## Scope

### A. Review pass — read every changed file since v0.3.1

Boundary: `git diff v0.3.1..HEAD` is the review surface.

For each changed file, classify findings into:

- **Critical** — protocol-breaking bug, security hole, missing parent-ix gate, escrow/payout/fee arithmetic that violates EVM parity, unauthorized state write, fund custody gap. **W9 acceptance fails if any critical finding remains unresolved.**
- **High** — load-bearing invariant relaxed without justification, accounting drift, undocumented deviation from canon, missing test for a documented failure mode. **W9 acceptance fails if any high finding remains unresolved.**
- **Medium** — code quality, test gap on a non-load-bearing path, doc drift, suboptimal CU usage, harness fragility. Logged but not blocking.
- **Low** — style, comment polish, minor refactor opportunity. Logged but not blocking.

Output: `docs/audit-prep/codex-review-{date}.md`, one section per file, each section listing findings by severity. The format:

```markdown
## `path/to/file.rs`

**Critical:** (none) | (list)
**High:** (none) | (list)
**Medium:** (list, brief)
**Low:** (list, brief)
```

If a critical or high finding surfaces, **stop and surface it to founder review** — do NOT silently fix it in W9. W9 is review-only; fixes are a separate post-W9 wave.

### B. Audit-prep notes (4 documents under `docs/audit-prep/`)

#### B.1 `threat-model.md`

Per spec §11 W9. The threat model documents:

- **Trust boundaries**: every program boundary + every cross-program CPI.
- **Account-write authority matrix**: which program owns which PDA + which CPI helpers exist to mutate cross-program state.
- **Parent-ix gate inventory**: every ix that's parent-ix-gated, with the calling program + discriminator allowlist + scan-window vs single-load gate distinction.
- **Sysvar usage**: instruction-sysvar (parent-ix gates), clock (deadline guards).
- **Token vault ownership**: market vault, lock vault, market fee pool, global fee pool — owner PDAs + signing seeds + which programs can sign for each.
- **Known attack vectors and mitigations**:
  - Scan-bypass attack on parent-ix gates → single-load gate for sooth_book CPIs
  - Account-substitution attacks → seeds bindings + `has_one` + program-id pins
  - Fee-rounding griefing → floor-on-sum per §7.3
  - Stale-bitmap race in matching → SDK retry orchestration + hard error path
  - Dust orders → `min_resting_order_for_tick` floor
  - Per-tick saturation → `MAX_ORDERS_PER_TICK=50` cap
  - Init-if-needed audit smell on MarketBook → documented guards (deterministic seeds, first-touch check, end-user payer)

#### B.2 `evm-parity-diff.md`

A line-by-line documented list of every deviation from EVM `SoothBook.sol` + `OrderEngine.sol` + `AMMEngine.sol`. Categorize each as:

- **Forced** (Solana account model, SBF stack budget, writable-account cap): unavoidable architectural difference.
- **Accepted-tradeoff** (rent-pooled BookSide, no per-cancel rent refund, locked-cost vault invariant): documented + intentional.
- **Bug** (unintended divergence): stop and surface; do not paper over.

For each entry: EVM file + line + behavior, Solana file + line + behavior, category, justification or fix-needed flag.

#### B.3 `parent-ix-gate-audit-checklist.md`

A checklist auditors should run through:

1. Every filler-only ix on `sooth_market` calls `require_sooth_book_cpi_parent` at top of body before any state mutation.
2. The single-load gate uses `load_instruction_at_checked(current_index)`, NOT a scan window.
3. The discriminator allowlist for each ix matches the spec §4.2 table exactly.
4. The scan-window helpers (`require_parent_ix_from_program` + `require_adjudicator_parent_ix*`) are used ONLY for AMM/adjudicator flows that need ComputeBudget tolerance.
5. The W2b `transfer_fee_to_market_pool` (AMM-sell-gated) and the W4 `transfer_fee_to_market_pool_from_book` (sooth_book-gated) are correctly differentiated; neither leaks gates to the other family.
6. No filler-only ix accepts a wildcard parent.
7. Negative tests for each gate exist in `tests/sooth_book_cpi_gate.rs` + sister test files.

#### B.4 `fee-flow-rewrite-delta.md`

Documents the buy + sell + per-market + distribute_fees + legacy migration end-to-end:

- Pre-v0.4 (Monaco-era): global `fee_pool_vault`, AMM-only fee accumulation, single `distribute_fees` ix.
- v0.4 shipped: per-market `MarketFeePool` accounts, buy fees from user ATA, sell fees from market vault via vault_authority CPI, orderbook fees from MarketBook accumulator flush via vault_authority CPI, per-market `distribute_fees(market)` crank, one-shot `distribute_fees_legacy` for global drain on rev-deploy day.
- Migration plan: deploy day flow, `init_market_fee_pool` ordering, legacy drain timing.
- Numerical-parity assertions: 4-way bps split byte-identical pre/post-W5.
- Per-market independence: no cross-contamination of fees between markets.

### C. `decision-log.md` — final review

Verify D13–D16 still accurately describe the shipped state. If any text references stale plans, update.

Add a new entry **D17** (or appropriate number — check current state): v0.4 milestone marker. Date, summary, links to W1–W8 PRs.

### D. `status.md` update

Update `docs/status.md` to reflect:

- v0.3.1 → v0.4 milestone transition
- Program counts: 5 programs, 5/5 shipped (sooth_book now production-ready post-W8)
- Test counts: cargo tests, SDK vitest, e2e count (all post-W8)
- CI status: orderbook E2E gate green
- Devnet redeploy status (probably "pending W9 sign-off + faucet")
- Known open items: zkTLS deferred, T\* deferred, three-outcome MAYBE not implemented

### E. `sooth_book/fork-plan.md` supersession verification

Already done in earlier waves (file is in `docs/archive/`). W9 only verifies:

- Archive banner intact
- No remaining cross-references from active docs to the archived plan path
- `docs/archive/README.md` accurately catalogues the supersession reason

### F. Codex re-review verdict

After producing all of A–E, emit a final summary:

```
W9 verdict:
  Critical: <count>
  High: <count>
  Medium: <count>
  Low: <count>
  Reviewed files: <count> over <KB> diff
  Acceptance: PASS / FAIL (FAIL if any critical or high unresolved)
```

If FAIL, the diff produced by W9 is the audit-prep docs only; founder gets a separate handoff to address findings.

---

## Acceptance gates

```bash
NO_DNA=1 cargo check --workspace
NO_DNA=1 cargo check --workspace --features mainnet
NO_DNA=1 cargo test --workspace
cd packages/sdk-solana && NO_DNA=1 pnpm test
cd apps/demo && NO_DNA=1 pnpm typecheck
NO_DNA=1 anchor build

# W9 also gates on its own output
test -f docs/audit-prep/threat-model.md
test -f docs/audit-prep/evm-parity-diff.md
test -f docs/audit-prep/parent-ix-gate-audit-checklist.md
test -f docs/audit-prep/fee-flow-rewrite-delta.md
test -f docs/audit-prep/codex-review-*.md
```

The Codex re-review verdict must be 0 critical + 0 high to pass W9.

---

## Out of scope

- Devnet redeploy.
- v0.4.0 tag (founder's call, post-sign-off).
- Mainnet deployment.
- Audit RFP (separate process).

---

## Operational rules

- Branch: `feat/sooth_book-w9-audit-prep` off current `main` (W1–W8 must be merged first).
- Suggested commit split:
  1. `docs(audit-prep): threat model`
  2. `docs(audit-prep): EVM-parity diff`
  3. `docs(audit-prep): parent-ix gate audit checklist`
  4. `docs(audit-prep): fee-flow rewrite delta`
  5. `docs(audit-prep): Codex review pass — file-by-file findings`
  6. `docs: bump status.md for v0.4 milestone`
  7. `docs: decision-log entry for v0.4 milestone`
- **Do NOT push, tag, amend, use `--no-verify`.** `NO_DNA=1` prefix.
- **Critical / high findings stop-and-surface to founder review**, NOT silently fix in W9. W9 is review-only.

## When done

Print the final verdict block plus one-line per-gate pass/fail summary. **Commit the work** — don't leave the working tree dirty. Stop.
