import deploymentsJson from "../config/deployments.json";

/**
 * The single sooth-core version the demo app is built against.
 * Bumped in lockstep with `apps/demo/src/config/deployments.json`.
 *
 * Mirrors the CLI's `SUPPORTED_CORE_VERSION` pattern in
 * `packages/sdk/src/cli/config.ts` — exact-match, no ranges. If a node
 * with a different coreVersion ever leaks into the demo's bundled
 * deployments, fail loudly at module load instead of producing cryptic
 * ABI mismatches at runtime.
 */
export const SUPPORTED_CORE_VERSION = "0.2.1";

interface NetworkEntry {
  chainId: number;
  coreVersion?: string;
}

/**
 * Throws if any network entry in deployments.json declares a coreVersion
 * other than SUPPORTED_CORE_VERSION. Called once at app startup.
 */
export function assertSupportedCoreVersion(): void {
  const networks = deploymentsJson.networks as Record<string, NetworkEntry>;
  const offenders: Array<{ key: string; coreVersion: string }> = [];
  for (const [key, network] of Object.entries(networks)) {
    if (!network.coreVersion) continue; // tolerate missing field for legacy entries
    if (network.coreVersion !== SUPPORTED_CORE_VERSION) {
      offenders.push({ key, coreVersion: network.coreVersion });
    }
  }
  if (offenders.length > 0) {
    const detail = offenders
      .map((o) => `  - ${o.key}: coreVersion=${o.coreVersion}`)
      .join("\n");
    throw new Error(
      `[demo] deployments.json contains networks with unsupported coreVersion (expected ${SUPPORTED_CORE_VERSION}):\n${detail}`,
    );
  }
}
