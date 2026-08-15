import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Solana web3 wants Buffer/process in the browser; the polyfill plugin covers
// it wholesale so no hand-rolled shim file is needed (a lesson from the demo,
// where import ORDER of a manual polyfill caused a blank-page crash).
export default defineConfig({
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, process: true } })],
  server: { port: 5300 },
});
