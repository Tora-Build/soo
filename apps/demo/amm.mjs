import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import anchorPkg from "@coral-xyz/anchor";
const { BN } = anchorPkg;
const SDK = "/Users/mohammadzakerirad/Sooth/sooth-solana/.agents/analyze/packages/sdk-solana/dist";
const pdas = await import(`file://${SDK}/pdas.js`);
const { soothCoreIdl } = await import(`file://${SDK}/anchor/index.js`);
const conn = new Connection("http://127.0.0.1:8899","confirmed");
const env = Object.fromEntries(readFileSync("./.env.local","utf8").split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i), l.slice(i+1)];}));
const marketPda = new PublicKey(env.VITE_DEMO_MARKET_REF.replace(/^sol:/,""));
const usdcMint = new PublicKey(env.VITE_USDC_MINT);
const programs = { soothCore: new PublicKey(env.VITE_SOOTH_MARKET_ID) };
const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("./.localnet/user-keypair.json","utf8"))));
const marketId = new Uint8Array((await conn.getAccountInfo(marketPda)).data.subarray(8,24));

const anchor = await import("@coral-xyz/anchor");
const wallet = { publicKey: user.publicKey, signTransaction: async t=>{t.partialSign(user);return t;}, signAllTransactions: async ts=>{ts.forEach(t=>t.partialSign(user));return ts;}, payer:user };
const provider = new anchor.AnchorProvider(conn, wallet, {commitment:"confirmed"});
const program = new anchor.Program(soothCoreIdl, provider);

const lpMint = pdas.deriveLpMintPda(marketId, programs)[0];
const a = {
  market: marketPda,
  ammState: pdas.deriveAmmStatePda(marketId, programs)[0],
  position: pdas.derivePositionPda(marketId, user.publicKey, programs)[0],
  vaultAuthority: pdas.deriveVaultAuthorityPda(marketId, programs)[0],
  userUsdcAta: pdas.deriveUserUsdcAta(user.publicKey, usdcMint),
  marketVault: pdas.deriveMarketVaultAta(marketId, usdcMint, programs),
  usdcMint,
  protocolConfig: pdas.deriveProtocolConfigPda(programs)[0],
  marketFeePool: pdas.marketFeePoolPda(marketId, programs)[0],
  lpMint,
  lpMintAuthority: pdas.deriveLpMintAuthorityPda(marketId, programs)[0],
  userLpAta: pdas.deriveUserLpAta(user.publicKey, lpMint),
  user: user.publicKey,
  systemProgram: SystemProgram.programId,
  tokenProgram: TOKEN_PROGRAM_ID,
  rent: SYSVAR_RENT_PUBKEY,
};
const WAD = 10n**18n;
const ix = await program.methods.tradePositions(1, new BN((1n*WAD).toString()), new BN((100n*WAD).toString())).accounts(a).instruction();
const tx = new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({units:400_000}))
  .add(ComputeBudgetProgram.requestHeapFrame({bytes:256*1024}))
  .add(createAssociatedTokenAccountIdempotentInstruction(user.publicKey, a.userLpAta, user.publicKey, lpMint))
  .add(ix);
try {
  const sig = await sendAndConfirmTransaction(conn, tx, [user], {commitment:"confirmed"});
  console.log("AMM buy OK", sig);
} catch (e) {
  console.log("FAILED:", e.message?.split("\n")[0]);
  const logs = e.transactionLogs ?? e.logs ?? [];
  logs.filter(l=>l.includes("Error")||l.includes("error")||l.includes("Program log")).slice(-8).forEach(l=>console.log("  ", l));
}
