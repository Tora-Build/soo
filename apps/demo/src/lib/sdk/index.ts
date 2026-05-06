// Chain-locked: the upstream SDK terminal commands (`balance`, `mint`,
// `createmarket`, `buyyes`, …) are EVM-specific. The Solana fork stubs the
// SDK to a no-op surface so the Geek page renders with the upstream's
// terminal layout, but every command returns "not available in Solana fork".

export type {
  OutputLine,
  OutputLineType,
  OutputCallback,
  CommandResult,
} from "@/lib/chain-shim";

import type { CommandResult, OutputLine } from "@/lib/chain-shim";

const STUB_LINE: OutputLine = {
  type: "warn",
  text: "Solana fork: SDK terminal commands are not implemented. Use the AMM page for the buy-flow happy path.",
};

function stubResult(): { result: CommandResult; output: OutputLine[] } {
  return {
    result: {
      success: false,
      message: "Not available in Solana fork",
    },
    output: [STUB_LINE],
  };
}

// `SoothSDK` mirrors upstream's class shape so the Geek page's terminal
// commands route through it. Each method returns the "not available"
// stub; the upstream renderer prints it like any other output.
export class SoothSDK {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(..._args: any[]) {}

  setAddress(_addr: string): void {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setWalletClient(_wc: any): void {}

  getMarketInfo(): { marketKey?: string; marketAddress?: string } {
    return {};
  }
  getChainId(): number {
    return 1;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getContracts(): Record<string, any> {
    return {};
  }

  async setMarket(_keyOrIndex: string) {
    return stubResult();
  }
  async sbSetMarket(_keyOrIndex: string) {
    return stubResult();
  }
  async balance() {
    return stubResult();
  }
  async mint(..._args: unknown[]) {
    return stubResult();
  }
  async approve(..._args: unknown[]) {
    return stubResult();
  }
  async allowance() {
    return stubResult();
  }
  async createmarket(..._args: unknown[]) {
    return stubResult();
  }
  async graduate(..._args: unknown[]) {
    return stubResult();
  }
  async simulate(..._args: unknown[]) {
    return stubResult();
  }
  async marketstatus(..._args: unknown[]) {
    return stubResult();
  }
  async trialstatus(..._args: unknown[]) {
    return stubResult();
  }
  async dismiss(..._args: unknown[]) {
    return stubResult();
  }
  async claimrefund(..._args: unknown[]) {
    return stubResult();
  }
  async lpbalance(..._args: unknown[]) {
    return stubResult();
  }
  async redeemlp(..._args: unknown[]) {
    return stubResult();
  }
  async transferlp(..._args: unknown[]) {
    return stubResult();
  }
  async pausestatus(..._args: unknown[]) {
    return stubResult();
  }
  async buyyes(..._args: unknown[]) {
    return stubResult();
  }
  async buyno(..._args: unknown[]) {
    return stubResult();
  }
  async sbmint(..._args: unknown[]) {
    return stubResult();
  }
  async sbmerge(..._args: unknown[]) {
    return stubResult();
  }
  async sbcancel(..._args: unknown[]) {
    return stubResult();
  }
  async sbredeem(..._args: unknown[]) {
    return stubResult();
  }
  async sbbook(..._args: unknown[]) {
    return stubResult();
  }
  async sbbalance(..._args: unknown[]) {
    return stubResult();
  }
  async sbstate(..._args: unknown[]) {
    return stubResult();
  }
  async sbprice(..._args: unknown[]) {
    return stubResult();
  }
  async sbhistory(..._args: unknown[]) {
    return stubResult();
  }

  async executeCommand(
    _input: string,
  ): Promise<{ result: CommandResult; output: OutputLine[] }> {
    return stubResult();
  }
}
