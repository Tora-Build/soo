// The bundled IDL must match the program that was built.
//
// The SDK ships a copy of `sooth_core.json` and Anchor builds every instruction
// method from it at runtime. When the copy drifts, nothing complains at compile
// time — `program.methods.foo` is `any` — and the failure arrives as
//
//   TypeError: this.program.methods.redeemBookSeat is not a function
//
// from inside a builder, at the moment a user clicks the button — a builder
// can appear wired, typecheck, and build, while the instruction it names is
// absent from the bundled copy.
//
// The reverse drift is worse in a quieter way. A stale copy keeps DELETED
// instructions callable from the SDK's perspective, so a builder constructs a
// perfectly-shaped instruction the program no longer has, and the transaction
// fails on chain with `0x65` — an error that names nothing.
//
// This compares the two. It is skipped when `target/idl` is absent, so a fresh
// clone that has not run `anchor build` does not fail on a file it cannot have.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import bundled from "../src/anchor/sooth_core.json" assert { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PATH = resolve(HERE, "../../../target/idl/sooth_core.json");
const BUNDLED_PATH = resolve(HERE, "../src/anchor/sooth_core.json");

interface MinimalIdl {
  address?: string;
  instructions: Array<{ name: string }>;
  accounts?: Array<{ name: string }>;
  errors?: Array<{ code: number; name: string }>;
}

const names = (idl: MinimalIdl) => idl.instructions.map((i) => i.name).sort();

describe("bundled IDL freshness", () => {
  const hasBuilt = existsSync(BUILT_PATH);
  const built: MinimalIdl | null = hasBuilt
    ? (JSON.parse(readFileSync(BUILT_PATH, "utf8")) as MinimalIdl)
    : null;

  it.skipIf(!hasBuilt)("exposes exactly the program's instructions", () => {
    const bundledNames = names(bundled as unknown as MinimalIdl);
    const builtNames = names(built!);

    const missing = builtNames.filter((n) => !bundledNames.includes(n));
    const extra = bundledNames.filter((n) => !builtNames.includes(n));

    // Reported separately because the two failures mean different things:
    // missing = a new instruction the SDK cannot call; extra = a deleted one
    // the SDK will happily build a doomed transaction for.
    expect(
      missing,
      `bundled IDL is STALE — run: cp target/idl/sooth_core.json packages/sdk-solana/src/anchor/`,
    ).toEqual([]);
    expect(
      extra,
      `bundled IDL names instructions the program no longer has`,
    ).toEqual([]);
  });

  it.skipIf(!hasBuilt)("agrees on the account layouts", () => {
    // An account added or renamed changes decoding, not just dispatch, so a
    // drift here corrupts reads rather than failing them.
    const b = (bundled as unknown as MinimalIdl).accounts?.map((a) => a.name).sort() ?? [];
    const t = built!.accounts?.map((a) => a.name).sort() ?? [];
    expect(b).toEqual(t);
  });

  it.skipIf(!hasBuilt)("agrees on the program id", () => {
    expect((bundled as unknown as MinimalIdl).address).toBe(built!.address);
  });

  it.skipIf(!hasBuilt)("agrees on the error ordinals", () => {
    // Anchor numbers user errors positionally from 6000 and the SDK's two
    // error classifiers read the mapping straight out of this file. A stale
    // copy renames codes rather than losing them: the message a user is shown
    // then belongs to a different failure than the one that happened.
    const pairs = (idl: MinimalIdl) =>
      (idl.errors ?? []).map((e) => `${e.code}:${e.name}`);
    expect(pairs(bundled as unknown as MinimalIdl)).toEqual(pairs(built!));
  });

  it.skipIf(!hasBuilt)("is byte-identical to the built IDL", () => {
    // The three checks above compare names. Everything else the IDL carries —
    // instruction discriminators, argument order and types, account order and
    // writable/signer flags — is what Anchor encodes a transaction from, and a
    // drift in any of it builds a well-formed instruction the program decodes
    // as something else. The bundled copy is generated, never hand-edited, so
    // the invariant is equality, not compatibility.
    expect(readFileSync(BUILT_PATH, "utf8")).toBe(
      readFileSync(BUNDLED_PATH, "utf8"),
    );
  });
});
