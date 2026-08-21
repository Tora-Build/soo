// Configuration and secrets.
//
// Every secret is read from the environment. Nothing sensitive is ever written
// into this repo — `markets.json` holds only public rule material (a url, a
// parse path, a field name), which is exactly the data the on-chain
// `rule_hash` already commits to in public.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO_ROOT, SERVICE_ROOT, loadWeb3 } from "./deps.mjs";

const { Keypair, PublicKey } = await loadWeb3();

/** Devnet default. Override with `SOLANA_RPC_URL`. */
const DEFAULT_RPC = "https://api.devnet.solana.com";

/**
 * Reads `KEY=value` pairs out of a dotenv-style file.
 *
 * Deliberately minimal: no interpolation, no export prefixes, no quote
 * stripping beyond a single wrapping pair. Anything fancier belongs in the
 * process manager, not here.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Environment, layered: real environment variables win over any dotenv file.
 *
 * `--env-file` (or `RESOLVER_ENV_FILE`) is a convenience for running the
 * service by hand; a systemd or GitHub Actions deployment sets real variables
 * and never needs it. `infra/zk-resolver/.env` is picked up automatically when
 * present, which is why `.gitignore` excludes it.
 */
export function loadEnv({ envFile } = {}) {
  const layered = {};
  const candidates = [
    envFile,
    process.env.RESOLVER_ENV_FILE,
    resolve(SERVICE_ROOT, ".env"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) {
      Object.assign(layered, parseEnvFile(readFileSync(path, "utf8")));
      break;
    }
  }
  return { ...layered, ...process.env };
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * base58 -> bytes.
 *
 * Hand-rolled to keep `bs58` off the dependency list for the sake of one
 * 64-byte decode. Leading `1`s are leading zero bytes, per the base58 spec.
 */
export function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base58 character ${JSON.stringify(ch)}`);
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * `RESOLVER_KEYPAIR` in either shape the ecosystem uses: a JSON byte array
 * (what `solana-keygen` writes) or a base58 secret key (what wallets export).
 *
 * This key is a FEE PAYER, nothing more. `attest_outcome_zk` is permissionless
 * — the attestor's signature is the authority — so losing this key costs the
 * SOL in it and nothing else. It is only ever privileged if it also happens to
 * be a market's `adjudicator_entry.authority`, which is what lets the resolver
 * lock a market; see `chain.mjs`.
 */
export function parseKeypair(raw, name = "RESOLVER_KEYPAIR") {
  if (!raw) throw new Error(`${name} is not set`);
  const trimmed = raw.trim();
  let bytes;
  if (trimmed.startsWith("[")) {
    bytes = Uint8Array.from(JSON.parse(trimmed));
  } else {
    bytes = base58Decode(trimmed);
  }
  if (bytes.length !== 64) {
    throw new Error(
      `${name} must decode to 64 bytes (got ${bytes.length}) — ` +
        `use the full secret key, not just the 32-byte seed or the public key`,
    );
  }
  return Keypair.fromSecretKey(bytes);
}

/**
 * The resolved runtime configuration.
 *
 * `primusAppId` / `primusAppSecret` are absent in fixture mode and required in
 * primus mode; `resolveConfig` does not enforce that, because which source is
 * in use is a CLI decision. `sources/primus.mjs` enforces it at the point it
 * would actually be used.
 */
export function resolveConfig(env = loadEnv()) {
  const rpcUrl = env.SOLANA_RPC_URL || env.RPC_URL || DEFAULT_RPC;

  const programId = env.SOOTH_CORE_PROGRAM_ID
    ? new PublicKey(env.SOOTH_CORE_PROGRAM_ID)
    : null;

  return {
    rpcUrl,
    programId,
    /** Fee payer. Parsed lazily so `--plan` works with no key present. */
    keypairRaw: env.RESOLVER_KEYPAIR || null,
    primusAppId: env.PRIMUS_APP_ID || null,
    primusAppSecret: env.PRIMUS_APP_SECRET || null,
    /** Advisory only, never on the resolution path. See `gemini.mjs`. */
    geminiApiKey: env.GEMINI_API_KEY || null,
    /** How long a Primus attestation may take before the pass gives up. */
    primusTimeoutMs: Number(env.PRIMUS_TIMEOUT_MS ?? 120_000),
    /** Watch-mode interval. The founder's cron may drive `--once` instead. */
    intervalMs: Number(env.RESOLVER_INTERVAL_MS ?? 5 * 60 * 1000),
    /** Where the idempotency journal lives. */
    statePath: env.RESOLVER_STATE_PATH || resolve(SERVICE_ROOT, ".state", "resolver.json"),
    registryPath: env.RESOLVER_REGISTRY || resolve(SERVICE_ROOT, "markets.json"),
    repoRoot: REPO_ROOT,
  };
}
