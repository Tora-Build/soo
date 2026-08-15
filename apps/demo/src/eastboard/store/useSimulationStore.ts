import { create } from "zustand";
import type { OptionOutcome, OptionTemplate } from "../core";

export interface SimulatedPosition {
  template: OptionTemplate;
  yesShares: number;
  noShares: number;
  totalCost: number;
  status: "live" | "settled" | "redeemed";
  outcome?: OptionOutcome;
  reason?: string;
  rawValue?: string;
  payout?: number;
}

interface SimulationState {
  balance: number;
  activated: Record<string, boolean>;
  positions: Record<string, SimulatedPosition>;
  activate: (template: OptionTemplate) => void;
  placeTrade: (
    template: OptionTemplate,
    outcome: 0 | 1,
    price: number,
    shares: number,
  ) => void;
  settle: (
    templateId: string,
    outcome: OptionOutcome,
    reason: string,
    rawValue: string,
  ) => void;
  redeem: (templateId: string) => void;
  fund: (amount?: number) => void;
  reset: () => void;
}

const INITIAL_BALANCE = 1_000;

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export const useSimulationStore = create<SimulationState>((set) => ({
  balance: INITIAL_BALANCE,
  activated: {},
  positions: {},
  activate: (template) =>
    set((state) => ({
      activated: { ...state.activated, [template.id]: true },
    })),
  placeTrade: (template, outcome, price, shares) =>
    set((state) => {
      const cost = roundMoney(price * shares);
      if (
        !Number.isFinite(cost) ||
        cost <= 0 ||
        cost > state.balance ||
        price <= 0 ||
        price >= 1 ||
        shares <= 0
      ) {
        return state;
      }
      const prior = state.positions[template.id];
      const position: SimulatedPosition = {
        template,
        yesShares: roundMoney((prior?.yesShares ?? 0) + (outcome === 1 ? shares : 0)),
        noShares: roundMoney((prior?.noShares ?? 0) + (outcome === 0 ? shares : 0)),
        totalCost: roundMoney((prior?.totalCost ?? 0) + cost),
        status: "live",
      };
      return {
        balance: roundMoney(state.balance - cost),
        activated: { ...state.activated, [template.id]: true },
        positions: { ...state.positions, [template.id]: position },
      };
    }),
  settle: (templateId, outcome, reason, rawValue) =>
    set((state) => {
      const position = state.positions[templateId];
      if (!position || position.status !== "live") return state;
      return {
        positions: {
          ...state.positions,
          [templateId]: {
            ...position,
            status: "settled",
            outcome,
            reason,
            rawValue,
          },
        },
      };
    }),
  redeem: (templateId) =>
    set((state) => {
      const position = state.positions[templateId];
      if (!position || position.status !== "settled") return state;
      const payout =
        position.outcome === 2
          ? roundMoney((position.yesShares + position.noShares) * 0.5)
          : position.outcome === 1
            ? position.yesShares
            : position.noShares;
      return {
        balance: roundMoney(state.balance + payout),
        positions: {
          ...state.positions,
          [templateId]: { ...position, status: "redeemed", payout },
        },
      };
    }),
  fund: (amount = 1_000) =>
    set((state) => ({ balance: roundMoney(state.balance + amount) })),
  reset: () =>
    set({ balance: INITIAL_BALANCE, activated: {}, positions: {} }),
}));
