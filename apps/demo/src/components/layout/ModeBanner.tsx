// Route-aware hero banner for the arcade shell. Matches the current path
// against a mode table and renders that mode's eyebrow/title/detail with the
// player's XP and ticket totals; renders nothing on routes without a mode
// (e.g. /play, which carries its own header).

import { Link, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import {
  BatteryCharging,
  BookOpenCheck,
  ChevronRight,
  Droplets,
  FlaskConical,
  Gamepad2,
  Rocket,
  ShieldCheck,
  Swords,
  WalletCards,
} from "lucide-react";
import { usePlayerStats } from "../../features/arena/usePlayerStats";

const MODES = [
  {
    match: ["/vault"],
    eyebrow: "Vault mode",
    title: "Power the arena. Earn the upside.",
    detail: "Back the games you believe in and climb the LP board.",
    tone: "cyan",
    icon: Droplets,
  },
  {
    match: ["/forge"],
    eyebrow: "Forge mode",
    title: "Turn a question into a live arena.",
    detail: "Build the rules, seed the round, and send it live.",
    tone: "pink",
    icon: Rocket,
  },
  {
    match: ["/locker"],
    eyebrow: "Player locker",
    title: "Your plays. Your rewards. Your story.",
    detail: "Track every open position and completed run.",
    tone: "violet",
    icon: WalletCards,
  },
  {
    match: ["/lp-forecast"],
    eyebrow: "Simulation lab",
    title: "Stress-test the next move.",
    detail: "Model the upside before you enter the vault.",
    tone: "orange",
    icon: FlaskConical,
  },
  {
    match: ["/learn"],
    eyebrow: "Tutorial island",
    title: "Learn the meta. Level up fast.",
    detail: "Master markets, signals, liquidity, and resolution.",
    tone: "cyan",
    icon: BookOpenCheck,
  },
  {
    match: ["/operator"],
    eyebrow: "Oracle tower",
    title: "Settle reality. Protect the game.",
    detail: "Review signals and keep every result trustworthy.",
    tone: "pink",
    icon: ShieldCheck,
  },
  {
    match: ["/power"],
    eyebrow: "Power-up station",
    title: "Fuel your next run.",
    detail: "Collect test assets and jump back into the arena.",
    tone: "orange",
    icon: BatteryCharging,
  },
  {
    match: ["/explore"],
    eyebrow: "Match room",
    title: "Read the odds. Make your move.",
    detail: "Every live arena, ready for your next play.",
    tone: "violet",
    icon: Swords,
  },
] as const;

export const ModeBanner = () => {
  const location = useLocation();
  const mode = MODES.find((item) =>
    item.match.some(
      (route) =>
        location.pathname === route ||
        location.pathname.startsWith(`${route}/`),
    ),
  );
  // The same merged source the navbar pill and the deck render from: a room
  // hero showing a different XP than the deck is the app disagreeing with
  // itself about who the player is.
  const { xp, tickets } = usePlayerStats();

  if (!mode) return null;

  const Icon = mode.icon;
  return (
    <motion.section
      className={`arcade-mode-banner is-${mode.tone}`}
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="arcade-mode-ghost" aria-hidden="true">
        {mode.eyebrow}
      </span>
      <div className="relative z-[1] flex min-w-0 items-center gap-4">
        <span className="arcade-mode-icon">
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <span className="font-mono text-[8px] font-bold uppercase tracking-[0.2em] text-current opacity-75">
            {mode.eyebrow}
          </span>
          <h1 className="mt-2 max-w-3xl text-[clamp(1.5rem,3vw,3.1rem)] leading-[0.95] text-white">
            {mode.title}
          </h1>
          <p className="mt-2 text-xs text-white/65">{mode.detail}</p>
        </div>
      </div>

      <div className="arcade-mode-actions">
        <div className="arcade-mode-score">
          <span>{xp}</span>
          <small>Player XP</small>
        </div>
        <div className="arcade-mode-score">
          <span>{tickets}</span>
          <small>Tickets</small>
        </div>
        <Link to="/play" className="arcade-mode-back">
          <Gamepad2 className="h-4 w-4" />
          Play arena
          <ChevronRight className="h-4 w-4" />
        </Link>
      </div>
    </motion.section>
  );
};
