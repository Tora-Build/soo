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
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog } from "../../ui/Dialog";
import { AMMPageBody } from "./AMMPageBody";
import { OrderbookPageBody } from "./OrderbookPageBody";
import { useIsGraduated } from "../../../hooks/useIsGraduated";

interface QuickTradeContextValue {
  open: (address: string, defaultMode?: "amm" | "orderbook") => void;
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

interface QuickTradeProviderProps {
  children: ReactNode;
}

export const QuickTradeProvider = ({ children }: QuickTradeProviderProps) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"amm" | "orderbook">("amm");

  // True when the caller asked for the orderbook but we had to start on the
  // AMM because graduation was not known yet.
  const autoOpenedRef = useRef(false);

  const open = useCallback(
    (address: string, defaultMode: "amm" | "orderbook" = "amm") => {
      setSelected(address);
      setMode(defaultMode);
      autoOpenedRef.current = defaultMode === "orderbook";
    },
    [],
  );
  const close = useCallback(() => setSelected(null), []);

  const value = useMemo<QuickTradeContextValue>(
    () => ({ open, close }),
    [open, close],
  );

  // Which panel a market opens on is decided by the PROGRAM, read directly.
  //
  // This used to search a cached `useOnChainMarkets()` list and force the mode
  // back to "amm" whenever that list said the market was not graduated. Two
  // problems, and both showed up as "the orderbook does not appear on a
  // graduated market":
  //
  //   1. Two sources of truth. `Markets.tsx` picks the initial mode from ITS
  //      copy of `stage`, and this effect then overrode it from a different
  //      fetch. When either was stale, mid-refresh, or had swallowed a read
  //      error into `isGraduated: false`, the panel flipped underneath the
  //      user with nothing explaining why.
  //
  //   2. A market absent from the list — still loading, filtered out, or
  //      dropped because one of its reads failed — left `market` null, so the
  //      guard silently did nothing and the mode depended on who opened it.
  //
  // One read of `isGraduated` for the selected market answers it outright, and
  // the flag is the same one the program gates the book on. Undefined means
  // "not known yet" and is deliberately NOT treated as false — that is what
  // made a graduated market open on the AMM while the answer was still in
  // flight.
  const graduated = useIsGraduated(selected);

  useEffect(() => {
    if (graduated === undefined) return; // still loading — do not guess
    if (mode === "orderbook" && graduated === false) setMode("amm");
    if (mode === "amm" && graduated === true && autoOpenedRef.current) {
      // Opened on the AMM only because graduation was unknown at click time.
      autoOpenedRef.current = false;
      setMode("orderbook");
    }
  }, [mode, graduated]);

  return (
    <QuickTradeContext.Provider value={value}>
      {children}
      <Dialog
        isOpen={!!selected}
        onClose={close}
        maxWidth="max-w-7xl"
        hideHeader
      >
        {selected &&
          (mode === "amm" ? (
            <AMMPageBody
              marketAddress={selected}
              onModeChange={(next) => setMode(next)}
              onClose={close}
              onSelectMarket={(addr) => setSelected(addr)}
            />
          ) : (
            <OrderbookPageBody
              marketAddress={selected}
              onModeChange={(next) => setMode(next)}
              onClose={close}
            />
          ))}
      </Dialog>
    </QuickTradeContext.Provider>
  );
};
