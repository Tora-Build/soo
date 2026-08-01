export const CHAIN_CONFIGS = {
  mainnet: {
    id: 900,
    chainName: "solanaMainnet",
    rpcUrl: "https://api.mainnet-beta.solana.com",
  },
  devnet: {
    id: 901,
    chainName: "solanaDevnet",
    rpcUrl: "https://api.devnet.solana.com",
  },
  localnet: {
    id: 902,
    chainName: "solanaLocalnet",
    rpcUrl: "http://127.0.0.1:8899",
  },
} as const;

export type SoothDataChain = keyof typeof CHAIN_CONFIGS;

const CHAIN_ALIASES: Record<string, SoothDataChain> = {
  mainnet: "mainnet",
  solanaMainnet: "mainnet",
  "900": "mainnet",
  devnet: "devnet",
  solanaDevnet: "devnet",
  "901": "devnet",
  localnet: "localnet",
  solanaLocalnet: "localnet",
  "902": "localnet",
};

function resolveSoothDataChain(value: string | undefined): SoothDataChain {
  if (!value) return "localnet";
  const chain = CHAIN_ALIASES[value];
  if (!chain) {
    throw new Error(
      `unsupported SOOTH_DATA_CHAIN ${value}; expected mainnet, devnet, or localnet`,
    );
  }
  return chain;
}

export const SOOTH_DATA_CHAIN = resolveSoothDataChain(
  process.env.SOOTH_DATA_CHAIN,
);

export const ACTIVE_CHAIN = CHAIN_CONFIGS[SOOTH_DATA_CHAIN];

export const DEFAULT_RPC_URL = ACTIVE_CHAIN.rpcUrl;

export const RPC_URL = process.env.RPC_URL || DEFAULT_RPC_URL;

export const PORT = Number(process.env.PORT || 42069);

export const CHAIN_NAMES = {
  900: "solanaMainnet",
  901: "solanaDevnet",
  902: "solanaLocalnet",
} as const;

export type ChainId = keyof typeof CHAIN_NAMES;

/// Program ids. The 5→1 merge replaced sooth_book/market/amm/launchpad/
/// adjudicator with a single `sooth_core`. `sooth_log` is gone too — events
/// self-CPI via Anchor's `emit_cpi!`, so no second program is needed.
export const PROGRAM_IDS = {
  SOOTH_CORE: "BgcooFgTuDQdoQkjLrZNRM6zM4Bu9bnAEenqdKjjR25W",
} as const;

/// Anchor discriminator for `sooth_core::buy` — sha256("global:buy")[..8].
/// Load-bearing for authenticity: an OrdersFilled record is only trustworthy
/// if its PARENT top-level instruction is this. See decode-ordersfilled.ts.
export const BUY_DISCRIMINATOR = Uint8Array.from([
  0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea,
]);
