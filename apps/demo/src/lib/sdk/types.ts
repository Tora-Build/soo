// Chain-locked stub. Upstream's lib/sdk types are EVM-only; the Solana fork
// re-exports the structural names the demo still imports from the chain-shim,
// then the call paths short-circuit at runtime.

export type {
  OutputLine,
  OutputLineType,
  OutputCallback,
  CommandResult,
} from "@/lib/chain-shim";

export { WAD, MAX_UINT256 } from "@/lib/chain-shim";
