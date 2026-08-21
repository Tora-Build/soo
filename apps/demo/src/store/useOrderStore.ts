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

interface OrderState {
    activeOrders: ActiveOrder[];
    addOrder: (order: ActiveOrder) => void;
    removeOrder: (id: string) => void;
    clearOrders: () => void;
}

export const useOrderStore = create<OrderState>()(
    persist(
        (set) => ({
            activeOrders: [],
            addOrder: (order) => set((state) => {
                if (state.activeOrders.some(o => o.id === order.id)) return state;
                return { activeOrders: [order, ...state.activeOrders] };
            }),
            removeOrder: (id) => set((state) => ({
                activeOrders: state.activeOrders.filter(o => o.id !== id)
            })),
            clearOrders: () => set({ activeOrders: [] }),
        }),
        {
            name: 'sooth-active-orders',
            version: 3,
            // Carries activeOrders across every earlier shape; anything else
            // the older versions persisted is dropped.
            migrate: (persisted: unknown) => ({
                activeOrders: (persisted as Partial<OrderState>)?.activeOrders ?? [],
            }),
        }
    )
);
