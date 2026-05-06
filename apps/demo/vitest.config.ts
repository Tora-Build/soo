import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// vitest uses node — but tests/render.test.tsx mounts React via
// @testing-library/react which needs a DOM environment. happy-dom is
// faster than jsdom and sufficient for our component surface (no canvas,
// no SVG rendering needed).

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "happy-dom",
    globals: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
