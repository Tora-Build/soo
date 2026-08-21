// TypeScript port of `sooth_core`'s `math/{lmsr.rs, wad.rs}`. WAD = 1e18.
//
// It exists so a quote can be computed without a round trip, which means it
// must agree with the on-chain result exactly — a divergence is not a rounding
// difference, it is a trade that quotes one price and settles at another.
//
// Invariants carried over from the Rust:
//
//   - WAD multiplication and division match the Rust 256-bit-intermediate
//     semantics. JS bigint handles arbitrary precision natively, so the
//     limb-based math is collapsed to direct bigint ops; the rounding is
//     toward zero (same as the Rust port's `i128` truncating division).
//
//   - `expWad` saturates the negative tail to 0 past `EXP_MAX_INPUT_WAD`
//     (= 64·WAD). This is what makes the log-sum-exp shifted `lmsrCost`
//     numerically stable on imbalanced markets.
//
//   - The Taylor series term counts (12 for exp, 14 for ln) match the Rust.
//     `tests/lmsr.test.ts` pins the small-buy case
//     `cost_delta(q=0, q=0, b=1000·WAD, d_yes=10·WAD, d_no=0)` to within
//     0.001% of ~5.0125 USDC, the same threshold as the Rust unit test
//     `math/lmsr.rs::cost_delta_golden_small_buy`.

export const WAD = 1_000_000_000_000_000_000n;
export const LN2_WAD = 693_147_180_559_945_309n;

// USDC = 6 decimals, WAD = 18 decimals; the ratio is the WAD↔USDC scalar.
// Architecture decision: reads return WAD; user-paid base-unit USDC is the
// `wadToUsdcCeil` ceiling at trade entry (matches `wad_to_usdc_ceil` in the
// on-chain `wad.rs`).
export const WAD_TO_USDC_SCALAR = 1_000_000_000_000n;

const EXP_MAX_INPUT_WAD = 64n * WAD;
const EXP_TERMS = 12;
const LN_TERMS = 14;

export class LmsrMathError extends Error {
  constructor(msg: string) {
    super(`LmsrMathError: ${msg}`);
    this.name = "LmsrMathError";
  }
}

// ─── WAD primitives ────────────────────────────────────────────────────────

// Truncate-toward-zero division for signed bigints. `bigint / bigint` in JS
// already truncates toward zero (per the ECMAScript spec) so no shim needed.

export function wadMul(a: bigint, b: bigint): bigint {
  // (a * b) / WAD with rounding toward zero. JS bigint is arbitrary precision,
  // so the 256-bit intermediate machinery in the Rust port collapses to a
  // single multiply.
  return (a * b) / WAD;
}

export function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new LmsrMathError("division by zero");
  return (a * WAD) / b;
}

// ─── exp ───────────────────────────────────────────────────────────────────

export function expWad(x: bigint): bigint {
  // Saturate the negative tail. exp(-EXP_MAX_INPUT_WAD) ≈ 1e-28; returning 0
  // keeps log-sum-exp stable for arbitrarily imbalanced markets.
  if (x < -EXP_MAX_INPUT_WAD) return 0n;
  if (x > EXP_MAX_INPUT_WAD) {
    throw new LmsrMathError(`exp_wad input out of domain: ${x}`);
  }
  if (x === 0n) return WAD;

  // Range-reduce: x = k · ln(2) + r, r ∈ [-ln(2)/2, ln(2)/2].
  let k: bigint;
  {
    const half = LN2_WAD / 2n;
    if (x >= 0n) {
      k = (x + half) / LN2_WAD;
    } else {
      k = (x - half) / LN2_WAD;
    }
  }
  const r = x - k * LN2_WAD;

  // Taylor: exp(r) = Σ rⁿ / n!  on the reduced range.
  let term = WAD;
  let sum = WAD;
  for (let n = 1; n <= EXP_TERMS; n++) {
    term = wadMul(term, r);
    term = term / BigInt(n);
    sum = sum + term;
  }

  // Multiply by 2^k. k can be negative.
  if (k >= 0n) {
    const ku = Number(k);
    if (ku >= 127) throw new LmsrMathError(`exp_wad shift overflow: k=${k}`);
    return sum << BigInt(ku);
  } else {
    const ku = Number(-k);
    if (ku >= 127) return 0n;
    return sum >> BigInt(ku);
  }
}

// ─── ln ────────────────────────────────────────────────────────────────────

function bitLen(u: bigint): number {
  // Bit length of a non-negative bigint.
  if (u <= 0n) return 0;
  return u.toString(2).length;
}

export function lnWad(y: bigint): bigint {
  if (y <= 0n) throw new LmsrMathError(`ln_wad of non-positive: ${y}`);
  // y = 2^k · m, m ∈ [WAD, 2·WAD).
  const yu = y;
  const bits = bitLen(yu);
  // WAD bit length is 60.
  const wadBits = bitLen(WAD);
  const k = bits - wadBits;
  let m: bigint;
  if (k >= 0) {
    m = yu >> BigInt(k);
  } else {
    const kk = -k;
    if (kk >= 127) throw new LmsrMathError(`ln_wad shift overflow`);
    m = yu << BigInt(kk);
  }
  // ln(m/WAD) via series on z = (m - WAD) / (m + WAD).
  const mMinus = m - WAD;
  const mPlus = m + WAD;
  const z = wadDiv(mMinus, mPlus);
  const z2 = wadMul(z, z);
  let term = z;
  let sum = z;
  for (let n = 1; n < LN_TERMS; n++) {
    term = wadMul(term, z2);
    const denom = BigInt(2 * n + 1);
    sum = sum + term / denom;
  }
  const lnMOverWad = sum * 2n;
  const kTerm = BigInt(k) * LN2_WAD;
  return kTerm + lnMOverWad;
}

// ─── Cost ──────────────────────────────────────────────────────────────────

// `C(q_yes, q_no, b) = b · ln(exp(q_yes/b) + exp(q_no/b))` with the
// log-sum-exp shift baked in. Inputs/output are WAD-scaled.
export function lmsrCost(qYes: bigint, qNo: bigint, b: bigint): bigint {
  if (b <= 0n) throw new LmsrMathError(`lmsr_cost b must be > 0, got ${b}`);
  const qyOverB = wadDiv(qYes, b);
  const qnOverB = wadDiv(qNo, b);
  const m = qyOverB > qnOverB ? qyOverB : qnOverB;
  const eYes = expWad(qyOverB - m);
  const eNo = expWad(qnOverB - m);
  const sum = eYes + eNo;
  const lnSum = lnWad(sum);
  const inner = m + lnSum;
  return wadMul(b, inner);
}

// `C(q + Δ) - C(q)`. Positive return = user pays this much. Negative = sell
// proceeds.
export function costDelta(
  qYes: bigint,
  qNo: bigint,
  b: bigint,
  dYes: bigint,
  dNo: bigint,
): bigint {
  const before = lmsrCost(qYes, qNo, b);
  const after = lmsrCost(qYes + dYes, qNo + dNo, b);
  return after - before;
}

// Convert a non-negative WAD amount to USDC base units, rounding **up**.
// Mirrors `wad_to_usdc_ceil` in `sooth_core`'s `math/wad.rs`.
export function wadToUsdcCeil(wad: bigint): bigint {
  if (wad < 0n) throw new LmsrMathError(`wad_to_usdc_ceil negative: ${wad}`);
  const s = WAD_TO_USDC_SCALAR;
  return (wad + s - 1n) / s;
}

// Floor variant. Redemption displays round DOWN so a shown payout is never
// larger than the one the vault will actually pay.
export function wadToUsdcFloor(wad: bigint): bigint {
  if (wad < 0n) throw new LmsrMathError(`wad_to_usdc_floor negative: ${wad}`);
  return wad / WAD_TO_USDC_SCALAR;
}

// YES probability after a hypothetical (qYes, qNo, b) state. WAD-scaled.
// p_yes = exp(q_yes/b) / (exp(q_yes/b) + exp(q_no/b)). With log-sum-exp
// shift, p_yes = exp(qy/b - m) / (exp(qy/b - m) + exp(qn/b - m)).
export function yesPriceWad(qYes: bigint, qNo: bigint, b: bigint): bigint {
  if (b <= 0n) throw new LmsrMathError(`yes_price_wad b must be > 0`);
  const qyOverB = wadDiv(qYes, b);
  const qnOverB = wadDiv(qNo, b);
  const m = qyOverB > qnOverB ? qyOverB : qnOverB;
  const eYes = expWad(qyOverB - m);
  const eNo = expWad(qnOverB - m);
  const sum = eYes + eNo;
  if (sum === 0n) return WAD / 2n;
  return wadDiv(eYes, sum);
}
