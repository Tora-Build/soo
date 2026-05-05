//! Spike 1 — LMSR cost function CU benchmark.
//!
//! Bare `solana-program` entrypoint that exposes a single instruction:
//!
//!   `compute_cost_delta { q_yes, q_no, b, side, delta_yes, delta_no }`
//!
//! It computes `C(q + Δ) - C(q)` for the binary-outcome LMSR cost function
//!
//!   C(q_yes, q_no, b) = b · ln( exp(q_yes / b) + exp(q_no / b) )
//!
//! using the WAD fixed-point math in `math.rs`. The result is logged via
//! `sol_log_data` so that `BanksClient::simulate_transaction` can read both
//! the value and the consumed CU count.
//!
//! ## Why an instruction handler and not a CLI
//!
//! `cargo build-sbf` lowers to BPF bytecode that runs in the Solana VM with
//! the same CU metering as production. A native `cargo bench` would not
//! reflect production cost because the BPF VM has its own per-opcode CU
//! schedule (e.g. multiplications are 1 CU on x86 but ~1-2 CU on BPF; memory
//! accesses cost more). The only way to get a faithful number is to actually
//! invoke the program in `solana-program-test`.
//!
//! ## Inputs
//!
//! All values are little-endian-encoded in the instruction data:
//!
//!   offset  size  field
//!   ------  ----  ----------------------
//!   0       16    q_yes      (i128, WAD-scaled shares)
//!   16      16    q_no       (i128, WAD-scaled shares)
//!   32      16    b          (i128, WAD-scaled liquidity parameter, > 0)
//!   48      16    delta_yes  (i128, signed; positive = buy YES)
//!   64      16    delta_no   (i128, signed; positive = buy NO)
//!
//! Total: 80 bytes — well under the 1232-byte tx limit.
//!
//! ## Outputs
//!
//! Logs `cost_delta=<value>` via `msg!`. The bench reads the consumed CU
//! count from the transaction meta, not the log.

#![allow(unexpected_cfgs)]

pub mod math;

use math::{exp_wad, ln_wad, wad_div, wad_mul, MathError};
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg,
    program_error::ProgramError, pubkey::Pubkey,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 80 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let q_yes = i128::from_le_bytes(instruction_data[0..16].try_into().unwrap());
    let q_no = i128::from_le_bytes(instruction_data[16..32].try_into().unwrap());
    let b = i128::from_le_bytes(instruction_data[32..48].try_into().unwrap());
    let d_yes = i128::from_le_bytes(instruction_data[48..64].try_into().unwrap());
    let d_no = i128::from_le_bytes(instruction_data[64..80].try_into().unwrap());

    if b <= 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Cost before: C(q) = b · ln(exp(q_yes/b) + exp(q_no/b))
    let cost_before = lmsr_cost(q_yes, q_no, b).map_err(map_err)?;
    let cost_after = lmsr_cost(q_yes + d_yes, q_no + d_no, b).map_err(map_err)?;
    let delta = cost_after - cost_before;
    msg!("cost_delta={}", delta);
    Ok(())
}

/// `C(q_yes, q_no, b) = b · ln( exp(q_yes / b) + exp(q_no / b) )`
///
/// All inputs and the output are WAD-scaled. The internal scratch values
/// `e_yes`, `e_no` are also WAD-scaled.
///
/// **Numerical note**: we subtract `max(q_yes, q_no) / b` before exp and add
/// it back outside ln (the standard log-sum-exp trick). This keeps both
/// exp arguments ≤ 0 and the sum bounded in [1, 2], so the ln series
/// converges fast and we never overflow exp's input domain even for very
/// imbalanced markets.
#[inline(always)]
pub fn lmsr_cost(q_yes: i128, q_no: i128, b: i128) -> Result<i128, MathError> {
    let qy_over_b = wad_div(q_yes, b)?;
    let qn_over_b = wad_div(q_no, b)?;
    // log-sum-exp shift
    let m = qy_over_b.max(qn_over_b);
    let e_yes = exp_wad(qy_over_b - m)?;
    let e_no = exp_wad(qn_over_b - m)?;
    let sum = e_yes.checked_add(e_no).ok_or(MathError::Overflow)?;
    let ln_sum = ln_wad(sum)?;
    // C = b * (m + ln_sum)
    let inner = m.checked_add(ln_sum).ok_or(MathError::Overflow)?;
    wad_mul(b, inner)
}

fn map_err(e: MathError) -> ProgramError {
    msg!("math error: {:?}", e);
    ProgramError::ArithmeticOverflow
}
