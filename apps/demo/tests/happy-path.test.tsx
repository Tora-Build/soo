// React-app-level happy-path smoke. Mounts <App> with a DemoProvider
// override that injects a bankrun-backed adapter + a programmatic signer
// derived from the test user's Keypair.
//
// Flow:
//   1. boot bankrun with both programs + a market initialized via the real
//      Anchor instructions (bootDemo).
//   2. mount <App> at /m/<marketPda> with DemoProvider override.
//   3. wait for market snapshot to render.
//   4. fill the share input, click "Get quote", click "Submit trade".
//   5. wait for `data-testid="buy-status"` to show success text.
//   6. assert position-display reflects the new yesShares (10·WAD).
//
// This is the equivalent of the SDK's smoke test but at the React-app
// boundary — proves that buildTrade/submit work through the same component
// surface a real wallet would drive.

import { describe, expect, it } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import {
  SolanaChainAdapter,
  WAD,
  encodePubkeyRef,
  type SignerRef,
} from "@sooth/sdk-solana";

import { App } from "../src/App";
import { DemoProvider } from "../src/lib/DemoContext";

import { bootDemo } from "./fixtures/bootDemo";

describe("demo happy path", () => {
  it("buy YES end-to-end through the React UI", async () => {
    const t0 = Date.now();
    const boot = await bootDemo({
      bWad: 1_000n * WAD,
      userUsdcBaseUnits: 100_000_000n,
    });
    const tBoot = Date.now() - t0;

    const adapter = new SolanaChainAdapter({
      node: {
        id: "demo-test",
        chainKind: "solana",
        chainId: "solana:bankrun",
        rpcUrl: "http://127.0.0.1:8899",
      },
      programIds: boot.programs,
      usdcMint: boot.usdcMint,
      connection: boot.connection,
    });

    const userRef = encodePubkeyRef(boot.user.publicKey);
    const marketRef = encodePubkeyRef(boot.marketPda);

    // Wrap the test user's Keypair in the SignerRef shape — same pattern as
    // packages/sdk-solana/tests/smoke.test.ts.
    const signer: SignerRef = {
      publicKey: boot.user.publicKey.toBase58(),
      signTransaction: async (raw: Uint8Array): Promise<Uint8Array> => {
        const tx = Transaction.from(raw);
        tx.partialSign(boot.user);
        return tx.serialize({
          verifySignatures: false,
          requireAllSignatures: false,
        });
      },
    };

    // Render the app at the buy-flow route.
    const initialPath = `/m/${boot.marketPda.toBase58()}`;
    render(
      <DemoProvider override={{ adapter, userRef, signer, marketRef }}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </DemoProvider>,
    );

    // Wait for market snapshot to land.
    await waitFor(
      () => {
        expect(screen.getByTestId("market-heading")).toBeTruthy();
        // Pre-trade qYes is 0.0000.
        const qyes = screen.getByTestId("market-qyes");
        expect(qyes.textContent).toContain("0.0000");
      },
      { timeout: 5_000 },
    );

    // Pre-trade position is 0.
    const yesPre = screen.getByTestId("yes-shares").textContent;
    expect(yesPre).toContain("0.0000");

    // Drive the buy form. shareInput defaults to "10" — leave as-is.
    const user = userEvent.setup();

    await user.click(screen.getByTestId("quote-button"));
    await waitFor(() => {
      expect(screen.getByTestId("quote-display")).toBeTruthy();
    });

    await user.click(screen.getByTestId("submit-button"));

    // Wait for the success status (buy-status with txid).
    await waitFor(
      () => {
        const status = screen.getByTestId("buy-status");
        expect(status.textContent).toMatch(/^Tx: sol:/);
      },
      { timeout: 10_000 },
    );

    // After onSubmitted refetches, position should reflect 10 WAD shares.
    await waitFor(
      () => {
        const yesPost = screen.getByTestId("yes-shares").textContent;
        // formatWad pads/truncates to 4 decimals, so 10·WAD renders as
        // "10.0000".
        expect(yesPost).toContain("10.0000");
      },
      { timeout: 10_000 },
    );

    // qYes should also reflect the trade.
    await waitFor(() => {
      const qy = screen.getByTestId("market-qyes").textContent;
      expect(qy).toContain("10.0000");
    });

    const tTotal = Date.now() - t0;
    // Useful-on-failure log; vitest swallows on success.
    // eslint-disable-next-line no-console
    console.log(`demo smoke: boot=${tBoot}ms total=${tTotal}ms`);

    // Avoid unused-var warnings on the act import; act is used implicitly
    // by RTL's wait helpers but having the symbol available is useful when
    // debugging flaky reruns.
    void act;
  }, 90_000);
});
