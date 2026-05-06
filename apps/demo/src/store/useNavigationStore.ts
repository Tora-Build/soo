import { create } from 'zustand';

type View = 'landing' | 'about' | 'dapp' | 'launchpad-market';

interface NavigationState {
  currentView: View;
  activeMarketAddress?: string;
  setView: (view: View, marketAddress?: string) => void;
}

export const useNavigationStore = create<NavigationState>()((set) => ({
  currentView: 'landing',
  activeMarketAddress: undefined,
  setView: (view, marketAddress) => set({ currentView: view, activeMarketAddress: marketAddress }),
}));
