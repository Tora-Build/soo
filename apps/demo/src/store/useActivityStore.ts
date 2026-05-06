import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ActivityItem {
  id: string;
  type: 'trade' | 'orderbook' | 'settle' | 'dispute' | 'liquidity' | 'deposit' | 'withdraw' | 'claim' | 'settlement_root' | 'admin';
  market: string;
  description: string;
  time: string;
  hash?: string;
  mode: 'real' | 'demo';
  timestamp: number;
  chainId?: number;
}

interface ActivityState {
  activities: ActivityItem[];
  addActivity: (activity: Omit<ActivityItem, 'id' | 'time'>) => void;
}

export const useActivityStore = create<ActivityState>()(
  persist(
    (set) => ({
      activities: [],
      addActivity: (activity) => set((state) => {
        // Prevent exact duplicates based on hash + type
        if (activity.hash && state.activities.some(a => a.hash === activity.hash && a.type === activity.type)) {
          return state;
        }
        
        const newActivity: ActivityItem = {
          ...activity,
          id: Math.random().toString(36).substr(2, 9),
          time: 'Just now', // We'll update this dynamically or just use timestamp
        };
        return { activities: [newActivity, ...state.activities].slice(0, 50) }; // Keep last 50
      }),
    }),
    {
      name: 'sooth-activity-log',
    }
  )
);
