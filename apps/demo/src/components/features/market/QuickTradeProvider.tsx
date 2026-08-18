/**
 * QuickTradeProvider — context that lets any market card open a centered
 * Dialog with the FULL AMM (or Order Book) trading surface for that
 * market pre-loaded. Keeps the same `useQuickTrade()` hook contract that
 * existing market cards already call, so no consumer changes are needed.
 *
 * The modal body is the same `AMMPageBody` / `OrderbookPageBody`
 * components the standalone /amm/:addr and /orderbook/:addr routes
 * render — single source of truth. The AMM/Orderbook toggle in the
 * shared `TradingContextBar` swaps the body in place inside the modal
 * (via the `onModeChange` callback) instead of navigating away.
 *
 * Callers can also pass an arcade presentation (the "megaeth" variant +
 * cover art), a preselected YES/NO outcome, and a confirmed-trade callback
 * — the Arena deck uses all three so the modal reads as part of the game
 * and scored plays flow back to the player ledger.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Dialog } from "../../ui/Dialog";
import { AMMPageBody } from "./AMMPageBody";
import { OrderbookPageBody } from "./OrderbookPageBody";
import { useOnChainMarkets } from "../../../hooks/useOnChainMarkets";
import type { ConfirmedArenaTrade } from "../../../features/arena/types";

type QuickTradeVariant = "default" | "megaeth";
type QuickTradeCoverTone = "amber" | "mint" | "blue";

interface QuickTradePresentation {
  coverImageSrc?: string;
  coverTone?: QuickTradeCoverTone;
  coverTitle?: string;
  coverLabel?: string;
}

interface QuickTradeContextValue {
  open: (
    address: string,
    defaultMode?: "amm" | "orderbook",
    variant?: QuickTradeVariant,
    presentation?: QuickTradePresentation,
    defaultOutcome?: "yes" | "no",
    onTradeConfirmed?: (trade: ConfirmedArenaTrade) => void | Promise<void>,
  ) => void;
  close: () => void;
}

const QuickTradeContext = createContext<QuickTradeContextValue | null>(null);

export function useQuickTrade() {
  const ctx = useContext(QuickTradeContext);
  if (!ctx) {
    throw new Error("useQuickTrade must be used within QuickTradeProvider");
  }
  return ctx;
}

// Market addresses here are 0x-wrapped base58 — base58 is case-sensitive, so
// two addresses are the same market only when the strings match exactly. The
// market list and every open() caller draw from the same useOnChainMarkets
// data, so exact comparison is also sufficient.
const sameMarket = (a: string, b: string) => a === b;

interface QuickTradeProviderProps {
  children: ReactNode;
}

export const QuickTradeProvider = ({ children }: QuickTradeProviderProps) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"amm" | "orderbook">("amm");
  const [variant, setVariant] = useState<QuickTradeVariant>("default");
  const [presentation, setPresentation] =
    useState<QuickTradePresentation | null>(null);
  const [defaultOutcome, setDefaultOutcome] = useState<"yes" | "no">("yes");
  const [onTradeConfirmed, setOnTradeConfirmed] = useState<
    ((trade: ConfirmedArenaTrade) => void | Promise<void>) | undefined
  >();
  // True while a graduation-based mode upgrade may still apply: when the
  // market list has not resolved the clicked market yet, the modal opens on
  // the requested mode and hops to the orderbook as soon as `isGraduated`
  // is known. Any explicit toggle by the user cancels the pending hop.
  const [autoModePending, setAutoModePending] = useState(false);
  const { markets } = useOnChainMarkets();

  const open = useCallback(
    (
      address: string,
      defaultMode: "amm" | "orderbook" = "amm",
      nextVariant: QuickTradeVariant = "default",
      nextPresentation?: QuickTradePresentation,
      nextOutcome: "yes" | "no" = "yes",
      nextOnTradeConfirmed?: (
        trade: ConfirmedArenaTrade,
      ) => void | Promise<void>,
    ) => {
      // A graduated market has no live AMM curve — it trades on the book.
      // Opening it on the AMM would show a dead venue, so the request is
      // upgraded to the orderbook whenever graduation is already known.
      const targetMarket = markets.find((m) => sameMarket(m.address, address));
      const initialMode =
        defaultMode === "amm" && targetMarket?.isGraduated
          ? "orderbook"
          : defaultMode;
      setSelected(address);
      setMode(initialMode);
      setVariant(nextVariant);
      setPresentation(nextPresentation ?? null);
      setDefaultOutcome(nextOutcome);
      setOnTradeConfirmed(() => nextOnTradeConfirmed);
      setAutoModePending(true);
    },
    [markets],
  );
  const close = useCallback(() => {
    setSelected(null);
    setVariant("default");
    setPresentation(null);
    setDefaultOutcome("yes");
    setOnTradeConfirmed(undefined);
    setAutoModePending(false);
  }, []);

  const value = useMemo<QuickTradeContextValue>(
    () => ({ open, close }),
    [open, close],
  );

  // Look up the market metadata so we can decide whether the orderbook
  // tab should be reachable. Bonding markets have no SoothBook listing,
  // so force them back to the AMM mode.
  const market = useMemo(() => {
    if (!selected) return null;
    return markets.find((m) => sameMarket(m.address, selected)) ?? null;
  }, [markets, selected]);

  useEffect(() => {
    if (mode === "orderbook" && market && !market.isGraduated) {
      setMode("amm");
      setAutoModePending(false);
    }
  }, [mode, market]);

  useEffect(() => {
    if (!autoModePending || !market) return;
    setAutoModePending(false);
    if (market.isGraduated && mode === "amm") {
      setMode("orderbook");
    }
  }, [autoModePending, market, mode]);

  const handleModeChange = useCallback((next: "amm" | "orderbook") => {
    setAutoModePending(false);
    setMode(next);
  }, []);

  const megaethCover =
    variant === "megaeth" && presentation
      ? {
          imageSrc: presentation.coverImageSrc,
          imageTone: presentation.coverTone,
          title: presentation.coverTitle,
          label: presentation.coverLabel,
        }
      : undefined;

  return (
    <QuickTradeContext.Provider value={value}>
      {children}
      <Dialog
        isOpen={!!selected}
        onClose={close}
        maxWidth="max-w-7xl"
        className={
          variant === "megaeth" ? "megaeth-quick-trade-dialog" : undefined
        }
        hideHeader
      >
        {selected &&
          (mode === "amm" ? (
            <AMMPageBody
              marketAddress={selected}
              onModeChange={handleModeChange}
              onClose={close}
              onSelectMarket={(addr) => setSelected(addr)}
              variant={variant}
              megaethCover={megaethCover}
              initialOutcome={defaultOutcome}
              onTradeConfirmed={onTradeConfirmed}
            />
          ) : (
            <OrderbookPageBody
              marketAddress={selected}
              onModeChange={handleModeChange}
              onClose={close}
              variant={variant}
              megaethCover={megaethCover}
              initialOutcome={defaultOutcome}
              onTradeConfirmed={onTradeConfirmed}
            />
          ))}
      </Dialog>
    </QuickTradeContext.Provider>
  );
};
