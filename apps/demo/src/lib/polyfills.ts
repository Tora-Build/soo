// Browser polyfills required by @solana/web3.js + @solana/wallet-adapter-*.
// Both libs assume `Buffer` and `process` exist as globals (a Node-ism that
// leaks through their dependency tree). Vite doesn't polyfill these by
// default; we shim minimum surface here. Imported first thing in main.tsx.

import { Buffer } from "buffer";

// `window.process` and `window.Buffer` are typed by `@types/node` (process)
// and `buffer` itself; we shim minimum surface and cast to `unknown` to
// sidestep the strict `Process` shape that node types pull in.

if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  if (!w.Buffer) w.Buffer = Buffer;
  if (!w.process) w.process = { env: {} };
  if (!w.global) w.global = window;
}
