import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface HiddenMarketsState {
  /** Set of lowercase market addresses that are hidden from the dapp */
  hiddenMarkets: Set<string>;
  /** Hide a market by address */
  hideMarket: (address: string) => void;
  /** Show a previously hidden market */
  showMarket: (address: string) => void;
  /** Toggle market visibility */
  toggleMarket: (address: string) => void;
  /** Check if a market is hidden */
  isHidden: (address: string) => boolean;
}

export const useHiddenMarketsStore = create<HiddenMarketsState>()(
  persist(
    (set, get) => ({
      hiddenMarkets: new Set<string>(),
      hideMarket: (address) =>
        set((state) => {
          const next = new Set(state.hiddenMarkets);
          next.add(address.toLowerCase());
          return { hiddenMarkets: next };
        }),
      showMarket: (address) =>
        set((state) => {
          const next = new Set(state.hiddenMarkets);
          next.delete(address.toLowerCase());
          return { hiddenMarkets: next };
        }),
      toggleMarket: (address) => {
        const lower = address.toLowerCase();
        if (get().hiddenMarkets.has(lower)) {
          get().showMarket(lower);
        } else {
          get().hideMarket(lower);
        }
      },
      isHidden: (address) => get().hiddenMarkets.has(address.toLowerCase()),
    }),
    {
      name: 'sooth-hidden-markets',
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(name);
          if (!str) return null;
          const parsed = JSON.parse(str);
          // Deserialize array back to Set
          if (parsed?.state?.hiddenMarkets) {
            parsed.state.hiddenMarkets = new Set(parsed.state.hiddenMarkets);
          }
          return parsed;
        },
        setItem: (name, value) => {
          // Serialize Set to array for JSON
          const serialized = {
            ...value,
            state: {
              ...value.state,
              hiddenMarkets: [...value.state.hiddenMarkets],
            },
          };
          localStorage.setItem(name, JSON.stringify(serialized));
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    },
  ),
);
