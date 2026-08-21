// Can THIS wallet register a zkTLS adjudicator on THIS deployment?
//
// `register_zk_adjudicator` is permissioned: unless
// `ProtocolConfig.permissionless_adjudicators` is set, only
// `ProtocolConfig.authority` may call it. The Forge has to know that before it
// offers the option, because the failure otherwise lands AFTER `create_market`
// and `seed_lp` have already been signed and paid for — a half-built market
// and a confusing error.
//
// Three ways to be eligible, in the order they are checked:
//
//   1. The deployment is permissionless. Anyone may register.
//   2. The connected wallet IS the protocol authority.
//   3. Dev/test builds only: `VITE_TEST_AUTHORITY_BYTES` holds a keypair that
//      IS the protocol authority. The seed script writes it for localnet and
//      the shared devnet, so the demo genuinely holds the key and the
//      registration genuinely lands — it is signed by the authority, with the
//      creator kept as the entry's `authority` (the dispute veto). This is not
//      a bypass; it is the same permission, exercised by the key that has it.
//
// Anything else and the option renders disabled with the reason.

import { useEffect, useState } from "react";
import { Keypair, Transaction } from "@solana/web3.js";
import { useDemo } from "@/lib/chain-shim";

export type ZkGateReason =
  | "loading"
  | "ok"
  | "noConfig"
  | "readFailed"
  | "noWallet"
  | "notAuthority";

export interface ZkPolicy {
  reason: ZkGateReason;
  /** Protocol authority, base58 — shown in the "not you" explanation. */
  authority: string | null;
  permissionless: boolean;
  /** Present when eligibility comes from route 3; used as the ix signer. */
  devAuthority: Keypair | null;
}

const IDLE: ZkPolicy = {
  reason: "loading",
  authority: null,
  permissionless: false,
  devAuthority: null,
};

/** The dev authority keypair, when the build carries one. */
function readDevAuthority(): Keypair | null {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const json = env?.VITE_TEST_AUTHORITY_BYTES;
  if (!json) return null;
  try {
    const bytes = JSON.parse(json) as number[];
    if (!Array.isArray(bytes) || bytes.length !== 64) return null;
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/**
 * A `SolanaSigner` over a raw keypair.
 *
 * `adapter.submit` hands out a serialized legacy transaction whose fee payer
 * is the ix's `userPk`; signing it here keeps the authority path on exactly
 * the same submit machinery (heap frame, blockhash retry) as every other
 * write instead of hand-rolling a second sender.
 */
export function keypairSigner(kp: Keypair) {
  return {
    publicKey: kp.publicKey.toBase58(),
    async signTransaction(txBytes: Uint8Array): Promise<Uint8Array> {
      const tx = Transaction.from(Buffer.from(txBytes));
      tx.partialSign(kp);
      return tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
    },
  };
}

export function useZkAdjudicatorPolicy(): ZkPolicy {
  const demo = useDemo();
  const adapter = demo?.adapter;
  const userRef = demo?.userRef ?? null;
  const [policy, setPolicy] = useState<ZkPolicy>(IDLE);

  useEffect(() => {
    if (!adapter) return;
    let cancelled = false;
    void (async () => {
      // Retried, and a read FAILURE is reported differently from a config
      // that genuinely isn't there. A rate-limited RPC saying "this
      // deployment has no protocol config" would be a lie that sends the
      // creator looking in the wrong place.
      let cfg: { authority: string; permissionless: boolean } | null = null;
      let read = false;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          cfg = await adapter.readAdjudicatorPolicy();
          read = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      if (cancelled) return;
      if (!read) {
        setPolicy({ ...IDLE, reason: "readFailed" });
        return;
      }
      if (!cfg) {
        setPolicy({ ...IDLE, reason: "noConfig" });
        return;
      }
      const wallet = userRef ? userRef.replace(/^sol:/, "") : null;
      const dev = readDevAuthority();
      const devIsAuthority =
        dev !== null && dev.publicKey.toBase58() === cfg.authority;

      let reason: ZkGateReason;
      if (cfg.permissionless) reason = "ok";
      else if (wallet && wallet === cfg.authority) reason = "ok";
      else if (devIsAuthority) reason = "ok";
      else if (!wallet) reason = "noWallet";
      else reason = "notAuthority";

      setPolicy({
        reason,
        authority: cfg.authority,
        permissionless: cfg.permissionless,
        // Only carried when it is actually needed: a permissionless
        // deployment, or an authority wallet, signs with the wallet.
        devAuthority:
          reason === "ok" && !cfg.permissionless && wallet !== cfg.authority
            ? dev
            : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, userRef]);

  return policy;
}
