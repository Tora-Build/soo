// Shared fixture loader. globalSetup writes .e2e-fixture.json with the
// resolved market PDA + market_id hex; specs read it instead of going
// through env (process.env mutations in globalSetup do not propagate to
// Playwright workers — see the comment in global-setup.ts).

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const FIXTURE_PATH = resolve(__dirname, "..", ".e2e-fixture.json");

export interface E2eFixture {
  marketPda: string;
  marketIdHex: string;
  soothAmmId: string;
  /** BOOK venue token (the name predates the split). */
  usdcMint: string;
  /** AMM venue token. */
  ammMint: string;
  rpcUrl: string;
}

export function loadFixture(): E2eFixture {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `${FIXTURE_PATH} missing — globalSetup did not run or failed`,
    );
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as E2eFixture;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v;
}

/** Test wallet pubkey from $TEST_PUBKEY (the LocalKeypairAdapter pubkey). */
export function testPubkey(): PublicKey {
  return new PublicKey(requireEnv("TEST_PUBKEY"));
}

/** 16-byte market_id parsed from the fixture's hex. */
export function marketIdBytes(fixture: E2eFixture): Buffer {
  const buf = Buffer.from(fixture.marketIdHex, "hex");
  if (buf.length !== 16) {
    throw new Error(`marketIdHex must encode 16 bytes; got ${buf.length}`);
  }
  return buf;
}
