import { create } from "zustand";

const ACCENT_PRESETS = [
  { name: "Amber", value: "#D4A04A" },
  { name: "Rose", value: "#C96A7A" },
  { name: "Purple", value: "#8A6AB5" },
  { name: "Blue", value: "#5A8FC8" },
  { name: "Teal", value: "#4AA5B0" },
  { name: "Green", value: "#4A9A6A" },
  { name: "White", value: "#e8e5e0" },
] as const;

type AccentPreset = (typeof ACCENT_PRESETS)[number];

interface AccentStore {
  accent: string;
  setAccent: (color: string) => void;
}

const getInitialAccent = () => {
  if (typeof window === "undefined") return "#D4A04A";
  return localStorage.getItem("sooth_accent") || "#D4A04A";
};

export const useAccentStore = create<AccentStore>((set) => ({
  accent: getInitialAccent(),
  setAccent: (color: string) => {
    localStorage.setItem("sooth_accent", color);
    document.documentElement.style.setProperty("--accent", color);
    document.documentElement.style.setProperty("--accent-muted", color + "0F");
    set({ accent: color });
  },
}));

export { ACCENT_PRESETS };
export type { AccentPreset };
