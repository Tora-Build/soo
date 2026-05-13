import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ActiveOrder {
    id: string;
    marketAddress: `0x${string}`;
    marketName: string;
    outcome: 0 | 1;
    price: number;
    amount: number;
    timestamp: number;
    isBuy: boolean;
    escrow?: boolean;
    hash?: string;
}

// Maximum number of preFill entries to keep. Entries are trimmed oldest-first
// when this limit is exceeded (each partial-fill order adds one entry).
const MAX_PREFILL_ENTRIES = 500;

interface OrderState {
    activeOrders: ActiveOrder[];
    // Maps on-chain orderId → shares immediately filled at placement time.
    // Used to show correct fill % for partially-matched resting orders.
    preFillAmounts: Record<string, number>;
    addOrder: (order: ActiveOrder) => void;
    removeOrder: (id: string) => void;
    clearOrders: () => void;
    setPreFillAmount: (orderId: string, amount: number) => void;
}

export const useOrderStore = create<OrderState>()(
    persist(
        (set) => ({
            activeOrders: [],
            preFillAmounts: {},
            addOrder: (order) => set((state) => {
                if (state.activeOrders.some(o => o.id === order.id)) return state;
                return { activeOrders: [order, ...state.activeOrders] };
            }),
            removeOrder: (id) => set((state) => ({
                activeOrders: state.activeOrders.filter(o => o.id !== id)
            })),
            clearOrders: () => set({ activeOrders: [] }),
            setPreFillAmount: (orderId, amount) => set((state) => {
                const next = { ...state.preFillAmounts, [orderId]: amount };
                const keys = Object.keys(next);
                if (keys.length > MAX_PREFILL_ENTRIES) {
                    // Drop oldest keys (insertion order is preserved in JS objects)
                    const excess = keys.length - MAX_PREFILL_ENTRIES;
                    for (let i = 0; i < excess; i++) delete next[keys[i]];
                }
                return { preFillAmounts: next };
            }),
        }),
        {
            name: 'sooth-active-orders',
            version: 2,
            // Preserve activeOrders when upgrading from v1; add empty preFillAmounts.
            migrate: (persisted: unknown) => ({
                activeOrders: (persisted as Partial<OrderState>)?.activeOrders ?? [],
                preFillAmounts: {},
            }),
        }
    )
);
