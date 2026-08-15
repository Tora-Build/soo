/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // Pulse's own system: dark, dense, numeric. Two semantic colors carry the
    // whole product — YES green and NO red — everything else stays neutral so
    // the price is always the loudest thing on screen.
    colors: {
      bg: "#0b0e11",
      panel: "#12161b",
      inset: "#0e1216",
      line: "#232a32",
      ink: "#e8edf2",
      dim: "#8b98a5",
      faint: "#566270",
      yes: { DEFAULT: "#2fbf71", soft: "rgba(47,191,113,0.12)" },
      no: { DEFAULT: "#e5484d", soft: "rgba(229,72,77,0.12)" },
      accent: "#5b9dff",
      warn: "#d9a03f",
      transparent: "transparent",
      white: "#ffffff",
    },
    fontFamily: {
      sans: ["Inter", "system-ui", "sans-serif"],
      mono: ["JetBrains Mono", "ui-monospace", "monospace"],
    },
    extend: {},
  },
  plugins: [],
};
