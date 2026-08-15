// The faucet, both venue tokens — because a wallet holding only one can
// only trade one venue, and every market starts on the AMM. Devnet/localnet
// only: the mint authority's key rides in env (the same one the seed wrote),
// and mints go to whoever is connected. No server, no shim: build the SPL
// instructions, one signature by the faucet authority.
import { useState } from "react";
import {
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { AMM_MINT, AMM_SYMBOL, BOOK_MINT, BOOK_SYMBOL } from "../config";
import { useAdapter } from "../hooks/useAdapter";
import { ConnectButton } from "../components/ConnectButton";

const AUTHORITY_BYTES = import.meta.env.VITE_TEST_MINT_AUTHORITY_BYTES as
  | string
  | undefined;
const DROP = 100_000n * 10n ** 6n; // 100,000 tokens, 6dp

const VENUES = [
  { key: "amm", mint: AMM_MINT, symbol: AMM_SYMBOL, role: "AMM venue — every market trades here until it graduates" },
  { key: "book", mint: BOOK_MINT, symbol: BOOK_SYMBOL, role: "Order-book venue — opens at graduation" },
] as const;

export function Faucet() {
  const { connection, userRef } = useAdapter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const qc = useQueryClient();

  const authority = AUTHORITY_BYTES
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(AUTHORITY_BYTES)))
    : null;
  const user = userRef ? new PublicKey(userRef.replace(/^sol:/, "")) : null;

  const balances = useQuery({
    queryKey: ["pulse-faucet-balances", userRef],
    enabled: !!user,
    refetchInterval: 8_000,
    queryFn: async () => {
      const out: Record<string, bigint> = {};
      for (const v of VENUES) {
        try {
          const ata = getAssociatedTokenAddressSync(v.mint, user!);
          const info = await connection.getAccountInfo(ata);
          out[v.key] = info ? info.data.readBigUInt64LE(64) : 0n;
        } catch {
          out[v.key] = 0n;
        }
      }
      return out;
    },
  });

  const drip = async (venue: (typeof VENUES)[number]) => {
    if (!authority || !user) return;
    setBusy(venue.key);
    setMsg(null);
    try {
      const ata = getAssociatedTokenAddressSync(venue.mint, user);
      const tx = new Transaction()
        .add(
          createAssociatedTokenAccountIdempotentInstruction(
            authority.publicKey, ata, user, venue.mint,
          ),
        )
        .add(
          createMintToInstruction(venue.mint, ata, authority.publicKey, DROP),
        );
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = authority.publicKey;
      tx.sign(authority);
      const sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      setMsg(`100,000 ${venue.symbol} received`);
      void qc.invalidateQueries({ queryKey: ["pulse-faucet-balances"] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message.slice(0, 140) : "Mint failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="mb-4 font-mono text-sm font-semibold uppercase tracking-widest text-dim">
        faucet · test tokens
      </h1>
      {!authority && (
        <p className="mb-4 rounded border border-warn/40 bg-panel p-3 font-mono text-[11px] text-warn">
          No faucet authority configured (VITE_TEST_MINT_AUTHORITY_BYTES) — this
          cluster's faucet is unavailable here.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {VENUES.map((v) => (
          <div key={v.key} className="rounded-md border border-line bg-panel p-4">
            <div className="font-mono text-xs font-bold text-ink">{v.symbol}</div>
            <p className="mt-1 min-h-[2.2rem] text-[11px] leading-snug text-dim">{v.role}</p>
            <div className="mt-2 font-mono text-[11px] text-faint">
              balance{" "}
              <span className="text-ink">
                {((Number(balances.data?.[v.key] ?? 0n)) / 1e6).toLocaleString()}
              </span>
            </div>
            {userRef ? (
              <button
                onClick={() => void drip(v)}
                disabled={!authority || busy !== null}
                className="mt-3 w-full rounded bg-inset py-2.5 font-mono text-xs text-ink ring-1 ring-line hover:ring-accent disabled:opacity-40"
              >
                {busy === v.key ? "Minting…" : `Get 100,000 ${v.symbol}`}
              </button>
            ) : (
              <div className="mt-3">
                <ConnectButton full />
              </div>
            )}
          </div>
        ))}
      </div>
      {msg && <p className="mt-3 font-mono text-[11px] text-dim">{msg}</p>}
    </div>
  );
}
