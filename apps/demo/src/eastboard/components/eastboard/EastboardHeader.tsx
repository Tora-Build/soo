import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSimulationStore } from "../../store/useSimulationStore";
import { isEastboardFixtureMode } from "../../lib/fixtureMode";
import { WalletButton } from "./WalletButton";

export function EastboardHeader() {
  const { t, i18n } = useTranslation();
  const chinese = i18n.resolvedLanguage?.startsWith("zh") ?? false;
  const numberLocale = chinese ? "zh-CN" : "en-US";
  const balance = useSimulationStore((state) => state.balance);
  const fixtureMode = isEastboardFixtureMode();
  const route = (pathname: string) =>
    fixtureMode ? `${pathname}?fixtures` : pathname;
  // `/portfolio` belongs to the classic demo's portfolio page, so the
  // eastboard one lives at /positions. The faucet is the demo's real
  // dual-token faucet — eastboard never had a Solana one, and the demo's
  // dispenses exactly the tokens these markets trade.
  // The Eastboard shell IS the app now — its nav covers the whole Solana
  // surface, not just the option chain.
  const navigation = fixtureMode
    ? [
        [route("/options"), t("eastboard.nav.chain")],
        [route("/positions"), t("eastboard.nav.positions")],
        ["/faucet", t("eastboard.nav.faucet")],
      ]
    : [
        ["/options", t("eastboard.nav.chain")],
        ["/markets", t("eastboard.nav.markets")],
        ["/launchpad", t("eastboard.nav.launch")],
        ["/portfolio", t("eastboard.nav.portfolio")],
        ["/faucet", t("eastboard.nav.faucet")],
      ];

  return (
    <header className="sticky top-0 z-sticky border-b border-rule bg-canvas/90 backdrop-blur-xl">
      <div className="mx-auto flex h-[72px] w-full max-w-[1480px] items-center justify-between gap-4 px-4 md:px-7 lg:px-10">
        <div className="flex min-w-0 items-center gap-7">
          <NavLink
            to={route("/options")}
            className="group flex items-center gap-3"
          >
            <img
              src="/eastboard-icon.svg"
              alt=""
              aria-hidden="true"
              className="h-9 w-9 transition-transform group-active:scale-[0.98]"
            />
            <span>
              <strong className="block font-heading text-base uppercase tracking-[-0.04em] text-ink">
                EastBoard
              </strong>
              <small className="block font-mono text-[8px] uppercase tracking-[0.2em] text-accent">
                {t("eastboard.header.tagline")}
              </small>
            </span>
          </NavLink>
          <nav
            className="hidden items-center gap-1 md:flex"
            aria-label={t("eastboard.header.primaryNavigation")}
          >
            {navigation.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.11em] transition-colors ${
                    isActive ? "text-accent" : "text-muted hover:text-ink"
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {fixtureMode && (
            <span className="hidden border border-rule bg-inset px-3 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-muted lg:block">
              {t("eastboard.header.fixtureBalance", {
                amount: balance.toLocaleString(numberLocale, {
                  maximumFractionDigits: 2,
                }),
              })}
            </span>
          )}
          <span className="hidden items-center gap-2 border border-rule bg-raised px-3 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-pos" />
            Solana Devnet
          </span>
          <button
            type="button"
            onClick={() => void i18n.changeLanguage(chinese ? "en" : "zh")}
            className="border border-rule px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted transition-colors hover:border-accent hover:text-ink active:translate-y-px"
            aria-label={t("eastboard.header.changeLanguage")}
          >
            {chinese ? "EN" : "中"}
          </button>
          <WalletButton />
        </div>
      </div>
      <nav
        className="flex border-t border-subtle px-4 md:hidden"
        aria-label={t("eastboard.header.mobileNavigation")}
      >
        {navigation.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex-1 py-3 text-center font-mono text-[9px] font-semibold uppercase tracking-[0.11em] ${
                isActive ? "border-b border-accent text-accent" : "text-muted"
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
