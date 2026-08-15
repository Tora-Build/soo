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
  // One read of `isGraduated` for the selected market answers it outright,
  // and the flag is the same one the program gates the book on. A cached
  // market list would be a second source of truth that can be stale,
  // mid-refresh, or missing the market entirely. Undefined means "not known
  // yet" and is deliberately NOT treated as false — treating it as false
  // would open a graduated market on the AMM while the answer is still in
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
