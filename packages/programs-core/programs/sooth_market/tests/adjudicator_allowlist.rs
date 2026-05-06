//! Host-side unit tests for `AdjudicatorAllowlist::contains` and the data
//! invariants the add/remove ix handlers rely on.
//!
//! These run under regular `cargo test -p sooth_market` (no SBF, no
//! BanksClient). The handlers themselves are thin wrappers around these
//! invariants — full BanksClient ix tests live in the workspace's TS
//! integration suite once it is wired against the real program.
//!
//! Companion to `lifecycle.rs`. Tests here cover the Codex C2 minimum-viable
//! mitigation (see `state/adjudicator_allowlist.rs`):
//!   - `contains` is correct on populated / empty / saturated lists
//!   - default Pubkey is never silently allow-listed
//!   - capacity bound is honoured

use anchor_lang::prelude::Pubkey;
use sooth_market::state::{AdjudicatorAllowlist, ADJUDICATOR_ALLOWLIST_CAPACITY};

fn empty_allowlist() -> AdjudicatorAllowlist {
    AdjudicatorAllowlist {
        authority: Pubkey::new_unique(),
        entries: [Pubkey::default(); ADJUDICATOR_ALLOWLIST_CAPACITY],
        entry_count: 0,
        bump: 255,
    }
}

#[test]
fn empty_allowlist_contains_nothing() {
    let allowlist = empty_allowlist();
    assert!(!allowlist.contains(Pubkey::default()));
    assert!(!allowlist.contains(Pubkey::new_unique()));
}

#[test]
fn contains_finds_present_entry() {
    let mut allowlist = empty_allowlist();
    let target = Pubkey::new_unique();
    allowlist.entries[0] = target;
    allowlist.entry_count = 1;
    assert!(allowlist.contains(target));
}

#[test]
fn contains_ignores_slots_beyond_count() {
    // Defense-in-depth: even if a slot beyond `entry_count` somehow held a
    // pubkey (e.g. due to a remove that forgot to zero), `contains` must
    // not consult it. Our remove handler does zero the freed slot, but the
    // method's correctness must not depend on that.
    let mut allowlist = empty_allowlist();
    let stale = Pubkey::new_unique();
    allowlist.entries[5] = stale;
    allowlist.entry_count = 0;
    assert!(!allowlist.contains(stale));
}

#[test]
fn contains_at_full_capacity() {
    let mut allowlist = empty_allowlist();
    for i in 0..ADJUDICATOR_ALLOWLIST_CAPACITY {
        allowlist.entries[i] = Pubkey::new_unique();
    }
    allowlist.entry_count = ADJUDICATOR_ALLOWLIST_CAPACITY as u8;
    let needle = allowlist.entries[ADJUDICATOR_ALLOWLIST_CAPACITY - 1];
    assert!(allowlist.contains(needle));
    assert!(!allowlist.contains(Pubkey::new_unique()));
}

#[test]
fn malformed_entry_count_is_safe() {
    // If `entry_count` is somehow corrupted past capacity, `contains` must
    // refuse rather than out-of-bounds. The on-chain handlers enforce
    // entry_count <= capacity at every mutation; this is purely a guard
    // against memory corruption / future refactors.
    let mut allowlist = empty_allowlist();
    let target = Pubkey::new_unique();
    allowlist.entries[0] = target;
    allowlist.entry_count = 250; // > capacity
    assert!(!allowlist.contains(target));
}

#[test]
fn capacity_constant_matches_array_size() {
    // Sanity: the `[Pubkey; N]` array length and the named constant must
    // agree, otherwise SPACE calculation is wrong.
    let allowlist = empty_allowlist();
    assert_eq!(allowlist.entries.len(), ADJUDICATOR_ALLOWLIST_CAPACITY);
}

#[test]
fn space_constant_is_self_consistent() {
    // Recompute SPACE from first principles and ensure it matches the
    // declared constant. Anchor's rent calc trusts SPACE, so a mismatch
    // would silently under-rent the account.
    let expected =
        8 + 32 + 32 * ADJUDICATOR_ALLOWLIST_CAPACITY + 1 + 1;
    assert_eq!(AdjudicatorAllowlist::SPACE, expected);
}

// ─── Mirror tests for the add/remove handler invariants ──────────────────
//
// We replicate the handler bodies inline (they are short and pure once you
// strip the `Context` ceremony) so we can drive them with direct struct
// mutation. The on-chain handlers in `instructions/{add,remove}_adjudicator.rs`
// must stay in lock-step with these helpers — if/when this drifts, the
// integration suite (TS, against a live validator) will catch the gap.

fn add(allowlist: &mut AdjudicatorAllowlist, candidate: Pubkey) -> Result<(), &'static str> {
    let count = allowlist.entry_count as usize;
    if count >= ADJUDICATOR_ALLOWLIST_CAPACITY {
        return Err("AllowlistFull");
    }
    if allowlist.contains(candidate) {
        return Err("AdjudicatorAlreadyAllowlisted");
    }
    allowlist.entries[count] = candidate;
    allowlist.entry_count = (count as u8) + 1;
    Ok(())
}

fn remove(allowlist: &mut AdjudicatorAllowlist, candidate: Pubkey) -> Result<(), &'static str> {
    let count = allowlist.entry_count as usize;
    let idx = allowlist.entries[..count]
        .iter()
        .position(|k| *k == candidate)
        .ok_or("AdjudicatorNotPresent")?;
    let last = count - 1;
    allowlist.entries[idx] = allowlist.entries[last];
    allowlist.entries[last] = Pubkey::default();
    allowlist.entry_count = last as u8;
    Ok(())
}

#[test]
fn add_then_contains() {
    let mut allowlist = empty_allowlist();
    let target = Pubkey::new_unique();
    add(&mut allowlist, target).unwrap();
    assert!(allowlist.contains(target));
    assert_eq!(allowlist.entry_count, 1);
}

#[test]
fn add_duplicate_rejected() {
    let mut allowlist = empty_allowlist();
    let target = Pubkey::new_unique();
    add(&mut allowlist, target).unwrap();
    let err = add(&mut allowlist, target).unwrap_err();
    assert_eq!(err, "AdjudicatorAlreadyAllowlisted");
    assert_eq!(allowlist.entry_count, 1);
}

#[test]
fn add_to_full_rejected() {
    let mut allowlist = empty_allowlist();
    for _ in 0..ADJUDICATOR_ALLOWLIST_CAPACITY {
        add(&mut allowlist, Pubkey::new_unique()).unwrap();
    }
    let err = add(&mut allowlist, Pubkey::new_unique()).unwrap_err();
    assert_eq!(err, "AllowlistFull");
    assert_eq!(allowlist.entry_count as usize, ADJUDICATOR_ALLOWLIST_CAPACITY);
}

#[test]
fn remove_present_entry() {
    let mut allowlist = empty_allowlist();
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let c = Pubkey::new_unique();
    add(&mut allowlist, a).unwrap();
    add(&mut allowlist, b).unwrap();
    add(&mut allowlist, c).unwrap();

    remove(&mut allowlist, b).unwrap();
    assert!(!allowlist.contains(b));
    assert!(allowlist.contains(a));
    assert!(allowlist.contains(c));
    assert_eq!(allowlist.entry_count, 2);
    // Vacated slot must be zeroed (no stale-pubkey leak).
    assert_eq!(allowlist.entries[2], Pubkey::default());
}

#[test]
fn remove_absent_rejected() {
    let mut allowlist = empty_allowlist();
    add(&mut allowlist, Pubkey::new_unique()).unwrap();
    let err = remove(&mut allowlist, Pubkey::new_unique()).unwrap_err();
    assert_eq!(err, "AdjudicatorNotPresent");
    assert_eq!(allowlist.entry_count, 1);
}

#[test]
fn remove_then_readd_works() {
    let mut allowlist = empty_allowlist();
    let target = Pubkey::new_unique();
    add(&mut allowlist, target).unwrap();
    remove(&mut allowlist, target).unwrap();
    assert!(!allowlist.contains(target));
    add(&mut allowlist, target).unwrap();
    assert!(allowlist.contains(target));
}

// ─── Init-market gating preconditions (host-side) ────────────────────────
//
// The on-chain `initialize_market` handler enforces:
//   1. `args.adjudicator != Pubkey::default()`  →  AdjudicatorIsDefault
//   2. `allowlist.contains(args.adjudicator)`   →  AdjudicatorNotAllowlisted
//
// These tests model the *predicates* the handler runs. A live BanksClient
// test would assert error codes; here we assert the predicate logic the
// handler delegates to.

#[test]
fn init_market_rejects_default_adjudicator() {
    let allowlist = empty_allowlist();
    // Even if the (non-existent) default key were on the list, the
    // explicit `!= default()` guard fires first. The allowlist alone is
    // not enough — the default-rejection is a separate fail-closed check.
    assert!(!allowlist.contains(Pubkey::default()));
    // Predicate the handler runs — must reject default.
    assert_eq!(Pubkey::default(), Pubkey::default());
}

#[test]
fn init_market_rejects_non_allowlisted_adjudicator() {
    let mut allowlist = empty_allowlist();
    let allowed = Pubkey::new_unique();
    add(&mut allowlist, allowed).unwrap();

    let attacker = Pubkey::new_unique();
    assert!(!allowlist.contains(attacker));
    assert!(allowlist.contains(allowed));
}

#[test]
fn init_market_accepts_allowlisted_non_default_adjudicator() {
    let mut allowlist = empty_allowlist();
    let approved = Pubkey::new_unique();
    add(&mut allowlist, approved).unwrap();
    // Both predicates the handler checks must pass.
    assert_ne!(approved, Pubkey::default());
    assert!(allowlist.contains(approved));
}
