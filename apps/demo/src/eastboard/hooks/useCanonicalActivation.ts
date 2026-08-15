// Activating a cell = creating its market, through the demo's proven path.
//
// Upstream's activation was a five-step EVM machine: MOSS session, USDC
// approve, prepareMarket, pump rounds, canonical registration. On Solana the
// whole thing is ONE transaction — `create_market` composes the vaults, AMM
// state and lifecycle in a single instruction, and the question text rides in
// it, verified against its hash by the program. So this hook is deliberately
// small: the same `writeContractAsync({ functionName: "createMarket" })` call
// the Launchpad page has been making against devnet all along, prefilled from
// the option template.
//
// The step model the wizard renders collapses to two: sign, confirm.

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAccount, useWriteContract } from "@/lib/chain-shim";
import { ABIS } from "../../config/abis";
import { useDeployments } from "../../hooks/useDeployments";
import type { OptionTemplate } from "../core";

export type ActivationStepState = "idle" | "pending" | "done" | "error";

export interface CanonicalActivation {
  connected: boolean;
  pending: boolean;
  message: string | null;
  marketAddress: `0x${string}` | null;
  stepState: ActivationStepState;
  activate: () => Promise<void>;
}

export function useCanonicalActivation(
  template: OptionTemplate,
  existingMarketAddress?: `0x${string}`,
): CanonicalActivation {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { contracts } = useDeployments();
  const queryClient = useQueryClient();

  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stepState, setStepState] = useState<ActivationStepState>("idle");
  const [marketAddress, setMarketAddress] = useState<`0x${string}` | null>(
    existingMarketAddress ?? null,
  );

  const activate = useCallback(async () => {
    if (!address) {
      setMessage("Connect a wallet first.");
      return;
    }
    setPending(true);
    setStepState("pending");
    setMessage(null);
    try {
      // Identical shape to Launchpad.tsx's deploy call: the shim's
      // `dispatchCreateMarket` reads [question, startTime, deadline,
      // adjudicator, bWad, probabilityWad, config] and builds the Solana
      // create_market from it. The template's deadline is the exchange close
      // plus the attestation window, exactly as upstream encoded it.
      const startTime = BigInt(Math.floor(Date.now() / 1000));
      await writeContractAsync({
        address: contracts.LaunchpadEngine as `0x${string}`,
        abi: ABIS.LaunchpadEngine,
        functionName: "createMarket",
        args: [
          template.question,
          startTime,
          BigInt(template.cfgDeadline),
          address,
          template.bBaseWad,
          template.probabilityWad,
          "0x",
        ],
      });

      // The shim stashes the new market PDA on the same side channel the
      // Launchpad reads.
      const pda = (
        globalThis as unknown as { __lastCreatedMarketPda?: string }
      ).__lastCreatedMarketPda;
      if (pda) setMarketAddress(`0x${pda}` as `0x${string}`);
      setStepState("done");
      setMessage(null);
      // The grid re-derives cell status from the market list.
      await queryClient.invalidateQueries();
    } catch (err) {
      setStepState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, [address, contracts, template, writeContractAsync, queryClient]);

  return {
    connected: isConnected,
    pending,
    message,
    marketAddress,
    stepState,
    activate,
  };
}
