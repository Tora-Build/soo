// Chain-locked stub — see ./index.ts.
const stub = async () => ({
  result: { success: false, message: "Not available in Solana fork" },
  output: [],
});
export const marketCommands = {
  createmarket: stub,
  graduate: stub,
  simulate: stub,
  marketstatus: stub,
  trialstatus: stub,
  dismiss: stub,
  claimrefund: stub,
  redeemlp: stub,
  transferlp: stub,
  lpbalance: stub,
  pausestatus: stub,
};
export const createmarket = stub;
export const graduate = stub;
export const marketstatus = stub;
