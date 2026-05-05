//! CU benchmark for the LMSR cost-delta instruction.
//!
//! Run with: `cargo test-sbf -- --nocapture`
//!
//! The bench grid covers:
//!   - cold start (first invocation; loader overhead is one-shot but counted)
//!   - small trade  (delta = 1% of b)
//!   - medium trade (delta = 10% of b)
//!   - large trade  (delta = 50% of b)
//!   - tail: very imbalanced q (q_yes / q_no ratio of 100x)
//!
//! Each row prints `compute_units_consumed` from BanksClient transaction meta.
//! The numeric result of the LMSR isn't asserted here — `src/math.rs` unit
//! tests cover correctness. This file is purely about CU.

use solana_program_test::{processor, ProgramTest};
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const WAD: i128 = 1_000_000_000_000_000_000;

fn encode(q_yes: i128, q_no: i128, b: i128, d_yes: i128, d_no: i128) -> Vec<u8> {
    let mut data = Vec::with_capacity(80);
    data.extend_from_slice(&q_yes.to_le_bytes());
    data.extend_from_slice(&q_no.to_le_bytes());
    data.extend_from_slice(&b.to_le_bytes());
    data.extend_from_slice(&d_yes.to_le_bytes());
    data.extend_from_slice(&d_no.to_le_bytes());
    data
}

#[tokio::test(flavor = "current_thread")]
async fn bench_cu_grid() {
    let program_id = Pubkey::new_unique();
    let pt = ProgramTest::new(
        "lmsr_cu_spike",
        program_id,
        processor!(lmsr_cu_spike::process_instruction),
    );

    let (mut banks_client, payer, recent_blockhash) = pt.start().await;

    // (label, q_yes, q_no, b, d_yes, d_no)
    let b1k: i128 = 1_000 * WAD; // 1000-share liquidity (small market)
    let cases: Vec<(&str, i128, i128, i128, i128, i128)> = vec![
        ("cold-start  (q=0, buy 1% of b YES)", 0, 0, b1k, b1k / 100, 0),
        ("small       (delta = 1%  of b)",     500 * WAD, 500 * WAD, b1k, b1k / 100, 0),
        ("medium      (delta = 10% of b)",     500 * WAD, 500 * WAD, b1k, b1k / 10,  0),
        ("large       (delta = 50% of b)",     500 * WAD, 500 * WAD, b1k, b1k / 2,   0),
        ("imbalanced  (q_yes=10x q_no, +1%)", 10_000 * WAD, 1_000 * WAD, b1k, b1k / 100, 0),
        ("tail        (q_yes=100x q_no, +1%)", 100_000 * WAD, 1_000 * WAD, b1k, b1k / 100, 0),
        ("sell        (delta = -10% of b)",    500 * WAD, 500 * WAD, b1k, -b1k / 10, 0),
        ("two-sided   (Δyes=+5%, Δno=-5%)",    500 * WAD, 500 * WAD, b1k, b1k / 20, -b1k / 20),
    ];

    println!();
    println!("=========================================================================");
    println!("LMSR cost-delta CU bench  (target: <=300k typical, <=500k tail)");
    println!("=========================================================================");
    println!("{:<40}  {:>12}", "case", "CU");
    println!("-------------------------------------------------------------------------");

    for (label, q_yes, q_no, b, d_yes, d_no) in cases {
        let data = encode(q_yes, q_no, b, d_yes, d_no);
        let ix = Instruction {
            program_id,
            accounts: vec![],
            data,
        };
        // Bump the CU limit to 1.4M so we observe true cost even if the math
        // exceeds the default 200k. The bench reports actual consumption.
        let cu_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
        let tx = Transaction::new_signed_with_payer(
            &[cu_ix, ix],
            Some(&payer.pubkey()),
            &[&payer as &Keypair],
            recent_blockhash,
        );
        let sim = banks_client
            .simulate_transaction(tx)
            .await
            .expect("simulate ok");
        let units = sim
            .simulation_details
            .as_ref()
            .map(|d| d.units_consumed)
            .unwrap_or(0);
        println!("{:<40}  {:>12}", label, units);
    }

    println!("-------------------------------------------------------------------------");
    println!("Subtract ~150 CU for the ComputeBudget ix; the rest is the LMSR call.");
    println!();
}
