# Orderbook Cancel Rent UX

When you cancel an orderbook order on Solana, **you do not receive a rent refund**. Rent for the `BookSide` resting-order container is pooled across all makers at that tick. The rent is returned only when the entire tick drains (zero live orders) and someone - including you - calls `close_book_side` to close the account. This breaks the convention from the AMM `Position` model where rent IS refunded on close.

For the curious: `docs/spec/sooth_book.md` §3.2 explains the tradeoff. SoothBook uses one `BookSide` PDA per `(market, side, tick)` and stores up to 50 inline resting orders inside it. That replaces Monaco-style per-order PDAs with pooled tick storage, keeping market creation and order placement rent bounded. The cost is that cancel can only mark an order as inactive; cleanup and rent recovery happen later when the whole tick can be compacted and closed.
