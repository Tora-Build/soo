// Chain-locked stub. The full upstream surface is recreated as no-op
// references so Geek's command dispatcher compiles.

const stub = async () => ({
  result: { success: false, message: "Not available in Solana fork" },
  output: [
    {
      type: "warn" as const,
      text: "Solana fork: SDK terminal commands are not implemented.",
    },
  ],
});

export const walletCommands = {
  balance: stub,
  mint: stub,
  approve: stub,
  allowance: stub,
  getBalances: stub,
};
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
export const soothbookCommands = {
  buyyes: stub,
  buyno: stub,
  sbmint: stub,
  sbmerge: stub,
  sbcancel: stub,
  sbredeem: stub,
  sbbook: stub,
  sbbalance: stub,
  sbstate: stub,
  sbprice: stub,
  sbhistory: stub,
  sbsetmarket: stub,
};

export const balance = stub;
export const mint = stub;
export const approve = stub;
export const allowance = stub;
export const getBalances = stub;
export const createmarket = stub;
export const graduate = stub;
export const marketstatus = stub;
export const buyyes = stub;
export const buyno = stub;
export const sbmint = stub;
export const sbmerge = stub;
export const sbcancel = stub;
export const sbredeem = stub;
export const sbbook = stub;
export const sbbalance = stub;
export const sbstate = stub;
export const sbprice = stub;
export const sbhistory = stub;
export const sbsetmarket = stub;
