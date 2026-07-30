use anchor_lang::prelude::Pubkey;

// ── Base token mint ──────────────────────────────────────────────────────
// The program ID is registered by `declare_id!` in lib.rs; use Anchor's
// `crate::ID` where the program's own pubkey is needed.

/// Canonical mainnet USDC mint. Used when built with `--features mainnet`.
pub const USDC_MINT_MAINNET: Pubkey =
    anchor_lang::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Project-controlled mock USDC on devnet (decision D19).
///
/// This overrides the original "no need for our own mock; use real USDC"
/// decision. Circle's devnet USDC (`4zMMC9srt…`) is only obtainable through
/// faucet.circle.com — captcha + GitHub-auth gated, with no programmatic call
/// — which makes demo and e2e funding flows impossible to automate. Mainnet
/// remains real Circle USDC.
///
/// Authority: `apps/demo/.localnet/mint-authority.json`
/// (`EXJ7ZiAXvSpNGzhHEFBewUaJ4fdZtAfuFBRhYsQPV5Y9`, untracked — back it up,
/// losing it means minting stops and this constant has to change again).
///
/// This is deliberately NOT main's mint. main pinned
/// `H7hBn9A1MDuKLhLji26bkRv5P3zMnp9jQmxNo76wsGyK`, which does exist on devnet
/// with ~1.3M supply, but its authority (`6PfiTm…`) lives only in main's
/// untracked `.localnet/` and was never shared. Without it no new tokens can
/// be minted, so devnet funding was impossible — a mint you cannot mint from
/// is worse than a fresh one. The cost of diverging is that devnet token
/// balances are not shared between the two branches.
///
/// Note this is pinned by `address = BASE_TOKEN_MINT` account constraints
/// throughout the program, so a mismatch is a hard transaction failure, not a
/// UI inconsistency — every off-chain reference must move in lockstep, and
/// changing it requires redeploying the program.
pub const USDC_MINT_DEVNET: Pubkey =
    anchor_lang::pubkey!("ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX");

#[cfg(feature = "mainnet")]
pub const BASE_TOKEN_MINT: Pubkey = USDC_MINT_MAINNET;
#[cfg(not(feature = "mainnet"))]
pub const BASE_TOKEN_MINT: Pubkey = USDC_MINT_DEVNET;

/// Default guardian-veto window: how long an attested outcome stays open to
/// `dispute` before `settle` may finalize it.
///
/// Matches the EVM deployment, where the guardian "can veto incorrect
/// settlements within 24 hours" and `settle(market)` is permissionless once
/// `vetoEndsAt` has passed.
///
/// This is only the suggested default for `initialize_protocol` callers — the
/// live value is `ProtocolConfig.veto_period_secs`. It is configuration, not a
/// constant, precisely so a localnet deployment can run a short window without
/// building a different binary than the one that reaches devnet.
pub const DEFAULT_VETO_PERIOD_SECS: i64 = 24 * 60 * 60;

/// Upper bound on `ProtocolConfig.veto_period_secs`. A veto window longer than
/// this would strand every redemption on a market behind an unreachable
/// settle; 30 days is far past any legitimate guardian response time.
pub const MAX_VETO_PERIOD_SECS: i64 = 30 * 24 * 60 * 60;

// ── Account byte-offset constants ────────────────────────────────────────
// Used by SPACE assertions in state types and by raw-parse helpers.

pub const POSITION_DISCRIMINATOR_LEN: usize = 8;
pub const POSITION_USER_LEN: usize = 32;
pub const POSITION_MARKET_LEN: usize = 32;
pub const POSITION_YES_SHARES_LEN: usize = 16;
pub const POSITION_NO_SHARES_LEN: usize = 16;
pub const POSITION_LOCKED_COST_USDC_LEN: usize = 8;
pub const POSITION_LOCK_NONCE_LEN: usize = 8;
pub const POSITION_BUMP_LEN: usize = 1;

pub const POSITION_USER_OFFSET: usize = POSITION_DISCRIMINATOR_LEN;
pub const POSITION_MARKET_OFFSET: usize = POSITION_USER_OFFSET + POSITION_USER_LEN;
pub const POSITION_YES_SHARES_OFFSET: usize = POSITION_MARKET_OFFSET + POSITION_MARKET_LEN;
pub const POSITION_NO_SHARES_OFFSET: usize = POSITION_YES_SHARES_OFFSET + POSITION_YES_SHARES_LEN;
pub const POSITION_LOCKED_COST_USDC_OFFSET: usize =
    POSITION_NO_SHARES_OFFSET + POSITION_NO_SHARES_LEN;
pub const POSITION_LOCK_NONCE_OFFSET: usize =
    POSITION_LOCKED_COST_USDC_OFFSET + POSITION_LOCKED_COST_USDC_LEN;
pub const POSITION_BUMP_OFFSET: usize = POSITION_LOCK_NONCE_OFFSET + POSITION_LOCK_NONCE_LEN;
pub const POSITION_TOTAL_LEN: usize = POSITION_BUMP_OFFSET + POSITION_BUMP_LEN;

pub const LOCK_ENTRY_DISCRIMINATOR_LEN: usize = 8;
pub const LOCK_ENTRY_USER_LEN: usize = 32;
pub const LOCK_ENTRY_MARKET_LEN: usize = 32;
pub const LOCK_ENTRY_AMOUNT_USDC_LEN: usize = 8;
pub const LOCK_ENTRY_UNLOCK_AT_LEN: usize = 8;
pub const LOCK_ENTRY_NONCE_LEN: usize = 8;
pub const LOCK_ENTRY_BUMP_LEN: usize = 1;

pub const LOCK_ENTRY_USER_OFFSET: usize = LOCK_ENTRY_DISCRIMINATOR_LEN;
pub const LOCK_ENTRY_MARKET_OFFSET: usize = LOCK_ENTRY_USER_OFFSET + LOCK_ENTRY_USER_LEN;
pub const LOCK_ENTRY_AMOUNT_USDC_OFFSET: usize = LOCK_ENTRY_MARKET_OFFSET + LOCK_ENTRY_MARKET_LEN;
pub const LOCK_ENTRY_UNLOCK_AT_OFFSET: usize =
    LOCK_ENTRY_AMOUNT_USDC_OFFSET + LOCK_ENTRY_AMOUNT_USDC_LEN;
pub const LOCK_ENTRY_NONCE_OFFSET: usize = LOCK_ENTRY_UNLOCK_AT_OFFSET + LOCK_ENTRY_UNLOCK_AT_LEN;
pub const LOCK_ENTRY_BUMP_OFFSET: usize = LOCK_ENTRY_NONCE_OFFSET + LOCK_ENTRY_NONCE_LEN;
pub const LOCK_ENTRY_TOTAL_LEN: usize = LOCK_ENTRY_BUMP_OFFSET + LOCK_ENTRY_BUMP_LEN;

pub const PROTOCOL_CONFIG_DISCRIMINATOR_LEN: usize = 8;
pub const PROTOCOL_CONFIG_AUTHORITY_LEN: usize = 32;
pub const PROTOCOL_CONFIG_TREASURY_LEN: usize = 32;
pub const PROTOCOL_CONFIG_FEE_BPS_LEN: usize = 2;
pub const PROTOCOL_CONFIG_B_BASE_SHARE_BPS_LEN: usize = 2;
pub const PROTOCOL_CONFIG_LP_YIELD_SHARE_BPS_LEN: usize = 2;
pub const PROTOCOL_CONFIG_ADJUDICATOR_SHARE_BPS_LEN: usize = 2;
pub const PROTOCOL_CONFIG_PROTOCOL_SHARE_BPS_LEN: usize = 2;
pub const PROTOCOL_CONFIG_DEFAULT_TRIAL_PERIOD_LEN: usize = 8;
pub const PROTOCOL_CONFIG_BUMP_LEN: usize = 1;
pub const PROTOCOL_CONFIG_PAUSED_LEN: usize = 1;
pub const PROTOCOL_CONFIG_PERMISSIONLESS_ADJUDICATORS_LEN: usize = 1;
pub const PROTOCOL_CONFIG_VETO_PERIOD_SECS_LEN: usize = 8;

pub const PROTOCOL_CONFIG_AUTHORITY_OFFSET: usize = PROTOCOL_CONFIG_DISCRIMINATOR_LEN;
pub const PROTOCOL_CONFIG_TREASURY_OFFSET: usize =
    PROTOCOL_CONFIG_AUTHORITY_OFFSET + PROTOCOL_CONFIG_AUTHORITY_LEN;
pub const PROTOCOL_CONFIG_FEE_BPS_OFFSET: usize =
    PROTOCOL_CONFIG_TREASURY_OFFSET + PROTOCOL_CONFIG_TREASURY_LEN;
pub const PROTOCOL_CONFIG_B_BASE_SHARE_BPS_OFFSET: usize =
    PROTOCOL_CONFIG_FEE_BPS_OFFSET + PROTOCOL_CONFIG_FEE_BPS_LEN;
pub const PROTOCOL_CONFIG_LP_YIELD_SHARE_BPS_OFFSET: usize =
    PROTOCOL_CONFIG_B_BASE_SHARE_BPS_OFFSET + PROTOCOL_CONFIG_B_BASE_SHARE_BPS_LEN;
pub const PROTOCOL_CONFIG_ADJUDICATOR_SHARE_BPS_OFFSET: usize =
    PROTOCOL_CONFIG_LP_YIELD_SHARE_BPS_OFFSET + PROTOCOL_CONFIG_LP_YIELD_SHARE_BPS_LEN;
pub const PROTOCOL_CONFIG_PROTOCOL_SHARE_BPS_OFFSET: usize =
    PROTOCOL_CONFIG_ADJUDICATOR_SHARE_BPS_OFFSET + PROTOCOL_CONFIG_ADJUDICATOR_SHARE_BPS_LEN;
pub const PROTOCOL_CONFIG_DEFAULT_TRIAL_PERIOD_OFFSET: usize =
    PROTOCOL_CONFIG_PROTOCOL_SHARE_BPS_OFFSET + PROTOCOL_CONFIG_PROTOCOL_SHARE_BPS_LEN;
pub const PROTOCOL_CONFIG_BUMP_OFFSET: usize =
    PROTOCOL_CONFIG_DEFAULT_TRIAL_PERIOD_OFFSET + PROTOCOL_CONFIG_DEFAULT_TRIAL_PERIOD_LEN;
pub const PROTOCOL_CONFIG_PAUSED_OFFSET: usize =
    PROTOCOL_CONFIG_BUMP_OFFSET + PROTOCOL_CONFIG_BUMP_LEN;
pub const PROTOCOL_CONFIG_PERMISSIONLESS_ADJUDICATORS_OFFSET: usize =
    PROTOCOL_CONFIG_PAUSED_OFFSET + PROTOCOL_CONFIG_PAUSED_LEN;
pub const PROTOCOL_CONFIG_VETO_PERIOD_SECS_OFFSET: usize =
    PROTOCOL_CONFIG_PERMISSIONLESS_ADJUDICATORS_OFFSET
        + PROTOCOL_CONFIG_PERMISSIONLESS_ADJUDICATORS_LEN;
pub const PROTOCOL_CONFIG_TOTAL_LEN: usize =
    PROTOCOL_CONFIG_VETO_PERIOD_SECS_OFFSET + PROTOCOL_CONFIG_VETO_PERIOD_SECS_LEN;

const _: () = assert!(POSITION_TOTAL_LEN == 121);
const _: () = assert!(LOCK_ENTRY_TOTAL_LEN == 97);
const _: () = assert!(PROTOCOL_CONFIG_TOTAL_LEN == 101);
