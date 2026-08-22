// Dependency resolution.
//
// This service lives at `infra/zk-resolver/`, which is OUTSIDE the pnpm
// workspace (`pnpm-workspace.yaml` lists only `packages/*` and `apps/*`). So
// there are two situations it has to load its dependencies in, and it supports
// both rather than forcing one:
//
//   1. Installed standalone — the founder ran `npm install` in this directory
//      and everything in `package.json` sits in `./node_modules`. Plain
//      specifier imports resolve.
//
//   2. Run in-place from a monorepo checkout with no install of its own. Every
//      dependency is already on disk under the workspace's pnpm store, just
//      not on this package's lookup chain. This is how the dry-run is executed
//      during development, and it is why the fallback exists.
//
// `@sooth/sdk-solana` is never published, so it is ALWAYS loaded from the
// monorepo's built `dist/` — situation 1 covers the npm deps only. That makes
// a built SDK a hard precondition of running this service at all; `loadSdk`
// says so by name instead of failing with a module-not-found deep in a call.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `infra/zk-resolver/` */
export const SERVICE_ROOT = resolve(HERE, "..");

/**
 * The monorepo root, or `null` when this service was copied out of it.
 *
 * Detected by a marker file rather than assumed, so a standalone deploy that
 * genuinely has no monorepo around it takes the null branch and relies purely
 * on its own `node_modules`.
 */
export const REPO_ROOT = (() => {
  const candidate = resolve(SERVICE_ROOT, "..", "..");
  return existsSync(resolve(candidate, "pnpm-workspace.yaml")) ? candidate : null;
})();

const SDK_DIST = REPO_ROOT
  ? resolve(REPO_ROOT, "packages", "sdk-solana", "dist")
  : null;

const fileUrl = (abs) => new URL(`file://${abs}`).href;

/**
 * Imports `specifier`, falling back to each of `fallbackPaths` in order.
 *
 * The fallbacks are absolute paths into the monorepo's already-installed
 * packages. A fallback is only tried when the specifier itself does not
 * resolve, so an installed copy always wins and the monorepo never shadows a
 * deliberate local version.
 */
async function importWithFallback(specifier, fallbackPaths) {
  try {
    return await import(specifier);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    for (const p of fallbackPaths) {
      if (p && existsSync(p)) return await import(fileUrl(p));
    }
    throw new Error(
      `cannot resolve "${specifier}" — run \`npm install\` in ${SERVICE_ROOT}, ` +
        `or run this service from a monorepo checkout with \`pnpm install\` done at the root`,
    );
  }
}

const mono = (...parts) => (REPO_ROOT ? resolve(REPO_ROOT, ...parts) : null);

export async function loadWeb3() {
  const mod = await importWithFallback("@solana/web3.js", [
    mono("apps", "demo", "node_modules", "@solana", "web3.js", "lib", "index.cjs.js"),
  ]);
  return mod.default ?? mod;
}

export async function loadAnchor() {
  const mod = await importWithFallback("@coral-xyz/anchor", [
    mono("apps", "demo", "node_modules", "@coral-xyz", "anchor", "dist", "cjs", "index.js"),
  ]);
  return mod.default ?? mod;
}

/** secp256k1 + keccak256, for the fixture attestor and the golden self-test. */
export async function loadCrypto() {
  const curves = await importWithFallback("@noble/curves/secp256k1", [
    mono("packages", "sdk-solana", "node_modules", "@noble", "curves", "esm", "secp256k1.js"),
  ]);
  const hashes = await importWithFallback("@noble/hashes/sha3", [
    mono("packages", "sdk-solana", "node_modules", "@noble", "hashes", "esm", "sha3.js"),
  ]);
  return { secp256k1: curves.secp256k1, keccak_256: hashes.keccak_256 };
}

/**
 * The Sooth SDK, from the monorepo's built `dist/`.
 *
 * Deep per-file imports for the same reason `apps/demo/scripts/*.mjs` uses
 * them: the SDK's `exports` map has no subpaths, and its package root pulls in
 * `@coral-xyz/anchor` named exports that plain `node` cannot parse out of a
 * CJS module. `zk.js`, `adapter.js`, `pdas.js` and `anchor/index.js` all load
 * cleanly this way.
 */
export async function loadSdk() {
  if (!SDK_DIST || !existsSync(SDK_DIST)) {
    throw new Error(
      `@sooth/sdk-solana dist not found${SDK_DIST ? ` at ${SDK_DIST}` : ""} — ` +
        `this service reads the SDK from the monorepo. Run \`pnpm -F @sooth/sdk-solana build\` ` +
        `at the repo root, and run the resolver from inside the checkout.`,
    );
  }
  const at = (rel) => import(fileUrl(resolve(SDK_DIST, rel)));
  const [zk, adapter, pdas, idl, bookEvents, book] = await Promise.all([
    at("zk.js"),
    at("adapter.js"),
    at("pdas.js"),
    at("anchor/index.js"),
    at("book/events.js"),
    at("book/index.js"),
  ]);
  return {
    computeRuleHash: zk.computeRuleHash,
    toZkAttestationArg: zk.toZkAttestationArg,
    hexToBytes: zk.hexToBytes,
    ZK_COMPARATOR: zk.ZK_COMPARATOR,
    MAX_ZK_VALUE_SCALE: zk.MAX_ZK_VALUE_SCALE,
    SolanaChainAdapter: adapter.SolanaChainAdapter,
    pdas,
    soothCoreIdl: idl.soothCoreIdl,
    // T* voiding reads the book too: fills ride `emit_cpi!` inner
    // instructions rather than logs, and the seat ledger the entitlement is
    // clamped against lives in the zero-copy arena. Both decoders are the
    // SDK's, so the resolver cannot drift from what the demo reads.
    decodeBookEventsFromInner: bookEvents.decodeBookEventsFromInner,
    decodeBook: book.decodeBook,
    bookPda: book.bookPda,
  };
}
