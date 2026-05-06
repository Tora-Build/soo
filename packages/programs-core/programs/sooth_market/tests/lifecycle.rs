//! Host-side unit tests for `MarketLifecycle::can_transition_to`.
//!
//! These run under regular `cargo test -p sooth_market` (no SBF, no
//! BanksClient) — they exercise the state-machine transition function
//! directly. Integration tests with a live validator stay in
//! `tests/anchor/` (TS) once the workspace has them wired.

use sooth_market::state::MarketLifecycle::{self, *};

#[test]
fn happy_path_transitions() {
    assert!(Initializing.can_transition_to(Open));
    assert!(Open.can_transition_to(Locked));
    assert!(Locked.can_transition_to(Settled));
}

#[test]
fn cannot_skip_states() {
    assert!(!Initializing.can_transition_to(Locked));
    assert!(!Initializing.can_transition_to(Settled));
    assert!(!Open.can_transition_to(Settled));
}

#[test]
fn cannot_go_backwards() {
    assert!(!Open.can_transition_to(Initializing));
    assert!(!Locked.can_transition_to(Open));
    assert!(!Settled.can_transition_to(Locked));
    assert!(!Settled.can_transition_to(Open));
}

#[test]
fn settled_is_terminal() {
    for next in [Initializing, Open, Locked, Settled] {
        assert!(
            !MarketLifecycle::Settled.can_transition_to(next),
            "Settled must be terminal but allowed → {:?}",
            next
        );
    }
}

#[test]
fn no_self_transitions() {
    for s in [Initializing, Open, Locked, Settled] {
        assert!(
            !s.can_transition_to(s),
            "self-transition should be rejected for {:?}",
            s
        );
    }
}
