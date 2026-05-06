import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import zh from "../locales/zh.json";

const STORAGE_KEY = "sooth-lang";

const savedLang = (() => {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  return navigator.language.startsWith("zh") ? "zh" : "en";
})();

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: savedLang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

// Persist language choice
i18n.on("languageChanged", (lng) => {
  localStorage.setItem(STORAGE_KEY, lng);
});

export default i18n;
