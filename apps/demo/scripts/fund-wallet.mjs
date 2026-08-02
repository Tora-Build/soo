#!/usr/bin/env node
// Fund an arbitrary wallet on the running localnet: SOL, a USDC ATA, and USDC.
//
// A wallet imported into Phantom starts with nothing on a fresh validator, and
// the resulting failure is an opaque "Simulation failed" — the RPC text is
// "Attempt to debit an account but found no record of a prior credit", which
// names neither the account nor the remedy.
//
//   node scripts/fund-wallet.mjs <PUBKEY> [usdc=1000]
import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) { console.error("usage: node scripts/fund-wallet.mjs <PUBKEY> [usdc]"); process.exit(1); }
const usdc = BigInt(Math.round(Number(process.argv[3] ?? 1000) * 1e6));

const env = Object.fromEntries(readFileSync(`${DEMO}/.env.local`,"utf8").split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));
const conn = new Connection(env.VITE_SOLANA_RPC_URL ?? "http://127.0.0.1:8899","confirmed");
const usdcMint = new PublicKey(env.VITE_USDC_MINT);
const kp = p => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p,"utf8"))));
const payer = kp(`${DEMO}/.localnet/creator-keypair.json`);
const mintAuth = kp(`${DEMO}/.localnet/mint-authority.json`);
const who = new PublicKey(target);

const sol = await conn.getBalance(who);
if (sol < LAMPORTS_PER_SOL) {
  await conn.confirmTransaction(await conn.requestAirdrop(who, 5 * LAMPORTS_PER_SOL), "confirmed");
  console.log("airdropped 5 SOL");
} else {
  console.log(`already has ${(sol/LAMPORTS_PER_SOL).toFixed(2)} SOL`);
}

const ata = getAssociatedTokenAddressSync(usdcMint, who);
await sendAndConfirmTransaction(conn, new Transaction()
  .add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, who, usdcMint))
  .add(createMintToInstruction(usdcMint, ata, mintAuth.publicKey, usdc)),
  [payer, mintAuth], { commitment: "confirmed" });

const bal = await conn.getTokenAccountBalance(ata);
console.log(`USDC ATA ${ata.toBase58()} -> ${bal.value.uiAmountString}`);
console.log("ready to trade");
