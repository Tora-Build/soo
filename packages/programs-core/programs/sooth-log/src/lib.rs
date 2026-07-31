//! `sooth_log` — durable event sink for `sooth_core`.
//!
//! A no-op program whose only purpose is to be *invoked*. Solana has no cheap
//! equivalent of an EVM `emit`: Anchor's `emit!` writes to program logs, which
//! the runtime truncates and RPC providers drop, so it cannot be relied on for
//! indexing. `emit_cpi!` is durable but allocates per event, and the P0.1
//! spike established that it OOMs the multi-fill `buy` path — the bump
//! allocator never frees mid-instruction, so even the batched form died with
//! zero events emitted.
//!
//! The surviving design (main's P0.1-A) is this: serialize the event once and
//! `invoke` it into a separate no-op program. The payload is then permanently
//! recorded as an **inner instruction** of the transaction, where an indexer
//! reads it out of `meta.innerInstructions` — durable, untruncated, and
//! allocation-cheap.
//!
//! ## Why a separate program
//!
//! A program cannot CPI into itself, so the sink cannot live inside
//! `sooth_core` however much the 5→1 merge would prefer it. This is the one
//! place the single-program architecture cannot reach.
//!
//! ## Authenticity is NOT established here
//!
//! `log` takes no accounts and no signer, so anyone can invoke it with any
//! bytes. A consumer must verify that the inner instruction is a direct child
//! of a successful top-level `sooth_core::buy` — i.e. check the
//! `innerInstructions` group index and the parent instruction's program id and
//! discriminator. Without that check, `OrdersFilled` records are trivially
//! spoofable, which is a live defect in main's `sooth-data` decoder
//! (`decode-ordersfilled.ts` implements none of it).

use anchor_lang::prelude::*;

// Repointed from 6TVeQ2JzYUXNsUG7kJpGvQ2Y6kKCxNkkAWSFrEG4vb59, whose program
// keypair we never had. That address IS deployed on devnet, but under upgrade
// authority G4DaWiBYJGRnE5apgMem92Zk5qW4wJkr4BJwN3ZfhVzg — a key that exists
// nowhere in this repo or on the deploying machine. So it could be neither
// upgraded nor redeployed, and `anchor build` had been generating a DIFFERENT
// keypair (this one) into target/deploy, which Anchor's runtime
// `program_id == crate::ID` check then rejected. Every localnet/Surfpool deploy
// of sooth_log failed on that mismatch.
//
// This id matches target/deploy/sooth_log-keypair.json, backed up alongside
// the others. ~1.24 SOL remains stranded in the old programdata account.
declare_id!("2NqmnxEMGeAmvThiXGtGWQBAHY58CG3pogfF4E8xAWVr");

#[program]
pub mod sooth_log {
    use super::*;

    /// Record `data` as an inner instruction. `data` carries
    /// `[8-byte event discriminator][borsh-encoded event]`.
    pub fn log(_ctx: Context<Log>, _data: Vec<u8>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Log {}
