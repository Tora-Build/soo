import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import {
  BarChart3,
  Scale,
  BookOpen,
  Droplets,
  Gamepad2,
  Grid2X2,
  MoreHorizontal,
  Rocket,
  Shield,
  SquareTerminal,
  WalletCards,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Drawer } from "../ui/Drawer";
import { cn } from "../../lib/utils";

const PRIMARY_LINKS = [
  { to: "/play", label: "Play", icon: Gamepad2 },
  { to: "/forge", label: "Forge", icon: Rocket },
  { to: "/locker", label: "Locker", icon: WalletCards },
  { to: "/geek", label: "Geek", icon: SquareTerminal },
] as const;

const MORE_LINKS = [
  { to: "/vault", label: "Vault", icon: Droplets },
  { to: "/explore", label: "Explore", icon: Grid2X2 },
  { to: "/adjudicators", label: "Adjudicators", icon: Scale },
  { to: "/lp-forecast", label: "Sim lab", icon: BarChart3 },
  { to: "/operator", label: "Oracle", icon: Shield },
  { to: "/learn", label: "Tutorial", icon: BookOpen },
  { to: "/power", label: "Power up", icon: Droplets },
] as const;

export const ArenaDock = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const active = (path: string) =>
    path === "/play"
      ? location.pathname === path
      : location.pathname === path || location.pathname.startsWith(`${path}/`);
  const moreActive = MORE_LINKS.some((link) => active(link.to));

  return (
    <>
      <nav className="arena-dock" aria-label={t("navbar.navigation")}>
        <div className="arena-dock-inner">
          {PRIMARY_LINKS.map((item) => {
            const Icon = item.icon;
            const isActive = active(item.to);
            return (
              <Link
                to={item.to}
                key={item.to}
                className={cn("arena-dock-item", isActive && "is-active")}
              >
                {isActive && (
                  <motion.span
                    layoutId="arena-dock-active"
                    className="arena-dock-active"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <Icon className="relative h-[18px] w-[18px]" strokeWidth={2} />
                <span className="relative">{item.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className={cn("arena-dock-item", moreActive && "is-active")}
            aria-label={t("nav.more")}
          >
            {moreActive && <span className="arena-dock-active" />}
            <MoreHorizontal className="relative h-[18px] w-[18px]" />
            <span className="relative">{t("nav.more")}</span>
          </button>
        </div>
      </nav>

      <Drawer
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={t("navbar.navigation")}
        className="arena-menu-drawer"
      >
        <div className="mb-5 rounded-2xl border border-rule bg-inset p-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-canvas">
              <Grid2X2 className="h-5 w-5" />
            </span>
            <div>
              <div className="font-heading text-base uppercase tracking-[-0.03em] text-ink">
                Game menu
              </div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                Tools, labs and protocol controls
              </div>
            </div>
          </div>
        </div>

        <nav className="grid gap-2">
          {MORE_LINKS.map((item) => {
            const Icon = item.icon;
            const isActive = active(item.to);
            return (
              <Link
                to={item.to}
                key={item.to}
                onClick={() => setMenuOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border px-4 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors",
                  isActive
                    ? "border-accent bg-accent-muted text-accent"
                    : "border-rule bg-raised text-muted hover:border-accent hover:text-ink",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </Drawer>
    </>
  );
};
