import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// vitest uses node — but tests/happy-path.test.tsx mounts React via
// @testing-library/react which needs a DOM environment. happy-dom is
// faster than jsdom and sufficient for our component surface (no canvas,
// no SVG rendering needed).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: false,
    // Bankrun boot + tx submit + a couple of re-renders is well under 60s
    // on warm cache; use 90s to allow for a cold run.
    testTimeout: 90_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
