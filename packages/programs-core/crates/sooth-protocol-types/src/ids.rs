//! Cross-program `Pubkey` constants — program IDs and the canonical USDC
//! mint.
//!
//! Each program's `declare_id!(...)` in its own `lib.rs` is the address-of-
//! truth that Anchor uses for IDL emission and ix dispatch. The constants
//! here mirror those values so that other programs can pin them in
//! `address = ...`, `seeds::program = ...`, `owner = ...`, and parent-ix
//! introspection without taking a path-dep on the foreign program (which
//! would either close a cycle or pull entrypoint codegen across crate
//! boundaries).
//!
//! Each program carries `const _: () = assert!(...)` checks tying its own
//! `crate::ID_CONST` back to the constant here, so any drift trips the
//! build rather than producing a runtime `ConstraintAddress` /
//! `ConstraintOwner` failure on chain.

use anchor_lang::prelude::Pubkey;

/// `sooth_amm` program ID. Mirrors `sooth_amm::declare_id!`. Used by
/// `sooth_market`'s `transfer_to_lock` / `transfer_from_lock_vault` to
/// verify the `Position` / `LockEntry` accounts they receive are owned by
/// the legitimate AMM program, and by parent-ix introspection on those
/// helpers.
pub const SOOTH_AMM_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("67zS8M81LATLxEgegm5jyYgwFYNTfbF3FnYqxjbZKp7k");

/// `sooth_market` program ID. Mirrors `sooth_market::declare_id!`.
pub const SOOTH_MARKET_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("ByhA86BqTTrsZBDjSURWjRncojE6p7sxUqcWmHxfdd2n");

/// `sooth_launchpad` program ID. Mirrors `sooth_launchpad::declare_id!`.
/// Used by `sooth_amm::trade_positions` to bind the `protocol_config` PDA's
/// owner + derivation to the canonical launchpad singleton (see the
/// `seeds::program` / `owner` constraints there).
pub const SOOTH_LAUNCHPAD_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3");

/// `sooth_adjudicator` program ID. Mirrors `sooth_adjudicator::declare_id!`.
/// Used by `sooth_market::lock_for_resolution` / `settle` for the parent-ix
/// introspection auth path (the call-time half of Codex's C2 mitigation).
pub const SOOTH_ADJUDICATOR_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("4fifRPBFebS12impdMvQGKZ9WZ96GgUunrw6iEx3KKV8");

/// Canonical devnet USDC mint, pinned on every `usdc_mint` Accounts entry
/// across the AMM/market/launchpad. Mainnet uses `EPjFW...`; the SDK swaps
/// the constant per cluster at deploy time.
pub const USDC_MINT_DEVNET: Pubkey =
    anchor_lang::pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
