# Glossary — sooth-solana

> Terms used across the program, the SDK, and the frontends.
> One sentence per term unless context is genuinely needed.

## Protocol terms

- **OUTCOME** — Encoding for binary outcomes plus invalid: `NO=0`, `YES=1`, `INVALID=2`.
- **WAD** — Fixed-point precision constant, `1e18`. Internal math (LMSR, fees, position accounting) uses WAD; conversion to token decimals happens at the boundaries.
- **AMM venue** — The bonding phase: an LMSR market maker priced in the deployment's instance token. The devnet deployment fills both venue roles with one mock USDC; the roles stay architecturally distinct.
- **book venue** — The mature phase: the on-chain order book, priced in USDC. Closed until the market graduates.
- **graduation** — The point where accumulated AMM fees reach `b·ln(2)` — the LMSR subsidy the creator posted. Flips `book_enabled` and switches fee distribution to the post-graduation split.
- **subsidy** — The `b·ln(2)` the creator deposits in `seed_lp`. It is what LMSR gives away as liquidity; fees repay it, and `reclaim_subsidy` returns whatever is left after settlement.
- **tick** — Discrete price level on the book: an integer in `[1, 999]` where tick `T` means `T/1000` for YES.
- **single price axis** — The book stores YES prices only; a NO order at price `p` is stored as a YES order at tick `1000 − p`. There is no separate NO book and no "sell" side.
- **seat** — A trader's per-market slot in the book account, holding their credit balance. Cancelling an order returns its escrow to the seat; `book_withdraw` moves seat credit to the wallet. Empty seats are reclaimed.
- **block** — The book arena's allocation unit. Capacity is 4,096 blocks shared between resting orders and seats.
- **Lock-on-Sell** — On an AMM sell, proceeds are credited but locked for a cooldown before withdrawal via `claim_unlocked`.
- **trial period** — Window after creation during which the creator may `dismiss_market` if it has not graduated; dismissed markets refund through `claim_refund`.
- **adjudicator** — The per-market `AdjudicatorEntry` that resolves the market: `request_lock → attest_outcome → (veto window, `dispute`) → settle`.
- **veto window** — `ProtocolConfig.veto_period_secs` between attestation and settlement, during which `dispute` can override the attested outcome. `settle` afterwards is permissionless.
- **tombstone** — The `MKTCLOSD` marker `close_market` leaves in place of a closed market account, so a settled-and-swept market cannot be mistaken for a live one or re-initialized.

## Solana terms

- **PDA** — Program Derived Address. Deterministic address derived from seeds plus program ID; lets a program own an account without a private key. All market and state accounts are PDAs.
- **CPI** — Cross-Program Invocation. `sooth_core` uses it for SPL Token transfers and for `emit_cpi!` self-CPI event records; the protocol's own subsystems call each other as plain Rust.
- **CU** — Compute Unit. Solana's gas equivalent; 200k default per instruction, 1.4M maximum per transaction.
- **heap frame** — The 256 KB region every `sooth_core` transaction must request with `ComputeBudgetInstruction::request_heap_frame`. The program runs a custom bump allocator over it and aborts without the request.
- **zero-copy** — Anchor account mode that reads a large account in place instead of deserializing it. The book account uses it.
- **Sealevel** — Solana's runtime; schedules transactions in parallel by declared account write-locks. Trades on the same market serialize.
- **Anchor** — The Solana program framework used here (0.30.1, with a vendored `anchor-syn` patch for IDL generation on current rustc).
- **IDL** — Anchor-generated JSON describing the program's instructions and account layouts; the EVM analogue is an ABI. There is one, for `sooth_core`.
- **ATA** — Associated Token Account. The canonical per-(wallet, mint) SPL token account.
- **slot** — Solana's unit of time, ~400ms.
- **rent** — Lamports an account holds to stay on-chain, paid at creation and refundable on close. `close_market` reclaims a finished market's rent.

## SDK terms

- **`@sooth/sdk-solana`** — This repo's TypeScript adapter: instruction builders, account readers, PDA helpers, and client-side LMSR quote math.
- **`SoothRequest`** — A built but unsubmitted transaction, returned from `build*` and consumed by `submit()`.
- **`SoothError`** — Tagged union covering SDK errors, with a per-program classifier mapping Anchor error codes onto it.
- **MarketRef** — Opaque, chain-prefixed market identifier (`sol:…`).
- **chain-shim** — The `apps/demo` layer that translates the forked EVM app's hook signatures into SDK calls. Every frontend surface goes through it.
