use anchor_lang::prelude::Pubkey;

// ── Base token mint ──────────────────────────────────────────────────────
// The program ID is registered by `declare_id!` in lib.rs; use Anchor's
// `crate::ID` where the program's own pubkey is needed.

/// Canonical mainnet USDC mint. Used when built with `--features mainnet`.
pub const USDC_MINT_MAINNET: Pubkey =
    anchor_lang::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Project-controlled mock USDC on devnet (decision D19).
///
/// Devnet uses a project-controlled mock rather than Circle's devnet USDC
/// (`4zMMC9srt…`), which is only obtainable through faucet.circle.com —
/// captcha + GitHub-auth gated, with no programmatic call — and so makes demo
/// and e2e funding flows impossible to automate. Mainnet uses real Circle
/// USDC.
///
/// Authority: `apps/demo/.localnet/mint-authority.json`
/// (`EXJ7ZiAXvSpNGzhHEFBewUaJ4fdZtAfuFBRhYsQPV5Y9`, untracked — back it up,
/// losing it means minting stops and this constant has to change again).
///
/// Pinned by `address = BOOK_TOKEN_MINT` account constraints throughout the
/// program, so a mismatch is a hard transaction failure, not a UI
/// inconsistency — every off-chain reference must move in lockstep, and
/// changing it requires redeploying the program.
pub const USDC_MINT_DEVNET: Pubkey =
    anchor_lang::pubkey!("ByF1KoXgDS4hyLmqYh28Gm9s2HoxouAA1VStuKC4hErX");

// ── The two venue tokens ─────────────────────────────────────────────────
//
// One deployment, two currencies: the AMM (incubation) trades in the
// deployment's own token, the orderbook (mature venue) in USDC. See
// `docs/design/dual-token-venues.md`.
//
// Both are compile-time constants, which is the strongest form of "set once at
// deployment" — not storage, not governance-writable. Changing either means
// recompiling and redeploying, and every market on a deployment shares the
// pair. The consequence, accepted deliberately: **one program deployment per
// instance**. Two instances with different AMM tokens are two program IDs.
//
// The names are ROLES, never tickers. Which token fills the AMM role is a
// per-deployment decision and not the program's business.

/// The AMM venue's token. Pinned by `address = AMM_TOKEN_MINT` constraints on
/// every AMM path, so a mismatch is a hard transaction failure rather than a
/// UI inconsistency.
///
/// This deployment fills BOTH venue roles with the same mock USDC: bonding
/// prices, LP subsidies and book collateral are all one token, so the UI has
/// one faucet and one balance. The dual-venue architecture is unchanged —
/// the roles stay distinct in every account and instruction, and a mainnet
/// instance may fill them with two different mints again.
#[cfg(feature = "mainnet")]
pub const AMM_TOKEN_MINT: Pubkey =
    compile_error!("set AMM_TOKEN_MINT for mainnet before building with --features mainnet");
#[cfg(not(feature = "mainnet"))]
pub const AMM_TOKEN_MINT: Pubkey = USDC_MINT_DEVNET;

/// The orderbook venue's token: real USDC on mainnet, the project mock on
/// devnet.
#[cfg(feature = "mainnet")]
pub const BOOK_TOKEN_MINT: Pubkey = USDC_MINT_MAINNET;
#[cfg(not(feature = "mainnet"))]
pub const BOOK_TOKEN_MINT: Pubkey = USDC_MINT_DEVNET;

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
//
// `claim_refund` reads a `Position` out of the raw account buffer rather than
// through `Account<Position>`, because it closes the account itself. These
// offsets are that parser's map, derived as a chain so a field's length and
// the offsets after it cannot disagree. `state/position.rs` pins
// `POSITION_TOTAL_LEN` against `Position::SPACE` at compile time.

pub const POSITION_DISCRIMINATOR_LEN: usize = 8;
pub const POSITION_USER_LEN: usize = 32;
pub const POSITION_MARKET_LEN: usize = 32;
pub const POSITION_YES_SHARES_LEN: usize = 16;
pub const POSITION_NO_SHARES_LEN: usize = 16;
pub const POSITION_LOCKED_COST_USDC_LEN: usize = 8;
pub const POSITION_LOCK_NONCE_LEN: usize = 8;
pub const POSITION_BUMP_LEN: usize = 1;
pub const POSITION_RESERVED_LEN: usize = 32;

pub const POSITION_USER_OFFSET: usize = POSITION_DISCRIMINATOR_LEN;
pub const POSITION_MARKET_OFFSET: usize = POSITION_USER_OFFSET + POSITION_USER_LEN;
pub const POSITION_YES_SHARES_OFFSET: usize = POSITION_MARKET_OFFSET + POSITION_MARKET_LEN;
pub const POSITION_NO_SHARES_OFFSET: usize = POSITION_YES_SHARES_OFFSET + POSITION_YES_SHARES_LEN;
pub const POSITION_LOCKED_COST_USDC_OFFSET: usize =
    POSITION_NO_SHARES_OFFSET + POSITION_NO_SHARES_LEN;
pub const POSITION_LOCK_NONCE_OFFSET: usize =
    POSITION_LOCKED_COST_USDC_OFFSET + POSITION_LOCKED_COST_USDC_LEN;
pub const POSITION_BUMP_OFFSET: usize = POSITION_LOCK_NONCE_OFFSET + POSITION_LOCK_NONCE_LEN;
pub const POSITION_RESERVED_OFFSET: usize = POSITION_BUMP_OFFSET + POSITION_BUMP_LEN;
pub const POSITION_TOTAL_LEN: usize = POSITION_RESERVED_OFFSET + POSITION_RESERVED_LEN;

/// Serialized length of a `LockEntry` account, discriminator included.
/// Pinned against `LockEntry::SPACE` by a compile-time assert in
/// `state/lock_entry.rs`, so the struct cannot outgrow the buffer live
/// accounts already have.
pub const LOCK_ENTRY_TOTAL_LEN: usize = 8   // discriminator
    + 32                                     // user
    + 32                                     // market
    + 8                                      // amount_usdc
    + 8                                      // unlock_at
    + 8                                      // nonce
    + 1                                      // bump
    + 32; // _reserved

/// Serialized length of a `ProtocolConfig` account, discriminator included.
/// Pinned against `ProtocolConfig::SPACE` the same way.
pub const PROTOCOL_CONFIG_TOTAL_LEN: usize = 8 // discriminator
    + 32                                        // authority
    + 32                                        // treasury
    + 2 * 7                                     // three rate fields + four share bps
    + 8                                         // default_trial_period
    + 1                                         // bump
    + 1                                         // paused
    + 1                                         // permissionless_adjudicators
    + 8                                         // veto_period_secs
    + 32                                        // pending_authority
    + 28; // _reserved

const _: () = assert!(POSITION_TOTAL_LEN == 153);
const _: () = assert!(LOCK_ENTRY_TOTAL_LEN == 129);
const _: () = assert!(PROTOCOL_CONFIG_TOTAL_LEN == 165);

/// Longest question `create_market` will accept, in bytes.
///
/// The text rides in the instruction and again in `MarketCreated`, so it is
/// bounded twice over: to keep the transaction inside its size limit, and to
/// keep the event small enough that a client can read it back off the
/// creation transaction. 300 bytes comfortably fits the phrasing real
/// prediction markets use.
pub const MAX_QUESTION_LEN: usize = 300;
