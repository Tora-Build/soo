# Spike 1 — LMSR CU budget

> **Question**: does `sooth_amm::trade_positions` LMSR cost-delta fit in Solana's compute-unit budget?
> **Targets**: <=300k CU per typical buy, <=500k CU on tail (very imbalanced markets).
> **Source spec**: `packages/programs-core/docs/architecture.md` §5 and §13.

This is a throwaway prototype. Bare `solana-program` (no Anchor) so the CU figure isolates the LMSR math from framework overhead. The crate is excluded from the workspace via `[workspace]` in its own `Cargo.toml`.

## Layout

```
_spikes/lmsr-cu/
  Cargo.toml          # bare solana-program, no Anchor
  src/
    lib.rs            # entrypoint: compute_cost_delta(q_yes, q_no, b, Δyes, Δno)
    math.rs           # WAD (1e18) fixed-point exp/ln
                      #   variant A (default) = Taylor exact, ~1e-12 rel err
                      #   variant B (--features lut) = LUT approx, sketch only
  tests/
    cu_bench.rs       # solana-program-test (BanksClient) bench grid
```

## Math model

Standard binary-outcome LMSR cost function:

```
C(q_yes, q_no, b) = b · ln(exp(q_yes / b) + exp(q_no / b))
```

`trade_positions` charges `C(q + Δ) - C(q)`, signed (positive = cost, negative = proceeds for sells).

We use the standard **log-sum-exp shift**: subtract `max(q_yes/b, q_no/b)` before exp, add it back after ln. Keeps both exp arguments ≤ 0, sum bounded in [1, 2], series converges quickly, no overflow even for 100×-imbalanced markets.

WAD = 1e18 to match EVM `LMSRMath.sol` semantics. All values are `i128`; intermediate `u256` for `wad_mul` / `wad_div` is hand-rolled via two `u128` limbs (no `ethnum` dep — keeps the BPF binary lean and the build fast).

## Toolchain

- Solana CLI **3.0.13** (Agave), platform-tools **v1.51** — what `cargo build-sbf --version` reports on the dev machine.
- `solana-program` and `solana-program-test` pinned to **1.18** (most recent stable that the local cargo-build-sbf accepts cleanly).
- Rust 1.95.

## Run

```bash
cd _spikes/lmsr-cu
cargo build-sbf
cargo test-sbf -- --nocapture
```

`cargo test-sbf` builds the SBF program and runs the BanksClient bench, printing `compute_units_consumed` per case.

To try the LUT variant once it's implemented:

```bash
cargo test-sbf --features lut -- --nocapture
```

## Bench grid

| case                               | what it tests                           |
| ---------------------------------- | --------------------------------------- |
| cold-start (q=0, buy 1% of b YES)  | first ix; one-time loader cost included |
| small (delta = 1% of b)            | typical retail buy                      |
| medium (delta = 10% of b)          | larger LP buy                           |
| large (delta = 50% of b)           | whale move                              |
| imbalanced (q_yes = 10× q_no, +1%) | mid-tail                                |
| tail (q_yes = 100× q_no, +1%)      | extreme — nearly resolved market        |
| sell (delta = -10% of b)           | exits a position                        |
| two-sided (+5% YES, -5% NO)        | combined ix                             |

## Results

> Captured with `cargo test-sbf -- --nocapture` on the toolchain above.

```
=========================================================================
LMSR cost-delta CU bench  (target: <=300k typical, <=500k tail)
=========================================================================
case                                                CU
-------------------------------------------------------------------------
cold-start  (q=0, buy 1% of b YES)               42898
small       (delta = 1%  of b)                   44468
medium      (delta = 10% of b)                   46823
large       (delta = 50% of b)                   48847
imbalanced  (q_yes=10x q_no, +1%)                55467
tail        (q_yes=100x q_no, +1%)               32768
sell        (delta = -10% of b)                  46771
two-sided   (Δyes=+5%, Δno=-5%)                  46752
-------------------------------------------------------------------------
```

(Each row is `compute_units_consumed` from BanksClient transaction meta. CU
budget on the test transaction was 1.4M to capture the true cost; subtract
~150 CU for the leading `ComputeBudget` instruction to get the LMSR-only
number.)

### Headline

**Peak: ~55k CU. Floor: ~33k CU. All cases pass with a 4–5x margin under the
300k typical target and an order of magnitude under the 500k tail target.**

The "tail" case (q*yes = 100× q_no) is paradoxically \_cheaper* than the
imbalanced 10× case because the log-sum-exp shift makes the smaller side's
exp argument fall below the EXP_MAX_INPUT_WAD clamp, returning 0 immediately
without running the Taylor series. So extreme imbalance is essentially free.
Mid-imbalance (10×) is the actual worst case in this grid.

### What this means for production `sooth_amm::trade_positions`

A real `trade_positions` adds (rough estimate):

- ~5–10k CU for account validation (raw `solana-program`; less than Anchor)
- ~10–14k CU for 2× `spl-token::transfer` CPI (vault in + LP mint out)
- ~5k CU for fee router math + state writes

Total realistic envelope: **~75–80k CU per trade**. That leaves >120k CU of
headroom under the 200k default per-instruction limit. We do **not** need to
set `ComputeBudgetInstruction::set_compute_unit_limit` on every trade in
production. The `cost_wad` calc, the singular concern of architecture §5, is
not the bottleneck.

### Build status

Built and ran cleanly on the dev machine. Solana CLI 3.0.13 / platform-tools
v1.51 / Rust 1.95. The crates.io dependency tree required pinning a few
edition2024-tainted transitive deps because platform-tools ships an older
cargo (1.84.0):

```bash
cargo update -p proc-macro-crate@3.5.0 --precise 3.2.0
cargo update -p blake3 --precise 1.5.5
cargo update -p tempfile --precise 3.10.1
cargo update -p indexmap@2.14.0 --precise 2.6.0
```

The resulting `Cargo.lock` is committed alongside this spike for
reproducibility.

## Mitigation tree (if we miss the budget)

Per architecture doc §5, in order of preference:

1. **Approximation tables (variant B)** — pre-computed exp/ln LUTs with linear interp. Sketch is in `src/math.rs`. Expected ~5x reduction in math CU at ~1e-6 relative error, well below USDC dust precision (USDC has 6 decimal places; `_wadToUsdc` rounds anyway).
2. **Crank pattern** — split cost calc into two transactions (compute → settle). Hurts UX (two signatures) but uncaps CU per ix.
3. **Drop LMSR for constant-product (xy=k)** — major economic redesign. Last resort.

Recommendation thresholds:

- All cases ≤ 300k → **proceed** to `sooth_amm` production. **(this is what we observed.)**
- Some > 300k but all ≤ 500k → **proceed** but flag for variant B optimization in v2.
- Any > 500k → **implement variant B** before proceeding; re-bench.
- Variant B still > 500k → **escalate** to crank pattern or LMSR-drop discussion.

### Actual recommendation

Proceed to production `sooth_amm`. The Taylor exact variant (variant A) is
fast enough that the LUT approximation (variant B) is unnecessary — keep it
as a documented escape hatch in case a future Anchor port and CPI overhead
push us closer to the budget, but don't build it on the critical path.

## Notes for reviewers

- `process_instruction` does no account loads, no CPIs, no token transfers. Production `trade_positions` adds:
  - ~5-10k CU for Anchor account validation (or less for raw `solana-program`),
  - ~5-7k CU per `spl-token::transfer` CPI (we'll have 2-4 of these),
  - ~2-5k CU for fee router math.
  - **Total non-LMSR overhead**: ~30-40k CU.
- So if the bench reports `X` CU for the math, real `trade_positions` is `X + ~35k`.
- Don't over-fit to these numbers — `cargo build-sbf` LLVM inlining can shift the result ±10% across compiler versions.
