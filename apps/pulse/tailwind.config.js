/** @type {import('tailwindcss').Config} */
// The Eastboard design system, verbatim: warm near-black canvas, ruled
// borders, gold accent, desaturated pos/neg. Pulse keeps its simplified
// one-axis interaction model but wears the EAST skin.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    colors: {
      transparent: "transparent",
      white: "#ffffff",
      canvas: "#0d0d0c",
      raised: "#151513",
      inset: "#090908",
      rule: "#333330",
      subtle: "#1e1e1c",
      ink: "#e8e5e0",
      muted: "#8a8378",
      faint: "#504e48",
      accent: { DEFAULT: "#d4a04a", soft: "rgba(212,160,74,0.14)" },
      pos: { DEFAULT: "#6b9a6a", soft: "rgba(107,154,106,0.12)" },
      neg: { DEFAULT: "#c45a4a", soft: "rgba(196,90,74,0.12)" },
      warn: { DEFAULT: "#c88a3a", soft: "rgba(200,138,58,0.1)" },
    },
    fontFamily: {
      sans: ["Inter", "system-ui", "sans-serif"],
      mono: ["JetBrains Mono", "ui-monospace", "monospace"],
    },
    extend: {},
  },
  plugins: [],
};
