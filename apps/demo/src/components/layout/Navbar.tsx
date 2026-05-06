import React, { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAppKit, useAppKitAccount } from "@/lib/chain-shim";
import { cn } from "../../lib/utils";
import { ChainSelector } from "../ui/ChainSelector";
import { useAccentStore, ACCENT_PRESETS } from "../../store/useAccentStore";
import { Drawer } from "../ui/Drawer";
import { useTranslation } from "react-i18next";
import {
  TrendingUp,
  Menu,
  Droplets,
  BarChart3,
  Rocket,
  Shield,
  BookOpen,
  Briefcase,
  ChevronDown,
  Terminal,
} from "lucide-react";

export const Navbar = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Dropdown state
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const displayAddress = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : "";

  const isActive = (path: string) => location.pathname === path;
  const isMoreActive = ["/operator", "/learn", "/faucet"].some(
    (p) => isActive(p) || location.pathname.startsWith(p + "/"),
  );

  return (
    <header className="h-14 border-b border-rule bg-canvas sticky top-0 z-40">
      <div className="container mx-auto max-w-7xl h-full px-4 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-8">
          <Link to="/" className="flex items-center">
            <span className="font-sans font-bold text-sm text-ink tracking-[0.1em] uppercase">
              SOOTH
            </span>
          </Link>

          {/* Nav Links */}
          <nav className="hidden md:flex items-center gap-0">
            <NavLink to="/markets" active={isActive("/markets")}>
              {t("nav.markets")}
            </NavLink>

            <NavLink to="/liquidity" active={isActive("/liquidity")}>
              {t("nav.liquidity")}
            </NavLink>

            <NavLink to="/lp-forecast" active={isActive("/lp-forecast")}>
              {t("nav.lpForecast")}
            </NavLink>

            <NavLink to="/create" active={isActive("/create")}>
              {t("nav.launchpad")}
            </NavLink>

            <NavLink to="/geek" active={isActive("/geek")}>
              {t("nav.geek")}
            </NavLink>

            <NavLink to="/portfolio" active={isActive("/portfolio")}>
              {t("nav.portfolio")}
            </NavLink>

            {/* More Dropdown */}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setMoreOpen(!moreOpen)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 font-mono text-xs uppercase tracking-[0.12em] transition-colors duration-100",
                  isMoreActive ? "text-accent" : "text-muted hover:text-ink",
                )}
              >
                <span>{t("nav.more")}</span>
                <ChevronDown
                  className={cn(
                    "w-3 h-3 transition-transform",
                    moreOpen && "rotate-180",
                  )}
                />
              </button>

              {moreOpen && (
                <div className="absolute top-full right-0 mt-px w-36 bg-raised border border-rule p-1 z-50">
                  <DropdownLink
                    to="/operator"
                    active={isActive("/operator")}
                    onClick={() => setMoreOpen(false)}
                  >
                    <span>{t("nav.operator")}</span>
                  </DropdownLink>
                  <DropdownLink
                    to="/learn"
                    active={isActive("/learn")}
                    onClick={() => setMoreOpen(false)}
                  >
                    <span>{t("nav.learn")}</span>
                  </DropdownLink>
                  <DropdownLink
                    to="/faucet"
                    active={isActive("/faucet")}
                    onClick={() => setMoreOpen(false)}
                  >
                    <span>{t("nav.faucet")}</span>
                  </DropdownLink>
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          {/* Language Toggle */}
          <LangToggle />

          {/* Accent Picker */}
          <AccentPicker />

          {/* Chain Selector */}
          <ChainSelector />

          {/* Wallet */}
          {!isConnected ? (
            <button
              onClick={() => open()}
              className="inline-flex items-center justify-center h-8 px-3 font-mono text-xs uppercase tracking-[0.12em] text-muted border border-rule hover:text-ink transition-colors duration-100"
            >
              {t("common.connect")}
            </button>
          ) : (
            <button
              onClick={() => open({ view: "Account" })}
              className="inline-flex items-center gap-2 h-8 px-3 font-mono text-xs text-muted border border-rule hover:text-ink transition-colors duration-100"
            >
              <div className="w-1.5 h-1.5 bg-accent" />
              <span className="hidden lg:inline tracking-tighter">
                {displayAddress}
              </span>
            </button>
          )}

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="md:hidden inline-flex items-center justify-center h-8 w-8 text-muted hover:text-ink transition-colors duration-100"
            aria-label={t("navbar.openMenu")}
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Mobile Menu Drawer */}
      <Drawer
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        title={t("navbar.navigation")}
      >
        <nav className="flex flex-col gap-1">
          <MobileNavLink
            to="/markets"
            active={isActive("/markets")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <TrendingUp className="w-4 h-4" />
            <span>{t("nav.markets")}</span>
          </MobileNavLink>

          <MobileNavLink
            to="/liquidity"
            active={isActive("/liquidity")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <Droplets className="w-4 h-4" />
            <span>{t("nav.liquidity")}</span>
          </MobileNavLink>

          <MobileNavLink
            to="/lp-forecast"
            active={isActive("/lp-forecast")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <BarChart3 className="w-4 h-4" />
            <span>{t("nav.lpForecast")}</span>
          </MobileNavLink>

          <MobileNavLink
            to="/create"
            active={isActive("/create")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <Rocket className="w-4 h-4" />
            <span>{t("nav.launchpad")}</span>
          </MobileNavLink>

          <MobileNavLink
            to="/geek"
            active={isActive("/geek")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <Terminal className="w-4 h-4" />
            <span>{t("nav.geek")}</span>
          </MobileNavLink>

          <MobileNavLink
            to="/portfolio"
            active={isActive("/portfolio")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <Briefcase className="w-4 h-4" />
            <span>{t("nav.portfolio")}</span>
          </MobileNavLink>

          <div className="px-4 py-2 font-mono text-xs text-faint uppercase tracking-[0.12em] mt-2 border-t border-rule pt-4">
            {t("nav.more")}
          </div>

          <MobileNavLink
            to="/operator"
            active={isActive("/operator")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <Shield className="w-4 h-4" />
            <span>{t("nav.operator")}</span>
          </MobileNavLink>

          <MobileNavLink
            to="/learn"
            active={isActive("/learn")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <BookOpen className="w-4 h-4" />
            <span>{t("nav.learn")}</span>
          </MobileNavLink>

          <MobileNavLink
            to="/faucet"
            active={isActive("/faucet")}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <Droplets className="w-4 h-4" />
            <span>{t("nav.faucet")}</span>
          </MobileNavLink>
        </nav>
      </Drawer>
    </header>
  );
};

const NavLink = ({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) => (
  <Link
    to={to}
    className={cn(
      "px-3 py-2 font-mono text-xs uppercase tracking-[0.12em] transition-colors duration-100 whitespace-nowrap",
      active ? "text-accent" : "text-muted hover:text-ink",
    )}
  >
    {children}
  </Link>
);

const DropdownLink = ({
  to,
  active,
  onClick,
  children,
}: {
  to: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <Link
    to={to}
    onClick={onClick}
    className={cn(
      "flex items-center gap-3 px-3 py-2 font-mono text-xs uppercase tracking-[0.12em] transition-colors duration-100",
      active ? "text-accent" : "text-muted hover:text-ink",
    )}
  >
    {children}
  </Link>
);

const LangToggle = () => {
  const { i18n } = useTranslation();
  const isZh = i18n.language === "zh";
  return (
    <button
      onClick={() => i18n.changeLanguage(isZh ? "en" : "zh")}
      className="hidden lg:inline-flex items-center justify-center h-8 px-3 font-mono text-xs text-muted hover:text-ink border border-rule transition-colors duration-100 uppercase tracking-wider"
      title={isZh ? "Switch to English" : "切换中文"}
    >
      {isZh ? "EN" : "中"}
    </button>
  );
};

const AccentPicker = () => {
  const { accent, setAccent } = useAccentStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative hidden lg:inline-flex items-center justify-center h-8 mr-1"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Choose accent color"
        className="w-4 h-4 rounded-sm border border-rule/60 transition-all hover:scale-110"
        style={{ background: accent }}
      />
      {open && (
        <div className="absolute right-0 top-full mt-2 p-2 bg-raised border border-rule z-overlay flex gap-1.5">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.value}
              onClick={() => {
                setAccent(preset.value);
                setOpen(false);
              }}
              aria-label={`Set accent ${preset.name}`}
              className="w-4 h-4 rounded-sm transition-all hover:scale-110"
              style={{
                background: preset.value,
                outline:
                  accent === preset.value
                    ? "2px solid " + preset.value
                    : "1px solid transparent",
                outlineOffset: "2px",
                opacity: accent === preset.value ? 1 : 0.6,
              }}
              title={preset.name}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const MobileNavLink = ({
  to,
  active,
  onClick,
  children,
}: {
  to: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <Link
    to={to}
    onClick={onClick}
    className={cn(
      "flex items-center gap-3 px-4 py-3 font-mono text-xs uppercase tracking-[0.12em] transition-colors duration-100",
      active ? "text-accent" : "text-muted hover:text-ink",
    )}
  >
    {children}
  </Link>
);
