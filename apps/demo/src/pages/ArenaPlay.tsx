import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import toast from "react-hot-toast";
import { formatUnits } from "@/lib/chain-shim";
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  ChevronRight,
  CircleDot,
  Flame,
  Gamepad2,
  MessageCircle,
  Send,
  Share2,
  Sparkles,
  Target,
  Ticket,
  Trophy,
  Users,
  Zap,
} from "lucide-react";
import { useVisibleMarkets } from "../hooks";
import { useAmmMarketDirect } from "../hooks/useAmmMarketDirect";
import type { OnChainMarket } from "../hooks/useOnChainMarkets";
import {
  CATEGORY_IDS,
  CATEGORY_LABELS,
  inferCategory,
  normalizeCategory,
} from "../lib/categories";
import { cn } from "../lib/utils";
import { Drawer } from "../components/ui/Drawer";
import { EntityIcon } from "../components/ui/EntityIcon";
import { StageBadge } from "../components/ui/StageBadge";
import { useQuickTrade } from "../components/features/market/QuickTradeProvider";
import { useArenaPlayer } from "../features/arena/ArenaPlayerProvider";
import {
  refreshSeasonLeaderboard,
  useSeasonLeaderboard,
  type SeasonLeaderboard,
} from "../features/arena/useSeasonLeaderboard";
import type { WalletScore } from "../features/arena/scoring";
import {
  ARENA_RANKS,
  levelFromXp,
  levelProgressFromXp,
  rankIndexFromLevel,
  useArenaPlayerStore,
  XP_PER_LEVEL,
} from "../store/useArenaPlayerStore";
import { shortenAddress } from "../utils/format";
import type {
  ArenaOutcome,
  ArenaReaction,
  ArenaSocial,
} from "../features/arena/types";
import { resolveDeckSwipe } from "../features/arena/gestures";

type ArenaMarket = OnChainMarket & { arenaCategory: string };

// Arcade cover tones per world — drives the tinted ring in the modal's
// context bar and the gradient wash on the trading panel cover.
const WORLD_TONES: Record<string, "amber" | "mint" | "blue"> = {
  sports: "mint",
  tech: "blue",
  cultures: "mint",
  crypto: "amber",
  politics: "amber",
  weather: "blue",
  others: "amber",
};

// Self-contained cover art: the world's glyph as an inline SVG data URI.
// The megaeth cover CSS layers its own tone gradients over the image, so a
// transparent glyph is all the artwork the modal needs — no remote assets.
const worldCoverArt = (category: string) => {
  const glyph = WORLD_ICONS[category] ?? WORLD_ICONS.others;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'>` +
    `<text x='48' y='62' font-size='44' text-anchor='middle' fill='#ffffff' fill-opacity='0.85'>${glyph}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

const WORLD_ICONS: Record<string, string> = {
  all: "✦",
  sports: "⚽",
  tech: "⌘",
  cultures: "★",
  crypto: "₿",
  politics: "♜",
  weather: "☼",
  others: "◉",
};

export const ArenaPlay = () => {
  const { markets: rawMarkets, isLoading, error } = useVisibleMarkets();
  const [category, setCategory] = useState("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [isReacting, setIsReacting] = useState(false);
  const { open: openQuickTrade } = useQuickTrade();
  const {
    wallet,
    profile,
    socialByMarket,
    connectWallet,
    authenticate,
    refresh,
    toggleReaction,
    postComment,
    registerConfirmedPlay,
  } = useArenaPlayer();
  // Device-local XP ledger — the scoring fallback when no arena server is
  // configured (guest mode).
  const recordLocalPlay = useArenaPlayerStore((state) => state.playMarket);
  // Chain-derived season board: every wallet's plays, decoded from program
  // events. Feeds the sidecar and the level-up moment below.
  const seasonBoard = useSeasonLeaderboard();

  // When the connected wallet's derived level rises while the app is open
  // (its own trade landing, usually), celebrate it. The first observed level
  // is a baseline, not a level-up.
  const chainLevel = seasonBoard.you?.level ?? null;
  const prevChainLevel = useRef<number | null>(null);
  useEffect(() => {
    if (chainLevel === null) return;
    const prev = prevChainLevel.current;
    prevChainLevel.current = chainLevel;
    if (prev !== null && chainLevel > prev) {
      toast.custom(
        <div className="play-xp-pop">
          <Sparkles className="h-4 w-4" />
          <span>Level up</span>
          <strong>LEVEL UP — LV {chainLevel}</strong>
        </div>,
        { duration: 3200 },
      );
    }
  }, [chainLevel]);

  const markets = useMemo<ArenaMarket[]>(
    () =>
      rawMarkets
        .map((market) => ({
          ...market,
          arenaCategory: normalizeCategory(
            market.category?.toLowerCase() || inferCategory(market.question),
          ),
        }))
        .sort((a, b) => {
          const aLive = a.stage === "live" ? 1 : 0;
          const bLive = b.stage === "live" ? 1 : 0;
          if (aLive !== bLive) return bLive - aLive;
          return Number(b.bCurrent - a.bCurrent);
        }),
    [rawMarkets],
  );

  const deck = useMemo(
    () =>
      category === "all"
        ? markets
        : markets.filter((market) => market.arenaCategory === category),
    [category, markets],
  );
  const activeMarket = deck[activeIndex] ?? null;
  const social = activeMarket
    ? socialByMarket[activeMarket.address]
    : undefined;

  useEffect(() => setActiveIndex(0), [category]);

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, Math.max(0, deck.length - 1)),
    );
  }, [deck.length]);

  const moveDeck = useCallback(
    (direction: 1 | -1) => {
      if (deck.length <= 1) return;
      setActiveIndex(
        (current) => (current + direction + deck.length) % deck.length,
      );
    },
    [deck.length],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowRight") moveDeck(1);
      if (event.key === "ArrowLeft") moveDeck(-1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveDeck]);

  useEffect(() => {
    if (!activeMarket) return;
    void refresh(activeMarket.address, true);
    const timer = window.setInterval(
      () => void refresh(activeMarket.address, true),
      12_000,
    );
    return () => window.clearInterval(timer);
  }, [activeMarket, refresh]);

  const enterMarket = async (market: ArenaMarket, outcome: ArenaOutcome) => {
    if (outcome !== "watch") {
      if (!wallet) {
        connectWallet();
        toast("Connect a wallet to make a scored play");
        return;
      }
      if (profile && profile.tickets < 1) {
        toast.error("No play tickets left · claim your daily drop");
        return;
      }
      try {
        await authenticate();
      } catch (error) {
        // Sign-in exists for SCORING — the arena server binds plays to a
        // profile. The trade itself is on-chain and needs no server, so when
        // the social service is absent (or down) the play proceeds unscored
        // rather than walling off real markets behind a dead endpoint.
        const message =
          error instanceof Error ? error.message : "Wallet sign-in failed";
        if (/not configured|not-configured/i.test(message)) {
          toast("Playing unscored — arena service not configured", {
            icon: "🎮",
          });
        } else {
          toast.error(message);
          return;
        }
      }
    }

    // The modal is the same real AMM/book surface every other page uses,
    // dressed in the arcade ("megaeth") presentation so it reads as part of
    // the game: cover art + tone from the market's world, the player's
    // chosen side preselected, and a confirmed-trade callback that scores
    // the play. Scoring goes to the arena server when one is configured;
    // otherwise the persisted local ledger keeps XP flowing for guests.
    openQuickTrade(
      market.address,
      market.stage === "live" ? "orderbook" : "amm",
      "megaeth",
      {
        coverImageSrc: worldCoverArt(market.arenaCategory),
        coverTone: WORLD_TONES[market.arenaCategory] ?? "amber",
        coverTitle: market.question,
        coverLabel: `${market.arenaCategory} world`,
      },
      outcome === "no" ? "no" : "yes",
      outcome === "watch"
        ? undefined
        : async (trade) => {
            // The trade is confirmed on chain — pull the season board fresh
            // so the play lands on the leaderboard without waiting a poll.
            void refreshSeasonLeaderboard();
            const toastId = toast.loading("Verifying your arena play…");
            try {
              const gainedXp = await registerConfirmedPlay(trade);
              if (gainedXp === 0) {
                toast.success("Play already scored", { id: toastId });
                return;
              }
              toast.custom(
                <div className="play-xp-pop">
                  <Sparkles className="h-4 w-4" />
                  <span>
                    {gainedXp > 10 ? "New reality scored" : "Signal replayed"}
                  </span>
                  <strong>+{gainedXp} XP</strong>
                </div>,
                { id: toastId, duration: 2600 },
              );
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : "Arena scoring failed";
              if (!/not configured|not-configured/i.test(message)) {
                toast.error(message, { id: toastId });
                return;
              }
              // No arena server — the persisted local ledger scores the
              // play instead, so the HUD still levels up in guest mode.
              const gainedXp = recordLocalPlay(trade.market, trade.outcome);
              toast.custom(
                <div className="play-xp-pop">
                  <Sparkles className="h-4 w-4" />
                  <span>
                    {gainedXp > 10 ? "New reality scored" : "Signal replayed"}
                  </span>
                  <strong>+{gainedXp} XP</strong>
                </div>,
                { id: toastId, duration: 2600 },
              );
            }
          },
    );
  };

  const react = async (next: ArenaReaction) => {
    if (!activeMarket || isReacting) return;
    setIsReacting(true);
    try {
      await toggleReaction(activeMarket.address, next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reaction failed");
    } finally {
      setIsReacting(false);
    }
  };

  const shareMarket = async () => {
    if (!activeMarket) return;
    const shareData = {
      title: "Play this reality on Sooth",
      text: activeMarket.question,
      url: window.location.href,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(
          `${shareData.text} — ${shareData.url}`,
        );
        toast.success("Play link copied");
      }
    } catch {
      // Native share cancellation is not an error worth surfacing.
    }
  };

  if (isLoading) {
    return <ArenaLoading />;
  }

  if (error || !activeMarket) {
    return (
      <div className="play-empty-state">
        <Gamepad2 className="h-8 w-8" />
        <h1>Arena is loading a new deck.</h1>
        <p>Live realities will appear automatically when the signal returns.</p>
      </div>
    );
  }

  return (
    <div className="play-shell">
      <header className="play-status-bar">
        <div className="flex min-w-0 items-center gap-3">
          <span className="play-live-pulse" />
          <div className="min-w-0">
            <span>Live deck</span>
            <strong>{deck.length} realities ready</strong>
          </div>
        </div>
        <div className="play-status-center">
          <span>{String(activeIndex + 1).padStart(2, "0")}</span>
          <div>
            <i
              style={{ width: `${((activeIndex + 1) / deck.length) * 100}%` }}
            />
          </div>
          <small>{String(deck.length).padStart(2, "0")}</small>
        </div>
      </header>

      <nav className="play-worlds" aria-label="Choose a world">
        {CATEGORY_IDS.map((item) => {
          const count =
            item === "all"
              ? markets.length
              : markets.filter((market) => market.arenaCategory === item)
                  .length;
          return (
            <button
              key={item}
              type="button"
              className={cn(category === item && "is-active")}
              onClick={() => setCategory(item)}
              disabled={count === 0}
            >
              <span>{WORLD_ICONS[item]}</span>
              <strong>
                {item === "all" ? "For you" : CATEGORY_LABELS[item]}
              </strong>
              <small>{count}</small>
            </button>
          );
        })}
      </nav>

      <div className="play-layout">
        <main className="play-deck-stage">
          <button
            type="button"
            className="play-deck-arrow is-left"
            onClick={() => moveDeck(-1)}
            aria-label="Previous reality"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeMarket.address}
              initial={{ opacity: 0, x: 70, rotate: 1.5, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, x: -70, rotate: -1.5, scale: 0.98 }}
              transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
              className="min-w-0"
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.16}
              dragMomentum={false}
              onDragEnd={(_, info) => {
                const direction = resolveDeckSwipe(info.offset.x, info.velocity.x);
                if (direction) moveDeck(direction);
              }}
            >
              <RealityCard
                market={activeMarket}
                onPlay={(market, outcome) => void enterMarket(market, outcome)}
                onReact={react}
                onShare={shareMarket}
                onOpenComments={() => setCommentsOpen(true)}
                social={social}
                isReacting={isReacting}
              />
            </motion.div>
          </AnimatePresence>

          <button
            type="button"
            className="play-deck-arrow is-right"
            onClick={() => moveDeck(1)}
            aria-label="Next reality"
          >
            <ArrowRight className="h-5 w-5" />
          </button>
        </main>

        <ArenaSidecar board={seasonBoard} />
      </div>

      <div className="play-mobile-next">
        <button type="button" onClick={() => moveDeck(-1)}>
          <ArrowLeft className="h-4 w-4" /> Previous
        </button>
        <span>Swipe the world</span>
        <button type="button" onClick={() => moveDeck(1)}>
          Next <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      <CommentsDrawer
        isOpen={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        market={activeMarket}
        social={social}
        onPost={postComment}
      />
    </div>
  );
};

const RealityCard = ({
  market,
  onPlay,
  onReact,
  onShare,
  onOpenComments,
  social,
  isReacting,
}: {
  market: ArenaMarket;
  onPlay: (market: ArenaMarket, outcome: ArenaOutcome) => void;
  onReact: (reaction: ArenaReaction) => void;
  onShare: () => void;
  onOpenComments: () => void;
  social?: ArenaSocial;
  isReacting: boolean;
}) => {
  const { amm } = useAmmMarketDirect(market.address);
  const yes = amm?.yesProbability ?? 0.5;
  const no = 1 - yes;
  const depth = Number(formatUnits(market.bCurrent, 18));
  const squadLabels = (social?.comments ?? [])
    .slice(0, 3)
    .map((comment) => comment.handle.slice(0, 2).toUpperCase());
  const sentimentCopy = social?.sentiment.total
    ? `${social.sentiment.yesPercent}% of ${social.sentiment.total} players lean YES`
    : "Be the first player to score this reality";

  return (
    <article className={`reality-card is-${market.arenaCategory}`}>
      <div className="reality-scene">
        <WorldScene category={market.arenaCategory} />
        <div className="reality-scene-top">
          <span className="reality-live-tag">
            <CircleDot className="h-3 w-3" /> Live play
          </span>
          <span className="reality-pot">${depth.toFixed(0)} in play</span>
        </div>
        <div className="reality-scene-score">
          <span>SOOTH LIVE</span>
          <strong>{Math.round(yes * 100)}</strong>
          <small>crowd signal</small>
        </div>
      </div>

      <div className="reality-content">
        <div className="reality-question-row">
          <div className="reality-entity">
            <EntityIcon
              question={market.question}
              size="lg"
              market={{ address: market.address, stage: market.stage }}
            />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StageBadge stage={market.stage} />
              <span className="reality-world-label">
                {market.arenaCategory}
              </span>
              {market.event && (
                <span className="reality-event-label">{market.event}</span>
              )}
            </div>
            <h1>{market.question}</h1>
          </div>
        </div>

        <div className="reality-squad-line">
          <div className="play-avatar-stack" aria-hidden="true">
            {[...squadLabels, ...(squadLabels.length ? [] : ["?"])].map((label, index) => (
              <span key={label} style={{ zIndex: 4 - index }}>
                {label}
              </span>
            ))}
          </div>
          <p>
            <strong>{sentimentCopy}</strong>
          </p>
          <span className="reality-hot">
            <Flame className="h-3.5 w-3.5" /> Hot
          </span>
        </div>

        <div className="reality-actions">
          <button
            type="button"
            className="reality-choice is-yes"
            onClick={() => onPlay(market, "yes")}
          >
            <span>
              <small>I believe it</small>
              <strong>YES</strong>
            </span>
            <b>{Math.round(yes * 100)}%</b>
            <ChevronRight className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="reality-choice is-no"
            onClick={() => onPlay(market, "no")}
          >
            <span>
              <small>No chance</small>
              <strong>NO</strong>
            </span>
            <b>{Math.round(no * 100)}%</b>
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>

      <aside className="reality-social" aria-label="React to this play">
        <button
          type="button"
          aria-label="React with fire"
          disabled={isReacting}
          className={cn(social?.viewerReaction === "fire" && "is-active")}
          onClick={() => onReact("fire")}
        >
          <span>🔥</span>
          {/* A zero here means "social service not configured", not "nobody
              reacted" — the count only renders once it has something real. */}
          {(social?.reactions.fire ?? 0) > 0 && (
            <small>{social?.reactions.fire}</small>
          )}
        </button>
        <button
          type="button"
          aria-label="React with insight"
          disabled={isReacting}
          className={cn(social?.viewerReaction === "brain" && "is-active")}
          onClick={() => onReact("brain")}
        >
          <Brain className="h-5 w-5" />
          {(social?.reactions.brain ?? 0) > 0 && (
            <small>{social?.reactions.brain}</small>
          )}
        </button>
        <button
          type="button"
          aria-label="Open player comments"
          onClick={onOpenComments}
        >
          <MessageCircle className="h-5 w-5" />
          {(social?.commentCount ?? 0) > 0 && (
            <small>{social?.commentCount}</small>
          )}
        </button>
        <button type="button" aria-label="Share this market" onClick={onShare}>
          <Share2 className="h-5 w-5" />
          <small>Share</small>
        </button>
      </aside>
    </article>
  );
};

const WorldScene = ({ category }: { category: string }) => (
  <svg
    className="reality-world"
    viewBox="0 0 900 420"
    role="img"
    aria-label={`${category} game world illustration`}
  >
    <defs>
      <linearGradient id="world-floor" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stopColor="rgba(255,255,255,.16)" />
        <stop offset="1" stopColor="rgba(255,255,255,0)" />
      </linearGradient>
      <filter id="world-glow">
        <feGaussianBlur stdDeviation="8" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    <circle className="world-orbit orbit-one" cx="690" cy="200" r="126" />
    <circle className="world-orbit orbit-two" cx="690" cy="200" r="178" />
    <path
      className="world-horizon"
      d="M-20 340 Q450 190 920 340 L920 450 L-20 450Z"
    />

    {category === "sports" && (
      <g className="world-sports">
        <ellipse cx="440" cy="326" rx="350" ry="86" fill="url(#world-floor)" />
        <path d="M160 323 Q440 210 720 323" />
        <path d="M268 367 Q440 286 612 367" />
        <path d="M440 244V410" />
        <circle className="world-ball" cx="696" cy="193" r="63" />
        <path
          className="world-ball-line"
          d="M654 147L712 133 748 178 733 232 676 245 640 202Z"
        />
        <path
          className="world-ball-line"
          d="M712 133L701 193 748 178M701 193L733 232M701 193L676 245M701 193L654 147M701 193L640 202"
        />
        <text x="154" y="190">
          FINAL
        </text>
        <text className="world-score" x="154" y="264">
          90:00
        </text>
      </g>
    )}

    {category === "crypto" && (
      <g className="world-crypto">
        <path
          className="world-chart"
          d="M105 319L220 256 312 282 414 176 510 218 670 104 796 142"
        />
        <circle className="world-coin" cx="676" cy="188" r="102" />
        <text className="world-symbol" x="676" y="226">
          ₿
        </text>
        <circle className="world-satellite" cx="794" cy="84" r="14" />
      </g>
    )}

    {category === "tech" && (
      <g className="world-tech">
        <rect
          className="world-chip"
          x="560"
          y="91"
          width="230"
          height="230"
          rx="46"
        />
        <rect x="616" y="147" width="118" height="118" rx="24" />
        <path d="M606 74V34M660 74V34M714 74V34M768 74V34M606 338V378M660 338V378M714 338V378M768 338V378" />
        <path d="M543 136H503M543 190H503M543 244H503M543 298H503M807 136H847M807 190H847M807 244H847M807 298H847" />
        <circle className="world-node node-one" cx="250" cy="136" r="34" />
        <circle className="world-node node-two" cx="376" cy="240" r="22" />
        <path
          className="world-network"
          d="M250 136L376 240 503 190M250 136L180 290 376 240"
        />
      </g>
    )}

    {category === "politics" && (
      <g className="world-politics">
        <path className="world-dome" d="M532 170Q674 40 816 170Z" />
        <path d="M548 188H800M570 188V338M624 188V338M678 188V338M732 188V338M786 188V338M532 338H818" />
        <rect
          className="world-podium"
          x="180"
          y="184"
          width="220"
          height="194"
          rx="26"
        />
        <circle cx="290" cy="262" r="48" />
        <path d="M290 184V128M268 128H312" />
      </g>
    )}

    {category === "weather" && (
      <g className="world-weather">
        <circle className="world-sun" cx="702" cy="150" r="82" />
        <path
          className="world-cloud"
          d="M155 288Q155 224 222 224Q252 148 336 184Q388 136 454 182Q527 177 543 250Q604 258 604 310H155Z"
        />
        <path
          className="world-lightning"
          d="M375 294L322 376 370 364 346 420 432 326 382 338Z"
        />
        <path
          className="world-rain"
          d="M220 330L195 386M276 330L251 386M490 330L465 386M545 330L520 386"
        />
      </g>
    )}

    {category === "cultures" && (
      <g className="world-culture">
        <path
          className="world-star"
          d="M686 72L721 148 804 156 741 211 760 292 686 250 612 292 631 211 568 156 651 148Z"
        />
        <circle cx="265" cy="217" r="112" />
        <circle cx="265" cy="217" r="28" />
        <circle cx="265" cy="135" r="26" />
        <circle cx="347" cy="217" r="26" />
        <circle cx="265" cy="299" r="26" />
        <circle cx="183" cy="217" r="26" />
        <path d="M376 310H520" />
      </g>
    )}

    {!["sports", "crypto", "tech", "politics", "weather", "cultures"].includes(
      category,
    ) && (
      <g className="world-other">
        <circle className="world-globe" cx="672" cy="204" r="126" />
        <ellipse cx="672" cy="204" rx="52" ry="126" />
        <path d="M546 204H798M566 142H778M566 266H778" />
        <path className="world-comet" d="M104 292Q310 48 548 136" />
        <circle cx="116" cy="282" r="25" />
      </g>
    )}
  </svg>
);

const AVATAR_TONES = ["pink", "cyan", "yellow", "violet"] as const;

/** Medal treatment for the podium; everything below it is plain mono. */
const rankTone = (position: number) =>
  position === 1
    ? "is-gold"
    : position === 2
      ? "is-silver"
      : position === 3
        ? "is-bronze"
        : undefined;

const LeaderRow = ({
  entry,
  position,
  isYou,
  index,
  positionLabel,
}: {
  entry: WalletScore;
  position: number;
  isYou: boolean;
  index: number;
  /** Overrides the plain position number (the pinned "#12 · you" row). */
  positionLabel?: string;
}) => (
  <div className={cn("play-leader-row", isYou && "is-you")}>
    <span className={cn("play-leader-rank", rankTone(position))}>
      {positionLabel ?? position}
    </span>
    <span className={`play-mini-avatar is-${AVATAR_TONES[index % 4]}`}>
      {entry.wallet.slice(0, 2).toUpperCase()}
    </span>
    <div>
      <strong>{shortenAddress(entry.wallet, 4)}</strong>
      <small>
        LV {entry.level} · {entry.rank} · {entry.plays} plays
      </small>
    </div>
    <b>{entry.xp.toLocaleString()} XP</b>
  </div>
);

const ArenaSidecar = ({ board }: { board: SeasonLeaderboard }) => {
  const { wallet: sessionWallet, profile } = useArenaPlayer();
  const [leagueOpen, setLeagueOpen] = useState(false);
  // The local/server ledger is the floor; once the wallet's on-chain history
  // scores higher, the chain number wins. Guest plays stay local.
  const localXp = useArenaPlayerStore((s) => s.xp);
  const localStreak = useArenaPlayerStore((s) => s.streak);
  const localTickets = useArenaPlayerStore((s) => s.tickets);
  const localPlays = useArenaPlayerStore((s) => s.scoutedMarkets.length);
  const baseXp = profile?.xp ?? localXp;
  const chain = board.you;
  const chainWins = chain !== null && chain.xp > baseXp;
  const xp = chainWins ? chain.xp : baseXp;
  const streak = chainWins ? chain.streakDays : (profile?.streak ?? localStreak);
  const plays = chainWins ? chain.plays : (profile?.plays ?? localPlays);
  const tickets = profile?.tickets ?? localTickets;
  const level = levelFromXp(xp);
  const levelTitle = ARENA_RANKS[rankIndexFromLevel(level)];
  const levelProgress = levelProgressFromXp(xp);

  const leaders = board.leaders.slice(0, 5);
  const youOutsideTop = chain !== null && chain.position > 5 ? chain : null;
  const isYou = (entry: WalletScore) =>
    (chain !== null && entry.wallet === chain.wallet) ||
    sessionWallet?.toLowerCase() === entry.wallet.toLowerCase();

  return (
    <aside className="play-sidecar">
      <section className="play-run-card">
        <div className="play-run-orbit" aria-hidden="true" />
        <div className="relative z-[1] flex items-start justify-between">
          <div>
            <span>Your run</span>
            <h2>Level {level} · {levelTitle}</h2>
          </div>
          <strong>{levelProgress}</strong>
        </div>
        <div className="play-run-bar">
          <motion.span
            animate={{ width: `${(levelProgress / XP_PER_LEVEL) * 100}%` }}
          />
        </div>
        <div className="play-run-stats">
          <span>
            <Flame className="h-4 w-4" /> {streak} streak
          </span>
          <span>
            <Ticket className="h-4 w-4" /> {tickets} tickets
          </span>
          <span>
            <Target className="h-4 w-4" /> {plays} plays
          </span>
        </div>
      </section>

      <section className="play-leaderboard">
        <button
          type="button"
          className="play-side-title play-league-open"
          onClick={() => setLeagueOpen(true)}
          aria-label="Open the full signal league"
        >
          <div>
            <span>Live squad</span>
            <h2>Signal league</h2>
          </div>
          <Trophy className="h-5 w-5" />
        </button>
        <div className="mt-4 space-y-2">
          {board.isLoading && leaders.length === 0 && (
            <div aria-hidden="true">
              {[0, 1, 2].map((row) => (
                <div className="play-leader-skeleton" key={row} />
              ))}
            </div>
          )}
          {!board.isLoading && leaders.length === 0 && (
            <div className="play-leader-empty">
              No scored plays yet. Take the first slot.
            </div>
          )}
          {leaders.map((entry, index) => (
            <LeaderRow
              key={entry.wallet}
              entry={entry}
              position={index + 1}
              index={index}
              isYou={isYou(entry)}
            />
          ))}
          {youOutsideTop && (
            <LeaderRow
              entry={youOutsideTop}
              position={youOutsideTop.position}
              positionLabel={`#${youOutsideTop.position} · you`}
              index={3}
              isYou
            />
          )}
        </div>
      </section>

      <section className="play-squad-card">
        <div className="play-side-title">
          <div>
            <span>Season pulse</span>
            <h2>{board.season.totalPlays} verified calls</h2>
          </div>
          <Users className="h-5 w-5" />
        </div>
        <div className="play-pulse-stats">
          <span>
            <strong>{board.season.activeWallets}</strong>
            <small>wallets</small>
          </span>
          <span>
            <strong>${Math.round(board.season.totalVolume).toLocaleString()}</strong>
            <small>volume</small>
          </span>
          <span className="play-squad-reward">S01 live</span>
        </div>
      </section>

      <Drawer
        isOpen={leagueOpen}
        onClose={() => setLeagueOpen(false)}
        title="Signal league — top 25"
        className="play-league-drawer"
      >
        <div className="space-y-2">
          {board.leaders.slice(0, 25).map((entry, index) => (
            <LeaderRow
              key={entry.wallet}
              entry={entry}
              position={index + 1}
              index={index}
              isYou={isYou(entry)}
            />
          ))}
          {board.leaders.length === 0 && (
            <div className="play-leader-empty">
              No scored plays yet this season.
            </div>
          )}
        </div>
      </Drawer>
    </aside>
  );
};

const CommentsDrawer = ({
  isOpen,
  onClose,
  market,
  social,
  onPost,
}: {
  isOpen: boolean;
  onClose: () => void;
  market: ArenaMarket;
  social?: ArenaSocial;
  onPost: (market: string, body: string) => Promise<ArenaSocial>;
}) => {
  const [body, setBody] = useState("");
  const [isPosting, setIsPosting] = useState(false);

  const submit = async () => {
    const text = body.trim();
    if (!text || isPosting) return;
    setIsPosting(true);
    try {
      await onPost(market.address, text);
      setBody("");
      toast.success("Signal posted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Comment failed");
    } finally {
      setIsPosting(false);
    }
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="Live arena chat"
      className="play-comments-drawer"
    >
      <div className="play-comments-market">
        <span>Reality #{market.address.slice(2, 7)}</span>
        <h2>{market.question}</h2>
        {(social?.commentCount ?? 0) > 0 && (
          <p>{social?.commentCount} player signals</p>
        )}
      </div>

      <form
        className="play-comment-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={body}
          maxLength={280}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Drop your read on this reality…"
          aria-label="Write a comment"
        />
        <div>
          <span>{body.length}/280</span>
          <button type="submit" disabled={!body.trim() || isPosting}>
            <Send className="h-4 w-4" />
            {isPosting ? "Posting" : "Send signal"}
          </button>
        </div>
      </form>

      <div className="play-comment-feed">
        {(social?.comments ?? []).length === 0 ? (
          <div className="play-comment-empty">
            <MessageCircle className="h-6 w-6" />
            <strong>No signals yet</strong>
            <span>Start the conversation.</span>
          </div>
        ) : (
          social?.comments.map((comment) => (
            <article key={comment.id}>
              <span>{comment.handle.slice(0, 2).toUpperCase()}</span>
              <div>
                <header>
                  <strong>{comment.handle}</strong>
                  <time>{formatCommentAge(comment.createdAt)}</time>
                </header>
                <p>{comment.body}</p>
              </div>
            </article>
          ))
        )}
      </div>
    </Drawer>
  );
};

const formatCommentAge = (createdAt: number) => {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
};

const ArenaLoading = () => (
  <div className="play-loading">
    <div className="play-loading-orb">
      <Zap className="h-8 w-8" />
    </div>
    <h1>Building your live deck</h1>
    <p>Pulling the strongest signals from every world...</p>
  </div>
);

export default ArenaPlay;
