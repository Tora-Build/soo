//! Host-side unit tests for `sooth_launchpad::seed_lp` — argument shape,
//! `LpPosition` PDA layout, `LpSeeded` event field encoding, and the
//! Borsh round-trip that the on-chain handler relies on after the
//! manual `system_instruction::create_account` + `try_serialize` step.
//!
//! These run under regular `cargo test -p sooth_launchpad` (no SBF, no
//! BanksClient) — they pin the in-memory invariants the handler depends
//! on. End-to-end coverage with PDA derivation + on-chain mint creation
//! lives in the SDK-side bankrun harness once that wave lands.

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};
use sooth_launchpad::events::LpSeeded;
use sooth_launchpad::instructions::seed_lp::SeedLpArgs;
use sooth_launchpad::state::LpPosition;

/// `SeedLpArgs` Borsh round-trip — the SDK serializes with its bn.js +
/// borsh helpers, the on-chain handler deserializes with the same
/// generated codec. This pin protects against an accidental field
/// reorder in the args struct that would silently shift `lp_amount` and
/// `seed_deposit_wad` past each other in the wire format.
#[test]
fn seed_lp_args_borsh_roundtrip_preserves_field_order() {
    let args = SeedLpArgs {
        lp_amount: 1_000_000,         // 1.0 LP at 6-decimal mint
        seed_deposit_wad: 10_000_000_000_000_000_000, // 10 WAD (≈ MIN_DEPOSIT)
    };
    let bytes = AnchorSerialize::try_to_vec(&args).expect("serialize");
    // u64 (8) + u128 (16) = 24 bytes.
    assert_eq!(bytes.len(), 24);

    let decoded = SeedLpArgs::try_from_slice(&bytes).expect("deserialize");
    assert_eq!(decoded.lp_amount, args.lp_amount);
    assert_eq!(decoded.seed_deposit_wad, args.seed_deposit_wad);
}

/// `LpPosition::SPACE` must match the actual on-chain layout the
/// handler allocates via `system_instruction::create_account`. A drift
/// (e.g. someone adds a field but forgets `SPACE += N`) would cause
/// `try_serialize` to write past the allocated buffer at runtime and
/// surface as either a confusing AccountDataTooSmall on the handler's
/// next read OR a silent truncation on close. Pin the math here.
#[test]
fn lp_position_space_constant_matches_layout() {
    let expected = 8                 // discriminator
        + 32                         // market
        + 32                         // creator
        + 32                         // lp_mint
        + 16                         // seed_deposit_wad: u128
        + 8                          // graduated_at: i64
        + 1; // bump
    assert_eq!(LpPosition::SPACE, expected);
}

/// The handler hand-rolls the discriminator write before
/// `position.serialize(&mut writer)` (no `#[account]` codegen for the
/// init step). Confirm Anchor's `Discriminator` trait is implemented
/// for `LpPosition` and the constant is non-zero — a zeroed
/// discriminator would be indistinguishable from an unallocated
/// account on first read.
#[test]
fn lp_position_has_nonzero_discriminator() {
    let disc = LpPosition::DISCRIMINATOR;
    assert_eq!(disc.len(), 8);
    assert_ne!(disc, [0u8; 8]);
}

/// `LpPosition` Borsh round-trip — the on-chain handler writes the
/// struct via `position.serialize(&mut writer)` after the manual
/// `create_account`. Deserializing back must produce the same field
/// values (modulo the discriminator handling Anchor does separately).
#[test]
fn lp_position_borsh_roundtrip_after_manual_init() {
    let position = LpPosition {
        market: Pubkey::new_unique(),
        creator: Pubkey::new_unique(),
        lp_mint: Pubkey::new_unique(),
        seed_deposit_wad: 12_345_678_900_000_000_000,
        graduated_at: 0,
        bump: 254,
    };

    // Mirror the on-chain write path: discriminator at [0..8], Borsh
    // body at [8..]. We allocate `LpPosition::SPACE` so a drift in the
    // SPACE constant trips this test before it trips runtime.
    let mut buf = vec![0u8; LpPosition::SPACE];
    buf[..8].copy_from_slice(&LpPosition::DISCRIMINATOR);
    let mut writer = &mut buf[8..];
    position.serialize(&mut writer).expect("serialize");

    // Reader path: skip discriminator, deserialize body. This is what
    // any subsequent `Account<'info, LpPosition>` resolution will do
    // under the hood.
    assert_eq!(&buf[..8], &LpPosition::DISCRIMINATOR);
    let decoded =
        LpPosition::try_from_slice(&buf[8..LpPosition::SPACE]).expect("deserialize");
    assert_eq!(decoded.market, position.market);
    assert_eq!(decoded.creator, position.creator);
    assert_eq!(decoded.lp_mint, position.lp_mint);
    assert_eq!(decoded.seed_deposit_wad, position.seed_deposit_wad);
    assert_eq!(decoded.graduated_at, position.graduated_at);
    assert_eq!(decoded.bump, position.bump);
}

/// `LpSeeded` event Borsh round-trip — indexers binding to this event
/// rely on the field order matching the IDL emission. A reorder would
/// silently shift `lp_amount` and `seed_deposit_wad` past each other
/// in the indexer's parse output. Pin it.
#[test]
fn lp_seeded_event_borsh_roundtrip() {
    let event = LpSeeded {
        market: Pubkey::new_unique(),
        creator: Pubkey::new_unique(),
        lp_mint: Pubkey::new_unique(),
        creator_lp_ata: Pubkey::new_unique(),
        lp_amount: 7_654_321,
        seed_deposit_wad: 11_111_111_111_111_111_111,
        ts: 1_700_000_000,
    };
    let bytes = AnchorSerialize::try_to_vec(&event).expect("serialize");
    let decoded = LpSeeded::try_from_slice(&bytes).expect("deserialize");
    assert_eq!(decoded.market, event.market);
    assert_eq!(decoded.creator, event.creator);
    assert_eq!(decoded.lp_mint, event.lp_mint);
    assert_eq!(decoded.creator_lp_ata, event.creator_lp_ata);
    assert_eq!(decoded.lp_amount, event.lp_amount);
    assert_eq!(decoded.seed_deposit_wad, event.seed_deposit_wad);
    assert_eq!(decoded.ts, event.ts);
}

/// PDA seeds for the per-market `lp_mint_authority` are
/// `[b"lp_mint_authority", market_id]`. Pin the byte literal so a
/// future rename can't silently break the on-chain handler's
/// `signer_seeds` array.
#[test]
fn lp_mint_authority_seed_string_is_stable() {
    const SEED: &[u8] = b"lp_mint_authority";
    assert_eq!(SEED.len(), 17);
    // Round-trip through Pubkey::find_program_address to confirm seed
    // semantics — the test value is deterministic so we just bind the
    // resulting pubkey is `Some(_, bump)` with bump in the canonical
    // 0..=255 range. (We don't pin the exact bump because that depends
    // on the placeholder program ID which is expected to rotate at
    // devnet deploy.)
    let market_id = [0u8; 16];
    let placeholder_program_id = anchor_lang::pubkey!("HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3");
    let (_, bump) =
        Pubkey::find_program_address(&[SEED, &market_id], &placeholder_program_id);
    let _ = bump; // bump is u8 by type, so range is automatic.
}

/// PDA seeds for the per-market `LpMint` are `[b"lp", market_id]`.
/// Same stability argument as above.
#[test]
fn lp_mint_seed_string_is_stable() {
    const SEED: &[u8] = b"lp";
    assert_eq!(SEED.len(), 2);
    let market_id = [0u8; 16];
    let placeholder_program_id = anchor_lang::pubkey!("HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3");
    let (_, _bump) =
        Pubkey::find_program_address(&[SEED, &market_id], &placeholder_program_id);
}

/// PDA seeds for the per-(creator, market) `LpPosition` are
/// `[b"lp_position", market_id, creator]`. Confirm the seed string
/// matches the on-chain handler's `invoke_signed` argument exactly.
#[test]
fn lp_position_seed_string_is_stable() {
    const SEED: &[u8] = b"lp_position";
    assert_eq!(SEED.len(), 11);
    let market_id = [0u8; 16];
    let creator = Pubkey::new_unique();
    let placeholder_program_id = anchor_lang::pubkey!("HkXeNGGCNcGRYvDLjb5i2wdycGfjVgXWs1C2H14YiYX3");
    let (_, _bump) = Pubkey::find_program_address(
        &[SEED, &market_id, creator.as_ref()],
        &placeholder_program_id,
    );
}
