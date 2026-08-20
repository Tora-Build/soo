// The Arena HUD.
//
// Mounted by AppLayout, so it is the chrome of the game surface only — the
// Eastboard routes render under EastboardLayout and carry their own header.
// It reads as a console status bar rather than a site nav: brand + season on
// the left, live player stats and the wallet on the right, and a player card
// behind the avatar.
//
// Player numbers come from the arena server via useArenaPlayer when it is
// reachable, and from the device-local useArenaPlayerStore when it is not.
// The HUD therefore always has a level, a streak and a filling XP bar — there
// is no empty state that renders as blank chrome.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAppKit, useAppKitAccount } from "@/lib/chain-shim";
import { motion } from "framer-motion";
import toast from "react-hot-toast";
import {
  ChevronRight,
  Flame,
  Gift,
  RadioTower,
  Sparkles,
  Swords,
  Ticket,
  Trophy,
  UserRound,
  Wallet,
  Zap,
} from "lucide-react";
import { ChainSelector } from "../ui/ChainSelector";
import { Drawer } from "../ui/Drawer";
import { useAccentStore, ACCENT_PRESETS } from "../../store/useAccentStore";
import {
  ARENA_RANKS,
  levelFromXp,
  levelProgressFromXp,
  rankIndexFromLevel,
  useArenaPlayerStore,
  XP_PER_LEVEL,
} from "../../store/useArenaPlayerStore";
import { useArenaPlayer } from "../../features/arena/ArenaPlayerProvider";
import { useSeasonLeaderboard } from "../../features/arena/useSeasonLeaderboard";
import { shortenAddress } from "../../utils/format";
import { useTranslation } from "react-i18next";

// Handle, tickets and cross-device streaks live on the arena server. Without
// one configured the HUD runs on local progress alone and the sync-only
// controls stay hidden rather than offering an action that cannot succeed.
const ARENA_SYNC_CONFIGURED = Boolean(import.meta.env.VITE_ARENA_API_BASE);

/** Server profile when the arena service answers, local ledger otherwise —
 *  and once the connected wallet's on-chain play history scores higher than
 *  either, the chain-derived number wins. Guest plays stay local. */
function usePlayerStats() {
  const { profile } = useArenaPlayer();
  const { you: chainScore } = useSeasonLeaderboard();
  const localXp = useArenaPlayerStore((s) => s.xp);
  const localStreak = useArenaPlayerStore((s) => s.streak);
  const localTickets = useArenaPlayerStore((s) => s.tickets);
  const localPlays = useArenaPlayerStore((s) => s.scoutedMarkets.length);
  const localDailyClaim = useArenaPlayerStore((s) => s.lastDailyClaim);

  const baseXp = profile?.xp ?? localXp;
  const chainWins = chainScore !== null && chainScore.xp > baseXp;
  const xp = chainWins ? chainScore.xp : baseXp;
  return {
    isSynced: profile !== null,
    handle: profile?.handle ?? null,
    xp,
    streak: chainWins ? chainScore.streakDays : (profile?.streak ?? localStreak),
    tickets: profile?.tickets ?? localTickets,
    plays: chainWins ? chainScore.plays : (profile?.plays ?? localPlays),
    lastDailyClaim: profile?.lastDailyClaim ?? localDailyClaim,
    level: levelFromXp(xp),
    levelProgress: levelProgressFromXp(xp),
  };
}

export const Navbar = () => {
  const { t } = useTranslation();
  const { open } = useAppKit();
  const [profileOpen, setProfileOpen] = useState(false);
  const { address, isConnected } = useAppKitAccount();
  // Solana addresses are base58 — shortenAddress keeps the leading and
  // trailing characters a wallet is actually recognisable by.
  const displayAddress = address ? shortenAddress(address, 4) : "Guest";
  const { streak, tickets, level, levelProgress } = usePlayerStats();

  return (
    <>
      <header className="arena-hud sticky top-0 z-40 h-[74px] border-b border-rule bg-canvas/90 backdrop-blur-xl lg:pl-[92px]">
        <div className="flex h-full items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <Link
              to="/play"
              className="arcade-brand group flex shrink-0 items-center gap-2.5"
            >
              <span className="arcade-brand-mark">
                <Swords className="h-5 w-5" strokeWidth={2.8} />
              </span>
              <span className="flex flex-col leading-none">
                <span className="font-heading text-lg uppercase tracking-[-0.05em] text-ink">
                  Sooth
                </span>
                <span className="mt-1 font-mono text-[7px] font-semibold uppercase tracking-[0.24em] text-accent">
                  Reality arcade
                </span>
              </span>
            </Link>

            <div className="hidden h-8 w-px bg-rule md:block" />

            <div className="hidden items-center gap-3 md:flex">
              <span className="arcade-season-badge">S01</span>
              <div>
                <div className="font-mono text-[8px] font-semibold uppercase tracking-[0.18em] text-faint">
                  Current season
                </div>
                <div className="mt-0.5 text-xs font-bold uppercase tracking-wide text-ink">
                  Reality Rush
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 xl:flex">
              <HudStat icon={Flame} value={`${streak} day`} tone="heat" />
              <HudStat icon={Ticket} value={`${tickets}`} tone="ticket" />
              <button
                type="button"
                onClick={() => setProfileOpen(true)}
                className="arcade-xp-pill"
                aria-label={`Open player profile, level ${level}`}
              >
                <span className="arcade-level-badge">{level}</span>
                <span className="min-w-[84px] text-left">
                  <span className="block font-mono text-[8px] font-semibold uppercase tracking-[0.12em] text-muted">
                    {levelProgress} / {XP_PER_LEVEL} XP
                  </span>
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-inset">
                    <motion.span
                      className="block h-full rounded-full bg-accent"
                      animate={{
                        width: `${(levelProgress / XP_PER_LEVEL) * 100}%`,
                      }}
                    />
                  </span>
                </span>
              </button>
            </div>

            <div className="hidden lg:block">
              <LangToggle compact />
            </div>
            <ChainSelector />

            {!isConnected ? (
              <button onClick={() => open()} className="arcade-connect-button">
                <Wallet className="h-3.5 w-3.5" />
                <span>{t("common.connect")}</span>
              </button>
            ) : (
              <button
                onClick={() => open({ view: "Account" })}
                className="arcade-wallet-button"
              >
                <span className="stage-live-dot rounded-full" />
                <span className="hidden sm:inline">{displayAddress}</span>
                <Wallet className="h-3.5 w-3.5 sm:hidden" />
              </button>
            )}

            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              className="arcade-avatar-button xl:hidden"
              aria-label={`Open player profile, level ${level}`}
            >
              <span aria-hidden="true">{level}</span>
            </button>
          </div>
        </div>
      </header>

      <Drawer
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        hideHeader
        className="arcade-profile-drawer"
      >
        <PlayerProfile
          displayAddress={displayAddress}
          isConnected={isConnected}
          onConnect={() => open()}
        />
      </Drawer>
    </>
  );
};

const HudStat = ({
  icon: Icon,
  value,
  tone,
}: {
  icon: typeof Flame;
  value: string;
  tone: "heat" | "ticket";
}) => (
  <div className={`arcade-hud-stat is-${tone}`}>
    <Icon className="h-3.5 w-3.5" />
    <span>{value}</span>
  </div>
);

const PlayerProfile = ({
  displayAddress,
  isConnected,
  onConnect,
}: {
  displayAddress: string;
  isConnected: boolean;
  onConnect: () => void;
}) => {
  const {
    profile,
    isAuthenticated,
    isAuthenticating,
    serviceError,
    authenticate,
    claimDaily,
    updateHandle,
  } = useArenaPlayer();
  const {
    isSynced,
    handle: syncedHandle,
    streak,
    tickets,
    plays,
    lastDailyClaim,
    level,
    levelProgress,
  } = usePlayerStats();
  const claimLocalDrop = useArenaPlayerStore((s) => s.claimDailyDrop);
  const [handle, setHandle] = useState(syncedHandle ?? "edge_runner");
  const [isSavingHandle, setIsSavingHandle] = useState(false);
  useEffect(() => setHandle(syncedHandle ?? "edge_runner"), [syncedHandle]);
  const claimedToday = lastDailyClaim === new Date().toISOString().slice(0, 10);
  const rankIndex = rankIndexFromLevel(level);

  // With a server the drop is credited to the wallet; without one it is
  // credited to this device. Either way the button does something.
  const claimDrop = async () => {
    if (!ARENA_SYNC_CONFIGURED) {
      if (claimLocalDrop()) {
        toast.success("Daily drop unlocked · +250 XP · +1 ticket");
      }
      return;
    }
    if (!isConnected) {
      onConnect();
      return;
    }
    try {
      await claimDaily();
      toast.success("Daily drop unlocked · +250 XP · +1 ticket");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Daily drop failed");
    }
  };

  const saveHandle = async () => {
    if (handle === profile?.handle) return;
    setIsSavingHandle(true);
    try {
      await updateHandle(handle);
      toast.success("Player handle saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save handle",
      );
    } finally {
      setIsSavingHandle(false);
    }
  };

  return (
    <div className="arcade-profile min-h-full">
      <div className="arcade-profile-hero">
        <span className="arcade-profile-glow" aria-hidden="true" />
        <div className="relative z-[1]">
          <span className="arena-kicker">Player card</span>
          <div className="mt-8 flex items-end gap-4">
            <div className="arcade-profile-avatar">
              <UserRound className="h-9 w-9" />
              <span>LV {level}</span>
            </div>
            <div className="min-w-0 pb-1">
              <h2 className="truncate text-3xl">
                {syncedHandle ?? "Guest Runner"}
              </h2>
              <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted">
                {isConnected ? displayAddress : "Guest profile"}
              </p>
            </div>
          </div>

          <div className="mt-7">
            <div className="flex justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
              <span>Level {level}</span>
              <span>
                {levelProgress} / {XP_PER_LEVEL} XP
              </span>
            </div>
            <div className="mt-2 h-3 overflow-hidden rounded-full border border-white/10 bg-black/30 p-0.5">
              <motion.div
                className="h-full rounded-full bg-accent shadow-[0_0_16px_var(--accent)]"
                animate={{
                  width: `${(levelProgress / XP_PER_LEVEL) * 100}%`,
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="p-5">
        <div className="grid grid-cols-3 gap-2">
          <ProfileStat icon={Flame} value={`${streak}`} label="Day streak" />
          <ProfileStat icon={Ticket} value={`${tickets}`} label="Tickets" />
          <ProfileStat icon={Zap} value={`${plays}`} label="Plays" />
        </div>

        <button
          type="button"
          onClick={claimDrop}
          disabled={claimedToday || isAuthenticating}
          className="arcade-daily-drop group mt-5"
        >
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-black/20">
            {claimedToday ? (
              <Sparkles className="h-5 w-5" />
            ) : (
              <Gift className="h-5 w-5 transition-transform group-hover:-rotate-6 group-hover:scale-110" />
            )}
          </span>
          <span className="flex-1 text-left">
            <span className="block font-heading text-lg uppercase">
              {claimedToday ? "Drop claimed" : "Claim daily drop"}
            </span>
            <span className="mt-1 block font-mono text-[8px] uppercase tracking-[0.14em] opacity-70">
              {claimedToday ? "Come back tomorrow" : "+250 XP · +1 play ticket"}
            </span>
          </span>
          <ChevronRight className="h-5 w-5" />
        </button>

        <div className="mt-7 flex items-center justify-between">
          <div>
            <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-faint">
              Season rank
            </div>
            <h3 className="mt-1 text-xl">{ARENA_RANKS[rankIndex]}</h3>
          </div>
          <span className="arcade-rank-emblem">
            <Trophy className="h-5 w-5" />
          </span>
        </div>
        <div className="arcade-rank-track mt-4">
          {ARENA_RANKS.map((rank, index) => (
            <div className={index <= rankIndex ? "is-earned" : ""} key={rank}>
              <span />
              <small>{rank}</small>
            </div>
          ))}
        </div>

        {ARENA_SYNC_CONFIGURED ? (
          !isConnected ? (
            <button
              type="button"
              onClick={onConnect}
              className="arcade-profile-connect mt-7"
            >
              <RadioTower className="h-4 w-4" />
              Sync wallet profile
            </button>
          ) : !isAuthenticated ? (
            <button
              type="button"
              onClick={() =>
                void authenticate().catch((error) => toast.error(error.message))
              }
              disabled={isAuthenticating}
              className="arcade-profile-connect mt-7"
            >
              <RadioTower className="h-4 w-4" />
              {isAuthenticating
                ? "Waiting for signature…"
                : "Secure wallet profile"}
            </button>
          ) : (
            <form
              className="arena-handle-form mt-7"
              onSubmit={(event) => {
                event.preventDefault();
                void saveHandle();
              }}
            >
              <label htmlFor="arena-player-handle">Player handle</label>
              <div>
                <input
                  id="arena-player-handle"
                  value={handle}
                  maxLength={20}
                  onChange={(event) => setHandle(event.target.value)}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  disabled={isSavingHandle || handle === profile?.handle}
                >
                  {isSavingHandle ? "Saving" : "Save"}
                </button>
              </div>
            </form>
          )
        ) : (
          <p className="arena-service-warning mt-7">
            Local season · progress is saved on this device. Leaderboards and
            cross-device streaks arrive when arena sync is switched on.
          </p>
        )}

        {/* A sync failure is worth surfacing; a service that was never
            configured is not an error, so it never reaches here. */}
        {ARENA_SYNC_CONFIGURED && serviceError && !isSynced && (
          <p className="arena-service-warning mt-4">{serviceError}</p>
        )}

        <div className="mt-7 border-t border-rule pt-5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8px] uppercase tracking-[0.18em] text-faint">
              Color loadout
            </span>
            <AccentPicker />
          </div>
          <LangToggle />
        </div>
      </div>
    </div>
  );
};

const ProfileStat = ({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Flame;
  value: string;
  label: string;
}) => (
  <div className="arcade-profile-stat">
    <Icon className="h-4 w-4 text-accent" />
    <strong>{value}</strong>
    <span>{label}</span>
  </div>
);

const LangToggle = ({ compact = false }: { compact?: boolean }) => {
  const { i18n } = useTranslation();
  const isZh = (i18n.resolvedLanguage ?? i18n.language).startsWith("zh");
  const accessibleLabel = isZh ? "Switch to English" : "切换到中文";
  return (
    <button
      type="button"
      onClick={() => i18n.changeLanguage(isZh ? "en" : "zh")}
      className={`arcade-lang-toggle${compact ? " is-compact" : ""}`}
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <span>{compact ? (isZh ? "EN" : "中文") : accessibleLabel}</span>
    </button>
  );
};

const AccentPicker = () => {
  const { accent, setAccent } = useAccentStore();

  return (
    <div className="relative flex items-center gap-2">
      {ACCENT_PRESETS.map((preset) => (
        <button
          key={preset.value}
          onClick={() => setAccent(preset.value)}
          aria-label={`Set accent ${preset.name}`}
          className="h-4 w-4 rounded-full transition-transform hover:scale-125"
          style={{
            background: preset.value,
            boxShadow:
              accent === preset.value
                ? `0 0 0 2px #0a0711, 0 0 0 3px ${preset.value}`
                : undefined,
          }}
          title={preset.name}
        />
      ))}
    </div>
  );
};
