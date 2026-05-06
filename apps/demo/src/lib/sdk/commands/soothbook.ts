// Chain-locked stub — see ./index.ts.
const stub = async () => ({
  result: { success: false, message: "Not available in Solana fork" },
  output: [],
});
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
