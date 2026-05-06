// Chain-locked stub — see ./index.ts.
const stub = async () => ({
  result: { success: false, message: "Not available in Solana fork" },
  output: [],
});
export const walletCommands = {
  balance: stub,
  mint: stub,
  approve: stub,
  allowance: stub,
  getBalances: stub,
};
export const balance = stub;
export const mint = stub;
export const approve = stub;
export const allowance = stub;
export const getBalances = stub;
