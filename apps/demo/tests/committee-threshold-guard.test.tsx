// The committee panel must not offer a transaction that cannot succeed.
//
// `attestor_update` action 2 requires `1 <= value <= set.count`, so on an
// EMPTY roster every threshold is rejected — the button used to build a
// transaction whose only possible outcome was a failed simulation. These
// tests pin the client-side guard, and the leaderboard link that gives a
// creator somewhere to find members in the first place.

import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const writeContractAsync = vi.fn().mockResolvedValue("sig");

let attestorSet:
  | { attestors: string[]; votes: Array<number | null>; threshold: number }
  | null = null;

vi.mock("../src/lib/DemoContext", () => ({
  useDemo: () => ({
    adapter: { readAttestorSet: async () => attestorSet },
  }),
}));

vi.mock("@/lib/chain-shim", () => ({
  useAccount: () => ({ address: "0xAUTHORITY" }),
  useWriteContract: () => ({ writeContractAsync }),
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const { CommitteeControls } = await import(
  "../src/components/features/portfolio/GuardianControls"
);

const open = async (
  set: typeof attestorSet,
): Promise<void> => {
  attestorSet = set;
  render(
    <MemoryRouter>
      <CommitteeControls market="MKT" isEntryAuthority canVoteNow={false} />
    </MemoryRouter>,
  );
  // The panel is collapsed behind its own toggle.
  (await screen.findByRole("button", { name: /committee|convene/i })).click();
};

afterEach(() => {
  cleanup();
  attestorSet = null;
  writeContractAsync.mockClear();
});

test("empty roster: threshold cannot be submitted, and says why", async () => {
  await open(null);

  const input = await screen.findByTestId("attestor-threshold-input");
  expect((input as HTMLInputElement).disabled).toBe(true);

  const setBtn = screen.getByRole("button", { name: /^set$/i });
  expect((setBtn as HTMLButtonElement).disabled).toBe(true);

  expect(screen.getByText(/add at least one member first/i)).toBeTruthy();
  expect(writeContractAsync).not.toHaveBeenCalled();
});

test("with members: threshold is bounded by the roster size", async () => {
  await open({ attestors: ["AAA", "BBB"], votes: [null, null], threshold: 0 });

  const input = (await screen.findByTestId(
    "attestor-threshold-input",
  )) as HTMLInputElement;
  expect(input.disabled).toBe(false);
  // The program rejects a threshold above `count`, so the control cannot offer one.
  expect(input.getAttribute("max")).toBe("2");
  expect(screen.queryByText(/add at least one member first/i)).toBeNull();
});

test("members are chosen from the public record, not a blank box", async () => {
  await open(null);
  const link = await screen.findByRole("link", { name: /browse records/i });
  expect(link.getAttribute("href")).toBe("/adjudicators");
});
