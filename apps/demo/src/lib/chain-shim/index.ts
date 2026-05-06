// Barrel for the chain-shim. Upstream imports replace `wagmi`, `viem`,
// `@reown/appkit/react`, and `@sooth/sdk/core` with this module.
//
//   `import { useAccount } from "wagmi"` becomes
//   `import { useAccount } from "@/lib/chain-shim"`
//
// The shim is the ONE place EVM-flavored hook signatures are mapped to the
// Solana adapter (see ./wagmi-shim.ts) or to no-op sentinels (see
// ./viem-shim.ts). Re-syncing from upstream amounts to copying the
// component code in and re-running the import substitutions.

export * from "./viem-shim";
export * from "./wagmi-shim";
export * from "./appkit-shim";
export * from "./sooth-sdk-shim";

// Re-export the demo's Solana adapter accessor so the AMM page can
// transition from the wagmi sentinel to a real adapter call without
// importing `@sooth/sdk-solana` from every leaf component.
export { useDemo, useAdapter } from "../DemoContext";
export { demoConfig } from "../config";
