// Browser polyfills for the Solana wallet-adapter / web3.js stack.
// `Buffer` and `process` aren't available in Vite's default browser bundle.
// Imported FIRST in main.tsx so anything that touches these globals at
// module-init time (e.g. wallet-adapter-base) sees them set.

import { Buffer } from "buffer";

if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (!w.Buffer) w.Buffer = Buffer;
  if (!w.process) w.process = { env: {} };
  if (!w.global) w.global = window;
}
