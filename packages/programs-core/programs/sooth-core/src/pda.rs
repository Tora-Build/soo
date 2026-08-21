//! One way to bring a program-owned PDA into existence.
//!
//! ## Why `create_account` alone is not enough
//!
//! The system program's `CreateAccount` refuses any target that already holds
//! lamports. Every PDA address in this program is derivable off chain —
//! `market_id` is `sha256(question)[..16]` by SDK convention, and every other
//! per-market PDA seeds from that id — so anybody can compute the address a
//! given question WILL land on and send it one lamport. A bare
//! `create_account` then fails forever, and that question can never be asked.
//! The same lamport censors the AMM state, the LP mint, the LP position and
//! the book.
//!
//! ## What this does instead
//!
//! The system program offers the same result through three instructions that
//! do NOT care about an existing balance: `Transfer` the rent shortfall,
//! `Allocate` the space, `Assign` the owner. So:
//!
//! - **empty target** (no lamports): one `CreateAccount`, as before.
//! - **pre-funded target**: top up to rent exemption if short, then allocate
//!   and assign, each signed by the PDA's own seeds.
//!
//! Either way the account ends up rent-exempt, `space` bytes long and owned
//! by `owner`. The griefer's lamport becomes part of the rent the creator
//! would have paid anyway.
//!
//! ## Re-initialization stays impossible
//!
//! Adopting a pre-funded account is only safe because of what this refuses:
//! the target must be owned by the system program AND hold no data. Those two
//! together are reachable only by an account that does not yet exist —
//! `Allocate` and `Assign` both demand the address's own signature, which
//! nothing off chain can produce for a PDA. So a live `Market`, an
//! initialized SPL mint or token account, and the 8-byte tombstone
//! `close_market` leaves behind (owned by this program, so caught by the
//! ownership check) are all rejected here rather than overwritten.
//!
//! That last case is load-bearing: `close_market` relies on the tombstone to
//! poison a spent `market_id` forever, and it used to rely on
//! `create_account`'s lamport check to enforce it. The check now lives here,
//! stated directly instead of inherited as a side effect.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::system_program;

use crate::error::SoothCoreError;

/// How an existing-or-absent target must be brought to life.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PdaInitPlan {
    /// Nothing is there: one `CreateAccount` funds, sizes and assigns it.
    Create { lamports: u64 },
    /// Lamports are already parked at the address. `top_up` is the shortfall
    /// to rent exemption — zero when the balance already covers it, which is
    /// exactly the case where the griefer overpaid.
    Adopt { top_up: u64 },
}

/// Decide between the two paths, or refuse.
///
/// Pure so the decision — the part a lamport can steer — is testable without
/// a validator. `owner_is_system` and `data_len` describe the target at the
/// moment of the call; `required_lamports` is rent exemption for `space`.
pub(crate) fn plan_pda_init(
    owner_is_system: bool,
    data_len: usize,
    current_lamports: u64,
    required_lamports: u64,
) -> Result<PdaInitPlan> {
    // Anything already carrying data, or already assigned away from the
    // system program, is a live account — including this program's own
    // tombstones. Refuse rather than clobber.
    require!(
        owner_is_system && data_len == 0,
        SoothCoreError::PdaAlreadyInitialized
    );
    if current_lamports == 0 {
        Ok(PdaInitPlan::Create {
            lamports: required_lamports,
        })
    } else {
        Ok(PdaInitPlan::Adopt {
            top_up: required_lamports.saturating_sub(current_lamports),
        })
    }
}

/// Create `target` as a rent-exempt, `space`-byte account owned by `owner`,
/// whether or not somebody has already sent it lamports.
///
/// `signer_seeds` are the target PDA's own seeds including its bump: every
/// system instruction here is issued in the PDA's name.
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system_program_ai: &AccountInfo<'info>,
    rent: &Rent,
    space: usize,
    owner: &Pubkey,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    // `.max(1)` mirrors the system program: a zero-lamport account is reaped
    // at the end of the transaction, whatever its size.
    let required = rent.minimum_balance(space).max(1);
    let plan = plan_pda_init(
        target.owner == &system_program::ID,
        target.data_len(),
        target.lamports(),
        required,
    )?;
    let seeds: &[&[&[u8]]] = &[signer_seeds];

    match plan {
        PdaInitPlan::Create { lamports } => invoke_signed(
            &system_instruction::create_account(
                payer.key,
                target.key,
                lamports,
                space as u64,
                owner,
            ),
            &[payer.clone(), target.clone(), system_program_ai.clone()],
            seeds,
        )?,
        PdaInitPlan::Adopt { top_up } => {
            if top_up > 0 {
                // Plain `invoke`: the payer signs the transaction, and the
                // target needs no signature to RECEIVE lamports.
                invoke(
                    &system_instruction::transfer(payer.key, target.key, top_up),
                    &[payer.clone(), target.clone(), system_program_ai.clone()],
                )?;
            }
            invoke_signed(
                &system_instruction::allocate(target.key, space as u64),
                &[target.clone(), system_program_ai.clone()],
                seeds,
            )?;
            invoke_signed(
                &system_instruction::assign(target.key, owner),
                &[target.clone(), system_program_ai.clone()],
                seeds,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RENT: u64 = 1_000_000;

    #[test]
    fn an_absent_account_is_created_outright() {
        assert_eq!(
            plan_pda_init(true, 0, 0, RENT).unwrap(),
            PdaInitPlan::Create { lamports: RENT }
        );
    }

    #[test]
    fn one_lamport_no_longer_censors_the_address() {
        // The whole bug: a single lamport at a derivable PDA used to make
        // `create_account` fail forever. Now it is adopted, and the payer
        // covers the rest of the rent.
        assert_eq!(
            plan_pda_init(true, 0, 1, RENT).unwrap(),
            PdaInitPlan::Adopt { top_up: RENT - 1 }
        );
    }

    #[test]
    fn an_overfunded_address_needs_no_top_up() {
        // Saturating, not wrapping: a griefer who sends MORE than rent must
        // not produce a near-u64::MAX transfer request.
        assert_eq!(
            plan_pda_init(true, 0, RENT * 3, RENT).unwrap(),
            PdaInitPlan::Adopt { top_up: 0 }
        );
        assert_eq!(
            plan_pda_init(true, 0, RENT, RENT).unwrap(),
            PdaInitPlan::Adopt { top_up: 0 }
        );
    }

    #[test]
    fn an_account_this_program_already_owns_is_refused() {
        // A live `Market`, an `AmmState`, an `LpPosition` — and the 8-byte
        // tombstone `close_market` leaves behind, which is what keeps a spent
        // market_id from being resurrected.
        assert!(plan_pda_init(false, 8, RENT, RENT).is_err());
        assert!(plan_pda_init(false, 0, RENT, RENT).is_err());
    }

    #[test]
    fn an_allocated_but_unassigned_account_is_refused() {
        // System-owned with data cannot happen without the address's own
        // signature, so if it is ever observed something is wrong. Refuse.
        assert!(plan_pda_init(true, 165, RENT, RENT).is_err());
    }

    #[test]
    fn refusal_names_the_reinitialization_attempt() {
        let err = plan_pda_init(false, 8, RENT, RENT).unwrap_err();
        assert!(
            format!("{err:?}").contains("PdaAlreadyInitialized"),
            "re-init must fail with its own error, got {err:?}"
        );
    }
}
