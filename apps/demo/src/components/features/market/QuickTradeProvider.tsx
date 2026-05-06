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
  useState,
  type ReactNode,
} from "react";
import { Dialog } from "../../ui/Dialog";
import { AMMPageBody } from "./AMMPageBody";
import { OrderbookPageBody } from "./OrderbookPageBody";
import { useOnChainMarkets } from "../../../hooks/useOnChainMarkets";

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
  const { markets } = useOnChainMarkets();

  const open = useCallback(
    (address: string, defaultMode: "amm" | "orderbook" = "amm") => {
      setSelected(address);
      setMode(defaultMode);
    },
    [],
  );
  const close = useCallback(() => setSelected(null), []);

  const value = useMemo<QuickTradeContextValue>(
    () => ({ open, close }),
    [open, close],
  );

  // Look up the market metadata so we can decide whether the orderbook
  // tab should be reachable. Bonding markets have no SoothBook listing,
  // so force them back to the AMM mode.
  const market = useMemo(() => {
    if (!selected) return null;
    return (
      markets.find((m) => m.address.toLowerCase() === selected.toLowerCase()) ??
      null
    );
  }, [markets, selected]);

  useEffect(() => {
    if (mode === "orderbook" && market && !market.isGraduated) {
      setMode("amm");
    }
  }, [mode, market]);

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
