import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite + React + Tailwind. The Solana wallet-adapter expects `process.env`
// and a few Node globals (Buffer, process) to be polyfilled in the browser.
// Rather than pulling a polyfill plugin, we shim what's needed at runtime in
// `src/lib/polyfills.ts` and import it from `main.tsx` first thing.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The `buffer` npm package ships a browser-friendly Buffer impl.
      // Vite's default behaviour is to externalize the Node builtin (which
      // doesn't exist in the browser). Aliasing forces resolution to the
      // shim package we've added as a direct dep.
      buffer: "buffer/",
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV ?? "development",
    ),
    global: "globalThis",
  },
  optimizeDeps: {
    // Pre-bundle these so they're correctly transformed for the browser.
    include: ["buffer"],
  },
  server: {
    port: 5173,
  },
});
