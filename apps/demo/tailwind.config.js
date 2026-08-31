// ─────────────────────────────────────────────────────────────────────────────
// Tailwind config copied from sooth-alpha/apps/demo to keep the upstream UI
// rendering byte-identical. The Solana fork's chain integration is swapped in
// `src/lib/chain-shim/`; the design system stays the same.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    colors: {
      transparent: "transparent",
      white: "#ffffff",

      canvas: "#0d0d0c",
      raised: "#151513",
      inset: "#090908",

      rule: "#333330",
      subtle: "#1e1e1c",

      tooltip: "var(--tooltip-bg)",

      ink: "#e8e5e0",
      muted: "#8a8378",
      faint: "#504e48",

      accent: {
        DEFAULT: "var(--accent)",
        muted: "var(--accent-muted)",
        soft: "var(--accent-soft)",
      },

      pos: { DEFAULT: "var(--pos)", soft: "var(--pos-soft)" },
      neg: { DEFAULT: "var(--neg)", soft: "var(--neg-soft)" },
      warn: { DEFAULT: "var(--warn)", soft: "var(--warn-soft)" },
      info: "var(--info)",
      error: "var(--neg)",
    },
    // `border` with no colour stays transparent — the design system's
    // deliberate default, so a bare `border` never draws a stray hairline.
    // But this key REPLACED the palette instead of setting its default, so
    // every `border-<colour>` in the app resolved to nothing: border-accent,
    // border-emerald-500, border-red-500 and friends were silently invisible
    // wherever they were used, which is why controls kept "not showing up"
    // no matter how much contrast they were given. Spreading the palette
    // back restores them and keeps the transparent default.
    borderColor: ({ theme }) => ({
      ...theme("colors"),
      DEFAULT: "transparent",
    }),
    extend: {
      fontFamily: {
        sans: [
          '"DM Sans"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: [
          '"DM Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        heading: [
          '"DM Sans"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
      },
      letterSpacing: {
        "mono-ui": "0.12em",
        "mono-micro": "0.18em",
        "mono-data": "0.02em",
      },
      fontSize: {
        display: [
          "72px",
          { lineHeight: "0.95", letterSpacing: "-0.035em", fontWeight: "500" },
        ],
        h1: [
          "40px",
          { lineHeight: "1.05", letterSpacing: "-0.025em", fontWeight: "500" },
        ],
        h2: [
          "24px",
          { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "500" },
        ],
        h3: [
          "16px",
          { lineHeight: "1.3", letterSpacing: "-0.01em", fontWeight: "600" },
        ],
        body: ["15px", { lineHeight: "1.55" }],
        small: ["13px", { lineHeight: "1.5" }],
        ui: ["11px", { lineHeight: "1", letterSpacing: "0.12em" }],
        micro: ["9px", { lineHeight: "1", letterSpacing: "0.18em" }],
      },
      borderRadius: {
        none: "0px",
        DEFAULT: "0px",
        sm: "0px",
        md: "0px",
        lg: "0px",
        xl: "0px",
        "2xl": "0px",
        "3xl": "0px",
        full: "9999px",
      },
      boxShadow: {
        none: "none",
        DEFAULT: "none",
        sm: "none",
        md: "none",
        lg: "none",
        xl: "none",
        "2xl": "none",
      },
      transitionDuration: { DEFAULT: "100ms" },
      zIndex: {
        dropdown: "50",
        sticky: "60",
        overlay: "70",
        modal: "80",
        popover: "90",
        toast: "100",
      },
    },
  },
  // `animate-in` / `fade-in` / `slide-in-from-right` / `zoom-in-95` in
  // Dialog.tsx and Drawer.tsx come from this plugin; without it those
  // classes emit no CSS and the overlays appear with no transition.
  plugins: [require("tailwindcss-animate")],
};
