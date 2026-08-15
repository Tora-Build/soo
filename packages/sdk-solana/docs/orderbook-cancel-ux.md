# Order Book — Cancel, Credit, and Rent

Two things happen when you cancel a resting order, and neither is the one people
expect from the AMM.

## Cancelling returns money to your seat, not your wallet

`book_cancel` unlinks the order and refunds its escrow to **your seat credit**
inside the book account. No tokens move. To get them into a real token account
you call `book_withdraw`, which pays out the whole credit balance in a single
transfer.

That indirection is the point. A seat is a slot in the market's one book
account, so a fill can credit a maker without touching a maker token account —
which is what makes a fill cost **zero extra accounts and zero extra transaction
bytes**, and lets one transaction cross hundreds of orders instead of five. The
same ledger that receives fill proceeds receives cancel refunds.

Practical consequences:

- **Cancel and withdraw are separate steps.** A UI that shows a balance change
  after cancel is showing seat credit, not a wallet balance. Surface both, or
  chain `buildBookWithdraw` behind the cancel.
- **Batch it.** `buildBookCancelMany` cancels up to `MAX_CANCELS_PER_TX` (24)
  orders in one transaction; one `book_withdraw` afterwards settles all of them.
- **Neither is gated.** Cancel and withdraw ignore the protocol pause and the
  market lifecycle. They are exit paths, and cancel is the only way to recover
  escrow from an order still resting after settlement — `redeem_book_seat`
  deliberately leaves resting orders alone.

## Rent is per market, not per order

Placing an order costs no rent, and cancelling refunds none.

Orders and seats are 64-byte blocks in one arena inside the market's `Book`
account. Rent for that account is paid by whoever calls `book_init` and
`book_grow` — permissionless instructions that anyone may call, typically the
market creator or the first maker to need the space. Cancelling returns the
block to the account's internal free list so the next order reuses it; the
account itself never shrinks.

Seats are reclaimed the same way: `book_withdraw` and `redeem_book_seat` free a
seat block once its credit and net exposure are both zero.

So there is no per-order rent to refund, and no `close`-style instruction to
call. The account's rent comes back once, at the end of the market's life:
`close_market` reclaims it after checking that the book carries no live orders
and no seat with credit or exposure.

This is the opposite trade from the AMM, where a `LockEntry` is its own account
and `claim_unlocked` closes it and refunds the rent to you. There, one account
per event is cheap because the events are rare. Here, one account per order
would put rent on every quote a market maker posts and an account load on every
fill.

## Capacity is shared, and it is blocks

`MAX_ORDERS = 4096` caps **blocks**, not orders. Holding a position costs one
block (your seat); resting an order costs two (seat plus order). A market with
many orders and few traders and a market with the reverse both fit without
preallocating for the worst case of either.

If `book_place` runs out of room, growing the book is a permissionless
`book_grow` call — bounded by Solana's 10 240-byte-per-instruction realloc cap,
so reaching the ceiling from empty takes several calls.

## See also

- [`./integrator-contract.md`](./integrator-contract.md) — `buildBookCancel`, `buildBookCancelMany`, `buildBookWithdraw`
- [`../../programs-core/docs/architecture.md`](../../programs-core/docs/architecture.md) §5 — the arena, seats, and escrow
- [`../../../docs/design/orderbook-redesign.md`](../../../docs/design/orderbook-redesign.md) — the measurements behind the seat model
